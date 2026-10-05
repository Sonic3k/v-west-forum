import crypto from 'node:crypto';
import { Router } from 'express';
import { q, qRaw } from '../db.js';

// Rescued copies of externally hosted images (published by tools/publish-images.js).
// GET /api/external?u=<original link exactly as written in the post> -> the saved image, or 404.
export const externalRouter = Router();

const TTL = 5 * 60 * 1000;
let known = null;
let loadedAt = 0;
let loading = null;

// The set of rescued links is kept in memory so unknown links answer 404 without touching the database.
function knownHashes() {
  if (known && Date.now() - loadedAt < TTL) return Promise.resolve(known);
  if (!loading) {
    loading = q('SELECT url_hash FROM panel_external_image')
      .then((rows) => {
        known = new Set(rows.map((r) => r.url_hash));
        return known;
      })
      .catch(() => {
        known = known || new Set();
        return known;
      })
      .finally(() => {
        loadedAt = Date.now();
        loading = null;
      });
  }
  return known ? Promise.resolve(known) : loading;
}

externalRouter.get('/stats', async (req, res) => {
  const rows = await q(
    `SELECT provider, quality, origin, COUNT(*) AS links
       FROM panel_external_image GROUP BY provider, quality, origin ORDER BY links DESC`,
  ).catch(() => []);
  res.json({ rows });
});

externalRouter.get('/', async (req, res) => {
  const url = typeof req.query.u === 'string' ? req.query.u : '';
  const hash = crypto.createHash('sha1').update(url, 'utf8').digest('hex');
  const set = await knownHashes();
  if (!url || !set.has(hash)) {
    res.set('Cache-Control', 'private, max-age=600').status(404).end();
    return;
  }
  const rows = await qRaw(
    `SELECT b.mime, b.data
       FROM panel_external_image i
       JOIN panel_external_blob b ON b.sha256 = i.sha256
      WHERE i.url_hash = ?`,
    [hash],
  );
  const row = rows[0];
  if (!row || !row.data?.length) {
    res.status(404).end();
    return;
  }
  res.set({
    'Content-Type': row.mime.toString('utf8'),
    'Content-Length': String(row.data.length),
    'Cache-Control': 'private, max-age=604800',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(row.data);
});
