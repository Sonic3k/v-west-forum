import { q } from './db.js';
import { decodeEntities } from './text.js';

// Ảnh lấy từ bộ source (avatar, smilie, ảnh hồ sơ) được nhập vào bảng panel_asset bằng
// server/tools/import-assets.js. Ngoài ra vBulletin có thể còn avatar trong bảng customavatar.
// Đọc lại mỗi 5 phút để thấy ảnh mới nhập mà không cần khởi động lại.
const TTL = 5 * 60 * 1000;
let cache = null;
let loadedAt = 0;
let loading = null;

export function getAssets() {
  if (cache && Date.now() - loadedAt < TTL) return Promise.resolve(cache);
  if (!loading) {
    loading = build()
      .then((value) => {
        cache = value;
        loadedAt = Date.now();
        return value;
      })
      .catch((err) => {
        console.error('Không đọc được danh sách ảnh:', err.message);
        loadedAt = Date.now();
        cache = cache || emptyAssets();
        return cache;
      })
      .finally(() => {
        loading = null;
      });
  }
  return cache ? Promise.resolve(cache) : loading;
}

function emptyAssets() {
  return { fileAvatars: new Map(), profilePics: new Map(), dbAvatars: new Set(), predefined: new Map(), smilies: [], count: 0 };
}

export function normPath(p) {
  return String(p || '').trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').toLowerCase();
}

async function build() {
  const [assetRows, dbAvatarRows, predefinedRows, smilieRows] = await Promise.all([
    q('SELECT id, kind, path, userid, revision FROM panel_asset').catch(() => []),
    q('SELECT userid FROM customavatar WHERE LENGTH(filedata) > 0').catch(() => []),
    q('SELECT avatarid, avatarpath FROM avatar').catch(() => []),
    q('SELECT smilietext, smiliepath FROM smilie').catch(() => []),
  ]);

  const result = emptyAssets();
  result.count = assetRows.length;
  const imagesByPath = new Map();
  const imagesByName = new Map();

  for (const a of assetRows) {
    if (a.kind === 'avatar' || a.kind === 'profilepic') {
      const target = a.kind === 'avatar' ? result.fileAvatars : result.profilePics;
      const current = target.get(a.userid);
      if (a.userid && (!current || a.revision > current.revision)) target.set(a.userid, { id: a.id, revision: a.revision });
      continue;
    }
    const p = normPath(a.path);
    imagesByPath.set(p, a.id);
    const name = p.split('/').pop();
    if (!imagesByName.has(name)) imagesByName.set(name, a.id);
  }

  const findImage = (raw) => {
    let s = decodeEntities(String(raw || '').trim());
    if (!s) return null;
    if (/^https?:\/\//i.test(s)) {
      try {
        s = new URL(s).pathname;
      } catch {
        return null;
      }
    }
    const p = normPath(s);
    if (imagesByPath.has(p)) return imagesByPath.get(p);
    for (const [key, id] of imagesByPath) {
      if (p.endsWith(`/${key}`) || key.endsWith(`/${p}`)) return id;
    }
    return imagesByName.get(p.split('/').pop()) ?? null;
  };

  for (const r of dbAvatarRows) result.dbAvatars.add(r.userid);
  for (const r of predefinedRows) {
    const id = findImage(r.avatarpath);
    if (id) result.predefined.set(r.avatarid, `/api/assets/${id}`);
  }
  result.smilies = smilieRows
    .map((s) => ({ text: decodeEntities(s.smilietext || '').trim(), id: findImage(s.smiliepath) }))
    .filter((s) => s.text && s.id)
    .map((s) => ({ text: s.text, url: `/api/assets/${s.id}` }))
    .sort((a, b) => b.text.length - a.text.length);

  return result;
}

export function avatarUrl(assets, userId, avatarId) {
  if (!assets || !userId) return null;
  const file = assets.fileAvatars.get(userId);
  if (file) return `/api/assets/${file.id}`;
  if (assets.dbAvatars.has(userId)) return `/api/avatars/${userId}`;
  if (avatarId > 0) return assets.predefined.get(avatarId) || null;
  return null;
}

export function profilePicUrl(assets, userId) {
  const pic = assets?.profilePics.get(userId);
  return pic ? `/api/assets/${pic.id}` : null;
}
