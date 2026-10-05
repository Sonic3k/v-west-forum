import crypto from 'node:crypto';
import https from 'node:https';
import http from 'node:http';
import { Router } from 'express';
import { q, qRaw } from '../db.js';

// Rescued copies of externally hosted images (published by tools/publish-images.js).
// GET /api/external?u=<original link exactly as written in the post>
//   stored on B2  -> redirect to the CDN address (or stream it with &proxy=1, used by the HTML export)
//   stored in MySQL -> the image bytes
//   unknown       -> 404, and the page falls back to the original link
export const externalRouter = Router();

const TTL = 5 * 60 * 1000;
let known = null; // Map(url_hash -> public_url or null)
let loadedAt = 0;
let loading = null;

function knownLinks() {
  if (known && Date.now() - loadedAt < TTL) return Promise.resolve(known);
  if (!loading) {
    loading = q('SELECT url_hash, public_url FROM panel_external_image')
      .catch(() => q('SELECT url_hash, NULL AS public_url FROM panel_external_image'))
      .then((rows) => {
        known = new Map(rows.map((r) => [r.url_hash, r.public_url || null]));
        return known;
      })
      .catch(() => {
        known = known || new Map();
        return known;
      })
      .finally(() => {
        loadedAt = Date.now();
        loading = null;
      });
  }
  return known ? Promise.resolve(known) : loading;
}

function streamFrom(url, res, redirects = 0) {
  const lib = url.startsWith('https:') ? https : http;
  lib.get(url, { timeout: 20000 }, (up) => {
    if ([301, 302, 307, 308].includes(up.statusCode) && up.headers.location && redirects < 3) {
      up.resume();
      streamFrom(new URL(up.headers.location, url).href, res, redirects + 1);
      return;
    }
    if (up.statusCode !== 200) {
      up.resume();
      res.status(502).end();
      return;
    }
    res.set({
      'Content-Type': up.headers['content-type'] || 'application/octet-stream',
      'Cache-Control': 'private, max-age=604800',
    });
    up.pipe(res);
  }).on('error', () => {
    if (!res.headersSent) res.status(502).end();
  });
}

externalRouter.get('/stats', async (req, res) => {
  const rows = await q(
    `SELECT provider, quality, origin, IF(storage_key IS NULL, 'mysql', 'b2') AS stored, COUNT(*) AS links
       FROM panel_external_image GROUP BY provider, quality, origin, stored ORDER BY links DESC`,
  ).catch(() => []);
  res.json({ rows });
});

externalRouter.get('/', async (req, res) => {
  const url = typeof req.query.u === 'string' ? req.query.u : '';
  const hash = crypto.createHash('sha1').update(url, 'utf8').digest('hex');
  const links = await knownLinks();
  if (!url || !links.has(hash)) {
    res.set('Cache-Control', 'private, max-age=600').status(404).end();
    return;
  }
  const publicUrl = links.get(hash);
  if (publicUrl) {
    if (req.query.proxy === '1') {
      streamFrom(publicUrl, res);
      return;
    }
    res.set('Cache-Control', 'private, max-age=86400').redirect(302, publicUrl);
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
