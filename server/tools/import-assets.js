// Import images from the extracted vBulletin source folder into the panel_asset table:
//   custom avatars (customavatars), profile pictures (customprofilepics), signature pictures (signaturepics),
//   smilies and stock avatars: exactly the files the database points to (smilie, avatar tables),
//   plus every image in images/smilies and images/avatars.
//
// Usage (PowerShell, inside the server folder; needs the MySQL TCP proxy):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/import-assets.js "E:\FC Westlife\4rum VW\forum\forum"
//
// Safe to run again: files with the same path are overwritten.
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIME = {
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  png: 'image/png', bmp: 'image/bmp', webp: 'image/webp',
};
const BATCH_BYTES = 4 * 1024 * 1024;
const USER_PICS = [
  ['customavatars', 'avatar', /^avatar(\d+)_(\d+)\.\w+$/i],
  ['customprofilepics', 'profilepic', /^profilepic(\d+)_(\d+)\.\w+$/i],
  ['signaturepics', 'sigpic', /^sigpic(\d+)_(\d+)\.\w+$/i],
];

const mimeOf = (file) => MIME[path.extname(file).slice(1).toLowerCase()];

async function exists(p) {
  try {
    return (await fs.stat(p)).isFile();
  } catch {
    return false;
  }
}

async function childDir(parent, name) {
  try {
    const entries = await fs.readdir(parent, { withFileTypes: true });
    const hit = entries.find((e) => e.isDirectory() && e.name.toLowerCase() === name);
    return hit ? path.join(parent, hit.name) : null;
  } catch {
    return null;
  }
}

// Forum root = the folder that contains customavatars or images/smilies.
async function findForumRoot(start, depth = 0) {
  if (depth > 6) return null;
  const avatars = await childDir(start, 'customavatars');
  const images = await childDir(start, 'images');
  if (avatars || (images && (await childDir(images, 'smilies')))) return start;
  let entries = [];
  try {
    entries = await fs.readdir(start, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const found = await findForumRoot(path.join(start, e.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function listImages(dir, recursive) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) out.push(...(await listImages(full, true)));
    } else if (mimeOf(e.name)) {
      out.push(full);
    }
  }
  return out;
}

const relPath = (root, file) => path.relative(root, file).split(path.sep).join('/').toLowerCase();

// A path stored in the database ("images/onion/a.gif", "/forum/images/onion/a.gif") -> local file.
async function resolveRef(root, ref) {
  let p = String(ref || '').trim();
  if (!p) return null;
  if (/^https?:\/\//i.test(p)) {
    try {
      p = new URL(p).pathname;
    } catch {
      return null;
    }
  }
  p = decodeURIComponent(p).replace(/\\/g, '/').replace(/^\/+/, '');
  const candidates = [p];
  const i = p.toLowerCase().indexOf('images/');
  if (i > 0) candidates.push(p.slice(i));
  for (const c of candidates) {
    const full = path.join(root, ...c.split('/'));
    if (mimeOf(full) && (await exists(full))) return full;
  }
  return null;
}

async function collect(root, db) {
  const items = new Map();
  const add = (kind, file, extra = {}) => {
    const rel = relPath(root, file);
    if (!items.has(rel)) items.set(rel, { kind, file, path: rel, ...extra });
  };

  for (const [dirName, kind, pattern] of USER_PICS) {
    const dir = await childDir(root, dirName);
    if (!dir) continue;
    for (const file of await listImages(dir, false)) {
      const m = pattern.exec(path.basename(file));
      if (m) add(kind, file, { userid: Number(m[1]), revision: Number(m[2]) });
    }
  }

  // Smilies and stock avatars the database uses (including images/rabbit, images/onion, ...).
  const missing = { smilie: 0, predefined: 0 };
  const [smilies] = await db.query('SELECT smiliepath AS p FROM smilie');
  const [avatars] = await db.query('SELECT avatarpath AS p FROM avatar').catch(() => [[]]);
  for (const [rows, kind] of [[smilies, 'smilie'], [avatars, 'predefined']]) {
    for (const r of rows) {
      const file = await resolveRef(root, r.p);
      if (file) add(kind, file);
      else missing[kind] += 1;
    }
  }

  const images = await childDir(root, 'images');
  if (images) {
    const smilieDir = await childDir(images, 'smilies');
    if (smilieDir) for (const file of await listImages(smilieDir, true)) add('smilie', file);
    const avatarDir = await childDir(images, 'avatars');
    if (avatarDir) for (const file of await listImages(avatarDir, true)) add('predefined', file);
  }
  return { items: [...items.values()], missing };
}

async function main() {
  const source = process.argv[2];
  const uri = process.env.DATABASE_URL;
  if (!source || !uri) {
    console.log('Usage: set $env:DATABASE_URL, then run  node tools/import-assets.js "<forum source folder>"');
    process.exit(1);
  }
  const root = await findForumRoot(path.resolve(source));
  if (!root) {
    console.log('No customavatars or images/smilies folder found. Has the forum source been extracted?');
    process.exit(1);
  }
  console.log(`Forum folder: ${root}`);

  const db = await mysql.createConnection({ uri, charset: 'utf8mb4' });
  const { items, missing } = await collect(root, db);
  const count = (k) => items.filter((i) => i.kind === k).length;
  console.log(
    `Found: ${count('avatar')} avatars, ${count('profilepic')} profile pictures, ${count('sigpic')} signature pictures, `
    + `${count('smilie')} smilies, ${count('predefined')} stock avatars.`,
  );
  if (missing.smilie || missing.predefined) {
    console.log(`The database points to ${missing.smilie} smilies and ${missing.predefined} stock avatars without a file (they will show as text).`);
  }
  if (!items.length) {
    await db.end();
    return;
  }

  await db.query(`CREATE TABLE IF NOT EXISTS panel_asset (
                    id INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
                    kind VARCHAR(16) NOT NULL,
                    path VARCHAR(255) NOT NULL,
                    userid INT UNSIGNED NULL,
                    revision INT UNSIGNED NULL,
                    mime VARCHAR(64) NOT NULL,
                    data MEDIUMBLOB NOT NULL,
                    UNIQUE KEY path (path),
                    KEY kind_user (kind, userid)
                  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  let batch = [];
  let bytes = 0;
  let done = 0;
  const flush = async () => {
    if (!batch.length) return;
    await db.query('REPLACE INTO panel_asset (kind, path, userid, revision, mime, data) VALUES ?', [batch]);
    done += batch.length;
    process.stdout.write(`\rImported ${done}/${items.length}`);
    batch = [];
    bytes = 0;
  };
  for (const item of items) {
    const data = await fs.readFile(item.file);
    if (!data.length) continue;
    batch.push([item.kind, item.path, item.userid ?? null, item.revision ?? null, mimeOf(item.file), data]);
    bytes += data.length;
    if (bytes >= BATCH_BYTES || batch.length >= 500) await flush();
  }
  await flush();
  await db.end();
  console.log('\nDone. The panel picks up new images within 5 minutes (or restart the service on Railway).');
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
