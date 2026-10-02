import { Router } from 'express';
import { qRaw } from '../db.js';
import { toInt } from '../text.js';

export const attachmentsRouter = Router();

const TYPES = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  bmp: 'image/bmp', webp: 'image/webp', pdf: 'application/pdf', txt: 'text/plain; charset=utf-8',
  zip: 'application/zip', rar: 'application/vnd.rar', mp3: 'audio/mpeg', doc: 'application/msword',
};

// File đính kèm nằm trong bảng filedata (attachfile = 0). ?thumb=1 lấy ảnh thu nhỏ.
attachmentsRouter.get('/:id', async (req, res) => {
  const id = toInt(req.params.id);
  const thumb = req.query.thumb === '1';
  const rows = await qRaw(
    `SELECT a.filename, fd.extension, ${thumb ? 'fd.thumbnail' : 'fd.filedata'} AS data
       FROM attachment a
       JOIN filedata fd ON fd.filedataid = a.filedataid
      WHERE a.attachmentid = ?`,
    [id],
  );
  const row = rows[0];
  if (!row || !row.data || row.data.length === 0) {
    if (thumb && row) {
      res.redirect(302, `/api/attachments/${id}`);
      return;
    }
    res.status(404).send('Không tìm thấy file đính kèm.');
    return;
  }

  const ext = row.extension ? row.extension.toString('utf8').toLowerCase() : '';
  const filename = row.filename ? row.filename.toString('utf8') : `attachment-${id}.${ext}`;
  const type = TYPES[ext] || 'application/octet-stream';
  const disposition = type.startsWith('image/') ? 'inline' : 'attachment';

  res.set({
    'Content-Type': type,
    'Content-Length': String(row.data.length),
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(row.data);
});
