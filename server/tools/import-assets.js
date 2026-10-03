// Nhập avatar, smilie, ảnh hồ sơ từ bộ source vBulletin (đã giải nén) vào bảng panel_asset.
//
// Cách chạy (PowerShell, trong thư mục server):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/import-assets.js "E:\FC Westlife\4rum VW"
//
// Script tự tìm thư mục customavatars, customprofilepics, images/smilies, images/avatars bên trong.
// Chạy lại nhiều lần không sao: file trùng đường dẫn sẽ được ghi đè.
import fs from 'node:fs/promises';
import path from 'node:path';
import mysql from 'mysql2/promise';

const MIME = {
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  png: 'image/png', bmp: 'image/bmp', webp: 'image/webp',
};
const BATCH_BYTES = 4 * 1024 * 1024;

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
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

// Tìm thư mục gốc của forum: nơi có customavatars hoặc images/smilies.
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

async function listFiles(dir, recursive) {
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
      if (recursive) out.push(...(await listFiles(full, true)));
    } else if (MIME[path.extname(e.name).slice(1).toLowerCase()]) {
      out.push(full);
    }
  }
  return out;
}

function relPath(root, file) {
  return path.relative(root, file).split(path.sep).join('/').toLowerCase();
}

async function collect(root) {
  const items = [];
  const add = (kind, file, extra = {}) => items.push({ kind, file, path: relPath(root, file), ...extra });

  const avatarDir = await childDir(root, 'customavatars');
  if (avatarDir) {
    for (const file of await listFiles(avatarDir, false)) {
      const m = /^avatar(\d+)_(\d+)\.\w+$/i.exec(path.basename(file));
      if (m) add('avatar', file, { userid: Number(m[1]), revision: Number(m[2]) });
    }
  }
  const picDir = await childDir(root, 'customprofilepics');
  if (picDir) {
    for (const file of await listFiles(picDir, false)) {
      const m = /^profilepic(\d+)_(\d+)\.\w+$/i.exec(path.basename(file));
      if (m) add('profilepic', file, { userid: Number(m[1]), revision: Number(m[2]) });
    }
  }
  const images = await childDir(root, 'images');
  if (images) {
    const smilies = await childDir(images, 'smilies');
    if (smilies) for (const file of await listFiles(smilies, true)) add('smilie', file);
    const avatars = await childDir(images, 'avatars');
    if (avatars) for (const file of await listFiles(avatars, true)) add('predefined', file);
  }
  return items;
}

async function main() {
  const source = process.argv[2];
  const uri = process.env.DATABASE_URL;
  if (!source || !uri) {
    console.log('Cách dùng: đặt $env:DATABASE_URL rồi chạy  node tools/import-assets.js "<thư mục source forum>"');
    process.exit(1);
  }
  if (!(await isDir(source))) {
    console.log(`Không thấy thư mục: ${source}`);
    process.exit(1);
  }

  const root = await findForumRoot(path.resolve(source));
  if (!root) {
    console.log('Không tìm thấy thư mục customavatars hay images/smilies. Bạn đã giải nén source forum chưa?');
    process.exit(1);
  }
  console.log(`Thư mục forum: ${root}`);
  const items = await collect(root);
  const count = (k) => items.filter((i) => i.kind === k).length;
  console.log(`Tìm thấy: ${count('avatar')} avatar, ${count('profilepic')} ảnh hồ sơ, ${count('smilie')} smilie, ${count('predefined')} avatar có sẵn.`);
  if (!items.length) process.exit(0);

  const db = await mysql.createConnection({ uri, charset: 'utf8mb4' });
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
    const mime = MIME[path.extname(item.file).slice(1).toLowerCase()];
    batch.push([item.kind, item.path, item.userid ?? null, item.revision ?? null, mime, data]);
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
