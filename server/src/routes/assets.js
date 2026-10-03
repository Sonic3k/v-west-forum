import { Router } from 'express';
import { qRaw } from '../db.js';
import { getAssets } from '../assets.js';
import { toInt } from '../text.js';

export const assetsRouter = Router();
export const avatarsRouter = Router();
export const smiliesRouter = Router();

const IMAGE_TYPES = {
  gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg',
  png: 'image/png', bmp: 'image/bmp', webp: 'image/webp', ico: 'image/x-icon', svg: 'image/svg+xml',
};

function send(res, data, type) {
  res.set({
    'Content-Type': type,
    'Content-Length': String(data.length),
    'Cache-Control': 'private, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

// Ảnh đã nhập từ bộ source (avatar, smilie, ảnh hồ sơ).
assetsRouter.get('/:id', async (req, res) => {
  const rows = await qRaw('SELECT mime, data FROM panel_asset WHERE id = ?', [toInt(req.params.id)]).catch(() => []);
  const row = rows[0];
  if (!row || !row.data?.length) {
    res.status(404).send('Không tìm thấy ảnh.');
    return;
  }
  const type = row.mime ? row.mime.toString('utf8') : 'application/octet-stream';
  send(res, row.data, type.startsWith('image/') ? type : 'application/octet-stream');
});

// Avatar còn lưu trong bảng customavatar của vBulletin.
avatarsRouter.get('/:userid', async (req, res) => {
  const rows = await qRaw('SELECT filename, filedata FROM customavatar WHERE userid = ?', [toInt(req.params.userid)]);
  const row = rows[0];
  if (!row || !row.filedata?.length) {
    res.status(404).send('Không có avatar.');
    return;
  }
  const ext = (row.filename ? row.filename.toString('utf8') : '').split('.').pop().toLowerCase();
  send(res, row.filedata, IMAGE_TYPES[ext] || 'image/gif');
});

smiliesRouter.get('/', async (req, res) => {
  const assets = await getAssets();
  res.json({ smilies: assets.smilies, assets: assets.count });
});
