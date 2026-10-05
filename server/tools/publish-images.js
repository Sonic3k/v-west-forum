// Publish images saved by tools/rescue-images.js to MySQL so the panel can show them instead of dead links.
//   panel_external_blob   one row per distinct image content (sha256) with the bytes
//   panel_external_image  one row per original link: url, provider, host, quality, origin, local file -> sha256
//
// Usage (PowerShell, inside the server folder; needs the MySQL TCP proxy):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/publish-images.js --out "E:\FC Westlife\external-images"
//
// Safe to re-run (e.g. after a Wayback pass): only new image contents are uploaded,
// changed links are updated, links that are no longer saved are removed.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';
import { providerOf } from '../src/providers.js';

const MIME = { gif: 'image/gif', jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', bmp: 'image/bmp' };
const BLOB_BATCH_BYTES = 8 * 1024 * 1024;
const ROW_BATCH = 1000;

function parseArgs(argv) {
  const opts = { out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i];
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
      // ignore broken line (e.g. the one being written by a running rescue)
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

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const uri = process.env.DATABASE_URL;
  if (!opts.out || !uri) {
    console.log('Usage: set $env:DATABASE_URL, then run  node tools/publish-images.js --out "<rescue folder>"');
    process.exit(1);
  }
  const out = path.resolve(opts.out);
  const urlsFile = path.join(out, 'urls.json');
  const manifestFile = path.join(out, 'manifest.jsonl');
  if (!existsSync(urlsFile) || !existsSync(manifestFile)) {
    console.log(`No urls.json / manifest.jsonl in ${out}. Run tools/rescue-images.js first.`);
    process.exit(1);
  }

  const urls = new Map(JSON.parse(await fs.readFile(urlsFile, 'utf8')).map((u) => [u.url, u]));
  const manifest = await readManifest(manifestFile);
  const saved = [...manifest.values()].filter((r) => r.status === 'ok' && r.file && r.sha256);
  console.log(`Saved images in the manifest: ${saved.length}`);

  const db = await mysql.createConnection({ uri, charset: 'utf8mb4' });
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
                    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    KEY provider (provider),
                    KEY sha256 (sha256)
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  // 1. Upload image contents the database does not have yet (identical images are stored once).
  const [existingRows] = await db.query('SELECT sha256 FROM panel_external_blob');
  const existing = new Set(existingRows.map((r) => r.sha256));
  const rows = [];
  const pending = new Map();
  let missingFiles = 0;
  for (const rec of saved) {
    const file = path.join(out, rec.file);
    if (!existsSync(file)) {
      missingFiles += 1;
      continue;
    }
    let hash = rec.sha256;
    if (!existing.has(hash) && !pending.has(hash)) {
      const data = await fs.readFile(file);
      hash = sha256(data);
      if (!existing.has(hash) && !pending.has(hash)) {
        pending.set(hash, { mime: MIME[rec.ext] || 'application/octet-stream', file });
      }
    }
    const info = urls.get(rec.url) || {};
    const host = info.host || new URL(rec.url).hostname.toLowerCase();
    rows.push([
      sha1(rec.url), rec.url, info.provider || providerOf(host), host,
      rec.quality || 'original', rec.origin || 'direct', rec.snapshot || null,
      hash, rec.file.split(path.sep).join('/'), info.refs || 0,
    ]);
  }
  if (missingFiles) console.log(`Skipped ${missingFiles} links whose local file is missing.`);

  console.log(`New image contents to upload: ${pending.size}`);
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

  // 2. One row per link (insert or update).
  for (const part of chunks(rows, ROW_BATCH)) {
    await db.query(
      `REPLACE INTO panel_external_image
         (url_hash, url, provider, host, quality, origin, snapshot, sha256, local_file, refs)
       VALUES ?`,
      [part],
    );
  }

  // 3. Remove links that are no longer saved, then image contents nobody points to.
  const keep = new Set(rows.map((r) => r[0]));
  const [dbLinks] = await db.query('SELECT url_hash FROM panel_external_image');
  const stale = dbLinks.map((r) => r.url_hash).filter((h) => !keep.has(h));
  for (const part of chunks(stale, ROW_BATCH)) {
    await db.query('DELETE FROM panel_external_image WHERE url_hash IN (?)', [part]);
  }
  const [orphans] = await db.query(
    `DELETE b FROM panel_external_blob b
       LEFT JOIN panel_external_image i ON i.sha256 = b.sha256
      WHERE i.url_hash IS NULL`,
  );

  const [byProvider] = await db.query(
    `SELECT i.provider, i.quality, COUNT(*) AS links
       FROM panel_external_image i GROUP BY i.provider, i.quality ORDER BY links DESC`,
  );
  const [[blobs]] = await db.query('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM panel_external_blob');
  await db.end();

  console.log(`Links published: ${rows.length} (removed ${stale.length} stale, ${orphans.affectedRows || 0} unused images).`);
  console.log(`Images in the database: ${blobs.n} distinct files, ${(Number(blobs.bytes) / 1048576).toFixed(1)} MB.`);
  for (const r of byProvider) console.log(`  ${String(r.provider).padEnd(13)} ${String(r.quality).padEnd(9)} ${r.links}`);
  console.log('The panel shows these images right away (it re-reads the list every 5 minutes).');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
