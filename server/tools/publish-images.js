// Publish images saved by tools/rescue-images.js so the panel can show them instead of dead links.
//
// Target "b2" (recommended): files go to Backblaze B2 (S3 API) under <B2_PREFIX>/external/<provider>/<host>/<path>,
// served through the CDN; MySQL only keeps the link -> file mapping.
// Target "mysql": the image bytes are stored in MySQL (panel_external_blob).
//
// Tables (MySQL):
//   panel_external_image  one row per original link: url, provider, host, quality, origin, local file,
//                         storage_key/public_url (B2) or sha256 -> panel_external_blob (MySQL)
//   panel_external_blob   image bytes, only for the "mysql" target
//
// Usage (PowerShell, inside the server folder; needs the MySQL TCP proxy):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   $env:B2_KEY_ID = "<key id>"; $env:B2_APP_KEY = "<application key>"
//   node tools/publish-images.js --out "E:\FC Westlife\external-images" --target b2
//
// B2 settings (defaults match the sonic-hub bucket): B2_ENDPOINT (s3.us-east-005.backblazeb2.com),
// B2_REGION (us-east-005), B2_BUCKET (sonic-hub), B2_PREFIX (v-west-forum), CDN_BASE (https://sonic-hub.b-cdn.net).
//
// Safe to re-run (e.g. after a Wayback pass): unchanged files are skipped, changed ones are replaced,
// links that are no longer saved are removed (also from B2).
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { providerOf } from '../src/providers.js';

const MIME = { gif: 'image/gif', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' };
const BLOB_BATCH_BYTES = 8 * 1024 * 1024;
const ROW_BATCH = 1000;

const B2 = {
  endpoint: process.env.B2_ENDPOINT || 's3.us-east-005.backblazeb2.com',
  region: process.env.B2_REGION || 'us-east-005',
  bucket: process.env.B2_BUCKET || 'sonic-hub',
  prefix: (process.env.B2_PREFIX || 'v-west-forum').replace(/^\/+|\/+$/g, ''),
  cdn: (process.env.CDN_BASE || 'https://sonic-hub.b-cdn.net').replace(/\/+$/, ''),
  keyId: process.env.B2_KEY_ID,
  appKey: process.env.B2_APP_KEY,
  concurrency: 6,
};

function parseArgs(argv) {
  const opts = { out: null, target: 'mysql' };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i];
    else if (argv[i] === '--target') opts.target = String(argv[++i] || '').toLowerCase();
  }
  return opts;
}

