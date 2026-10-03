// Nhập ảnh từ bộ source vBulletin (đã giải nén) vào bảng panel_asset:
//   avatar riêng (customavatars), ảnh hồ sơ (customprofilepics), ảnh chữ ký (signaturepics),
//   smilie và avatar có sẵn: lấy đúng các file mà database đang trỏ tới (bảng smilie, avatar),
//   cộng thêm mọi ảnh trong images/smilies và images/avatars.
//
// Cách chạy (PowerShell, trong thư mục server, cần bật TCP Proxy của MySQL):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/import-assets.js "E:\FC Westlife\4rum VW"
//
// Chạy lại nhiều lần không sao: file trùng đường dẫn sẽ được ghi đè.
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

// Thư mục gốc của forum: nơi có customavatars hoặc images/smilies.
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

// Đường dẫn trong database (vd "images/onion/a.gif", "/forum/images/onion/a.gif") → file trên máy.
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

  // Smilie và avatar có sẵn mà database đang dùng (gồm cả images/rabbit, images/onion...).
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
    console.log('Cách dùng: đặt $env:DATABASE_URL rồi chạy  node tools/import-assets.js "<thư mục source forum>"');
    process.exit(1);
  }
  const root = await findForumRoot(path.resolve(source));
  if (!root) {
    console.log('Không tìm thấy thư mục customavatars hay images/smilies. Bạn đã giải nén source forum chưa?');
    process.exit(1);
  }
  console.log(`Thư mục forum: ${root}`);

  const db = await mysql.createConnection({ uri, charset: 'utf8mb4' });
  const { items, missing } = await collect(root, db);
  const count = (k) => items.filter((i) => i.kind === k).length;
  console.log(
    `Tìm thấy: ${count('avatar')} avatar, ${count('profilepic')} ảnh hồ sơ, ${count('sigpic')} ảnh chữ ký, `
    + `${count('smilie')} smilie, ${count('predefined')} avatar có sẵn.`,
  );
  if (missing.smilie || missing.predefined) {
    console.log(`Database còn trỏ tới ${missing.smilie} smilie và ${missing.predefined} avatar có sẵn mà không thấy file (sẽ hiện dạng chữ).`);
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
    process.stdout.write(`\rĐã nhập ${done}/${items.length}`);
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
  console.log('\nXong. Panel sẽ tự thấy ảnh mới trong vòng 5 phút (hoặc bấm Restart service trên Railway).');
}

main().catch((err) => {
  console.error('\nLỗi:', err.message);
  process.exit(1);
});