async function readManifest(file) {
  const map = new Map();
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      map.set(rec.url, { ...(map.get(rec.url) || {}), ...rec });
    } catch {
      // ignore a broken line (e.g. the one being written by a running rescue)
    }
  }
  return map;
}

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function chunks(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

// local file images/<provider>/<host>/<path> -> B2 key <prefix>/external/<provider>/<host>/<path>
function storageKeyFor(localFile) {
  const rel = localFile.split(/[\\/]/).filter(Boolean);
  if (rel[0] === 'images') rel.shift();
  return `${B2.prefix}/external/${rel.join('/')}`;
}

const publicUrlFor = (key) => `${B2.cdn}/${key.split('/').map(encodeURIComponent).join('/')}`;

async function ensureTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS panel_external_blob (
                    sha256 CHAR(64) NOT NULL PRIMARY KEY,
                    mime VARCHAR(32) NOT NULL,
                    bytes INT UNSIGNED NOT NULL,
                    data MEDIUMBLOB NOT NULL
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS panel_external_image (
                    url_hash CHAR(40) NOT NULL PRIMARY KEY,
                    url TEXT NOT NULL,
                    provider VARCHAR(32) NOT NULL,
                    host VARCHAR(255) NOT NULL,
                    quality VARCHAR(16) NOT NULL,
                    origin VARCHAR(16) NOT NULL,
                    snapshot VARCHAR(14) NULL,
                    sha256 CHAR(64) NOT NULL,
                    local_file VARCHAR(500) NULL,
                    refs INT UNSIGNED NOT NULL DEFAULT 0,
                    storage_key VARCHAR(700) NULL,
                    public_url TEXT NULL,
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    KEY provider (provider),
                    KEY sha256 (sha256)
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // Tables created by the first version of this tool have no B2 columns yet.
  const [cols] = await db.query(
    `SELECT column_name AS c FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'panel_external_image'`,
  );
  const have = new Set(cols.map((r) => String(r.c).toLowerCase()));
  if (!have.has('storage_key')) await db.query('ALTER TABLE panel_external_image ADD COLUMN storage_key VARCHAR(700) NULL');
  if (!have.has('public_url')) await db.query('ALTER TABLE panel_external_image ADD COLUMN public_url TEXT NULL');
}

async function makeB2() {
  if (!B2.keyId || !B2.appKey) {
    console.log('Set $env:B2_KEY_ID and $env:B2_APP_KEY (the same key the sonic-hub service uses, or a new one for the bucket).');
    process.exit(1);
  }
  let sdk;
  try {
    sdk = await import('@aws-sdk/client-s3');
  } catch {
    console.log('Missing @aws-sdk/client-s3: run "npm install" in the server folder first.');
    process.exit(1);
  }
  const endpoint = /^https?:\/\//.test(B2.endpoint) ? B2.endpoint : `https://${B2.endpoint}`;
  const client = new sdk.S3Client({
    endpoint,
    region: B2.region,
    credentials: { accessKeyId: B2.keyId, secretAccessKey: B2.appKey },
    // B2 does not accept the extra checksum headers newer SDK versions send by default.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    forcePathStyle: process.env.B2_PATH_STYLE === '1',
  });
  return {
    put: (key, body, contentType) => client.send(new sdk.PutObjectCommand({
      Bucket: B2.bucket, Key: key, Body: body, ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    })),
    remove: (key) => client.send(new sdk.DeleteObjectCommand({ Bucket: B2.bucket, Key: key })),
  };
}

async function runPool(items, size, fn) {
  let i = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i];
      i += 1;
      await fn(item);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.DATABASE_URL;
  if (!opts.out || !uri || !['mysql', 'b2'].includes(opts.target)) {
    console.log('Usage: set $env:DATABASE_URL, then run');
    console.log('  node tools/publish-images.js --out "<rescue folder>" --target b2      (or --target mysql)');
    process.exit(1);
  }
  const out = path.resolve(opts.out);
  const urlsFile = path.join(out, 'urls.json');
  const manifestFile = path.join(out, 'manifest.jsonl');
  if (!existsSync(urlsFile) || !existsSync(manifestFile)) {
    console.log(`No urls.json / manifest.jsonl in ${out}. Run tools/rescue-images.js first.`);
    process.exit(1);
  }
  const b2 = opts.target === 'b2' ? await makeB2() : null;
  if (b2) console.log(`B2: bucket ${B2.bucket}, folder ${B2.prefix}/external/, CDN ${B2.cdn}`);

  const urls = new Map(JSON.parse(await fs.readFile(urlsFile, 'utf8')).map((u) => [u.url, u]));
  const manifest = await readManifest(manifestFile);
  const saved = [...manifest.values()].filter((r) => r.status === 'ok' && r.file && r.sha256);
  console.log(`Saved images in the manifest: ${saved.length}`);

  const db = await mysql.createConnection({ uri, charset: 'utf8mb4' });
  await ensureTables(db);
  const [current] = await db.query('SELECT url_hash, sha256, storage_key FROM panel_external_image');
  const inDb = new Map(current.map((r) => [r.url_hash, r]));

  // Build one row per saved link.
  const rows = [];
  let missingFiles = 0;
  for (const rec of saved) {
    const file = path.join(out, rec.file);
    if (!existsSync(file)) {
      missingFiles += 1;
      continue;
    }
    const info = urls.get(rec.url) || {};
    const host = info.host || new URL(rec.url).hostname.toLowerCase();
    const urlHash = sha1(rec.url);
    const key = b2 ? storageKeyFor(rec.file) : null;
    rows.push({
      urlHash, url: rec.url, provider: info.provider || providerOf(host), host,
      quality: rec.quality || 'original', origin: rec.origin || 'direct', snapshot: rec.snapshot || null,
      sha256: rec.sha256, file, localFile: rec.file.split(path.sep).join('/'), refs: info.refs || 0,
      mime: MIME[rec.ext] || 'application/octet-stream',
      storageKey: key, publicUrl: key ? publicUrlFor(key) : null,
      previousKey: inDb.get(urlHash)?.storage_key || null,
      unchanged: b2 ? (inDb.get(urlHash)?.storage_key === key && inDb.get(urlHash)?.sha256 === rec.sha256) : false,
    });
  }
  if (missingFiles) console.log(`Skipped ${missingFiles} links whose local file is missing.`);

  // Upload.
  if (b2) {
    const todo = rows.filter((r) => !r.unchanged);
    console.log(`Files to upload to B2: ${todo.length} (unchanged: ${rows.length - todo.length})`);
    let done = 0;
    let bytes = 0;
    const failed = [];
    await runPool(todo, B2.concurrency, async (r) => {
      try {
        const data = await fs.readFile(r.file);
        await b2.put(r.storageKey, data, r.mime);
        bytes += data.length;
        if (r.previousKey && r.previousKey !== r.storageKey) await b2.remove(r.previousKey).catch(() => {});
      } catch (err) {
        failed.push({ r, err });
        r.failed = true;
      }
      done += 1;
      if (done % 20 === 0 || done === todo.length) {
        process.stdout.write(`\rUploaded ${done}/${todo.length} (${(bytes / 1048576).toFixed(1)} MB)${failed.length ? `, failed ${failed.length}` : ''}   `);
      }
    });
    if (todo.length) console.log('');
    if (failed.length) {
      const first = failed[0].err;
      console.log(`${failed.length} uploads failed. First error: ${first.name || ''} ${first.message}`);
      if (/AccessDenied|Forbidden|403/i.test(`${first.name} ${first.message}`)) {
        console.log(`The B2 key may be limited to another folder. Create a key for bucket ${B2.bucket} that allows "${B2.prefix}/".`);
      }
    }
  } else {
    const [existingRows] = await db.query('SELECT sha256 FROM panel_external_blob');
    const existing = new Set(existingRows.map((r) => r.sha256));
    const pending = new Map();
    for (const r of rows) {
      if (existing.has(r.sha256) || pending.has(r.sha256)) continue;
      const data = await fs.readFile(r.file);
      r.sha256 = sha256(data);
      if (!existing.has(r.sha256) && !pending.has(r.sha256)) pending.set(r.sha256, { mime: r.mime, file: r.file });
    }
    console.log(`New image contents to upload to MySQL: ${pending.size}`);
    let batch = [];
    let batchBytes = 0;
    let uploaded = 0;
    let uploadedBytes = 0;
    const flush = async () => {
      if (!batch.length) return;
      await db.query('INSERT IGNORE INTO panel_external_blob (sha256, mime, bytes, data) VALUES ?', [batch]);
      uploaded += batch.length;
      uploadedBytes += batchBytes;
      process.stdout.write(`\rUploaded ${uploaded}/${pending.size} (${(uploadedBytes / 1048576).toFixed(1)} MB)`);
      batch = [];
      batchBytes = 0;
    };
    for (const [hash, { mime, file }] of pending) {
      const data = await fs.readFile(file);
      batch.push([hash, mime, data.length, data]);
      batchBytes += data.length;
      if (batchBytes >= BLOB_BATCH_BYTES) await flush();
    }
    await flush();
    if (pending.size) console.log('');
  }

  // One row per link (insert or update). Failed B2 uploads keep their previous row, if any.
  const publish = rows.filter((r) => !r.failed);
  for (const part of chunks(publish, ROW_BATCH)) {
    await db.query(
      `REPLACE INTO panel_external_image
         (url_hash, url, provider, host, quality, origin, snapshot, sha256, local_file, refs, storage_key, public_url)
       VALUES ?`,
      [part.map((r) => [r.urlHash, r.url, r.provider, r.host, r.quality, r.origin, r.snapshot, r.sha256,
        r.localFile, r.refs, r.storageKey, r.publicUrl])],
    );
  }

  // Remove links that are no longer saved (and their B2 files), then image bytes nobody uses.
  const keep = new Set(rows.map((r) => r.urlHash));
  const stale = current.filter((r) => !keep.has(r.url_hash));
  if (b2) for (const r of stale) if (r.storage_key) await b2.remove(r.storage_key).catch(() => {});
  for (const part of chunks(stale.map((r) => r.url_hash), ROW_BATCH)) {
    await db.query('DELETE FROM panel_external_image WHERE url_hash IN (?)', [part]);
  }
  const [orphans] = await db.query(
    `DELETE b FROM panel_external_blob b
      WHERE NOT EXISTS (SELECT 1 FROM panel_external_image i WHERE i.sha256 = b.sha256 AND i.storage_key IS NULL)`,
  );

  const [byProvider] = await db.query(
    `SELECT provider, quality, IF(storage_key IS NULL, 'mysql', 'b2') AS stored, COUNT(*) AS links
       FROM panel_external_image GROUP BY provider, quality, stored ORDER BY links DESC`,
  );
  const [[blobs]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM panel_external_blob');
  await db.end();

  console.log(`Links published: ${publish.length} (removed ${stale.length} stale; ${orphans.affectedRows || 0} image blobs removed from MySQL).`);
  if (Number(blobs.n)) console.log(`Image bytes still in MySQL: ${blobs.n} files, ${(Number(blobs.bytes) / 1048576).toFixed(1)} MB.`);
  for (const r of byProvider) console.log(`  ${String(r.provider).padEnd(13)} ${String(r.quality).padEnd(9)} ${String(r.stored).padEnd(6)} ${r.links}`);
  console.log('The panel picks up the changes within 5 minutes.');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
