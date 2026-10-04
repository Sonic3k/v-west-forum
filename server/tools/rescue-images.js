// Rescue externally hosted images (Photobucket, Blogspot, Flickr, ...) embedded with [IMG] in the forum.
// Reads the database only; images are saved to a local folder, grouped by provider:
//   <out>/images/<provider>/<host>/<original path>      e.g. images/photobucket/i123.photobucket.com/albums/...
//   <out>/_suspected-placeholders/                        one copy of each image that looks like a "not available" banner
//   <out>/urls.json        all image links found in the database (so later runs do not need the database)
//   <out>/manifest.jsonl   one line per processed link; used to resume and to publish later
//   <out>/index.csv        spreadsheet-friendly list: url, provider, host, status, origin, file, bytes, refs
//
// Usage (PowerShell, inside the server folder; the first run needs the MySQL TCP proxy):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/rescue-images.js --out "E:\FC Westlife\external-images" --provider photobucket --sample 50
//   node tools/rescue-images.js --out "E:\FC Westlife\external-images"
//   node tools/rescue-images.js --out "E:\FC Westlife\external-images" --wayback
//
// Options: --provider <name>   only links from this provider (photobucket, facebook, google, ...)
//          --host <text>       only links whose host contains this text
//          --sample <n>        only try n links, spread evenly over the list
//          --concurrency <n>   parallel downloads (default 4)
//          --wayback           retry dead links through the Internet Archive Wayback Machine
//          --rescan            read the link list from the database again
//          --refetch           download already saved images again and overwrite them (keeps the old file on failure)
//          --profile <name>    how to request an image (default: image):
//                                image            like an <img> tag on another site
//                                navigate         like typing the link into the browser address bar
//                                page-referer     open the link like a browser (gets Photobucket's HTML viewer page,
//                                                 with its cookies), then load the image as that page does
//                                page-html        same, but use the image addresses found inside that HTML page
//                                original-suffix  Photobucket's old "~original" address for the uploaded file
//          --probe <url>       download one link in all these ways into _probe/ to compare the results by eye
// Safe to re-run at any time: finished links are skipped, interrupted runs continue where they stopped.
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import mysql from 'mysql2/promise';
import { providerOf } from '../src/providers.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// How a request looks to the server. Photobucket serves the original only to a "navigate" request
// (a link typed into the browser); embedded-image style requests get a watermarked copy.
// Some hosts (e.g. imgur) answer a navigate request with an HTML page, so "image" stays the default elsewhere.
const PROFILES = {
  image: {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  },
  navigate: {
    'User-Agent': UA,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
};

const STRATEGIES = new Set(['image', 'navigate', 'page-referer', 'page-html', 'original-suffix']);

function profileFor(provider, override) {
  if (override && STRATEGIES.has(override)) return override;
  return 'image';
}
const TIMEOUT_MS = 30000;
const MAX_BYTES = 30 * 1024 * 1024;
const SUSPECT_MIN_URLS = 8; // identical bytes behind >= 8 different links => most likely a placeholder banner
const FINAL = new Set(['ok', 'not_found', 'suspect']);
const IMAGES_DIR = 'images';
const SUSPECT_DIR = '_suspected-placeholders';

// ---------- arguments ----------
function parseArgs(argv) {
  const opts = {
    out: null, host: null, provider: null, sample: 0, concurrency: 4,
    wayback: false, rescan: false, refetch: false, profile: null, probe: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--host') opts.host = String(argv[++i] || '').toLowerCase();
    else if (a === '--provider') opts.provider = String(argv[++i] || '').toLowerCase();
    else if (a === '--sample') opts.sample = Number(argv[++i]) || 0;
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Math.min(16, Number(argv[++i]) || 4));
    else if (a === '--wayback') opts.wayback = true;
    else if (a === '--rescan') opts.rescan = true;
    else if (a === '--refetch') opts.refetch = true;
    else if (a === '--profile') opts.profile = String(argv[++i] || '').toLowerCase();
    else if (a === '--probe') opts.probe = argv[++i];
  }
  return opts;
}

// ---------- read links from the database ----------
// The vBulletin tables are latin1 but hold UTF-8 bytes: read raw bytes and decode as UTF-8.
const TEXT_TYPES = new Set(['VAR_STRING', 'STRING', 'VARCHAR', 'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB']);
const utf8Cast = (field, next) => {
  if (TEXT_TYPES.has(field.type)) {
    const b = field.buffer();
    return b === null ? null : b.toString('utf8');
  }
  return next();
};

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, c) => {
  if (c[0] === '#') {
    const n = c[1] === 'x' || c[1] === 'X' ? parseInt(c.slice(2), 16) : parseInt(c.slice(1), 10);
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  }
  return ENTITIES[c.toLowerCase()] ?? m;
});

// [label, table, text column]
const SOURCES = [
  ['posts', 'post', 'pagetext'],
  ['signatures', 'usertextfield', 'signature'],
  ['wall messages', 'visitormessage', 'pagetext'],
  ['private messages', 'pmtext', 'message'],
  ['post comments', 'vbcomment', 'comment'],
  ['announcements', 'announcement', 'pagetext'],
];

async function scanDatabase(uri) {
  const db = await mysql.createConnection({ uri, charset: 'BINARY', typeCast: utf8Cast });
  const urls = new Map();
  const IMG = /\[img(?:=[^\]]*)?\]\s*([\s\S]*?)\s*\[\/img\]/gi;
  for (const [label, table, column] of SOURCES) {
    let rows = [];
    try {
      // BINARY connection compares case-sensitively: LOWER() catches both [IMG] and [img].
      [rows] = await db.query(`SELECT ${column} AS t FROM ${table} WHERE LOWER(${column}) LIKE '%[img%'`);
    } catch (err) {
      console.log(`  (skipped ${label}: ${err.code || err.message})`);
      continue;
    }
    let found = 0;
    for (const r of rows) {
      for (const m of String(r.t || '').matchAll(IMG)) {
        const url = decodeEntities(m[1]).trim().replace(/^["']|["']$/g, '');
        if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
        let host;
        try {
          host = new URL(url).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (/westlife/.test(host)) continue; // the old forum itself: covered by the database and imported assets
        const item = urls.get(url) || { url, host, provider: providerOf(host), refs: 0, usedIn: [] };
        item.refs += 1;
        if (!item.usedIn.includes(label)) item.usedIn.push(label);
        urls.set(url, item);
        found += 1;
      }
    }
    console.log(`  ${label}: ${rows.length} items with [IMG], ${found} links`);
  }
  await db.end();
  return [...urls.values()];
}

// ---------- download ----------
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

// Plain node:http(s) instead of fetch(): fetch() rewrites some headers (e.g. Sec-Fetch-Mode: cors),
// which would make a "navigate" request look like an embedded one.
// jar: optional Map(name -> value); cookies set by every response are stored and sent on redirects.
function fetchBytes(url, headers = PROFILES.image, redirects = 0, jar = null) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const sendHeaders = jar && jar.size ? { ...headers, Cookie: cookieHeader(jar) } : headers;
    const req = lib.request(target, { method: 'GET', headers: sendHeaders, timeout: TIMEOUT_MS }, (res) => {
      const { statusCode } = res;
      if (jar) {
        for (const line of res.headers['set-cookie'] || []) {
          const pair = line.split(';')[0];
          const eq = pair.indexOf('=');
          if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
      }
      if ([301, 302, 303, 307, 308].includes(statusCode) && res.headers.location && redirects < 6) {
        res.resume();
        resolve(fetchBytes(new URL(res.headers.location, target).href, headers, redirects + 1, jar));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) req.destroy(new Error('file too large'));
        else chunks.push(chunk);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const encoding = String(res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (encoding === 'gzip') buf = zlib.gunzipSync(buf);
          else if (encoding === 'deflate') buf = zlib.inflateSync(buf);
          else if (encoding === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch {
          // keep raw bytes
        }
        resolve({ status: statusCode, finalUrl: target.href, buf, contentType: String(res.headers['content-type'] || '') });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => {
      const err = new Error('timeout');
      err.name = 'AbortError';
      req.destroy(err);
    });
    req.on('error', reject);
    req.end();
  });
}

function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

const toHttps = (url) => url.replace(/^http:\/\//i, 'https://');

function siteRelation(from, to) {
  const a = new URL(from);
  const b = new URL(to);
  if (a.origin === b.origin) return 'same-origin';
  const root = (h) => h.split('.').slice(-2).join('.');
  return root(a.hostname) === root(b.hostname) ? 'same-site' : 'cross-site';
}

// Headers of an image that an HTML page loads itself (same-site, with the page as Referer and its cookies).
function inPageImageHeaders(pageUrl, imageUrl, jar) {
  const headers = {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
    Referer: pageUrl,
    'Sec-Fetch-Dest': 'image',
    'Sec-Fetch-Mode': 'no-cors',
    'Sec-Fetch-Site': siteRelation(pageUrl, imageUrl),
    'sec-ch-ua': PROFILES.navigate['sec-ch-ua'],
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  if (jar && jar.size) headers.Cookie = cookieHeader(jar);
  return headers;
}

// Image addresses inside an HTML page: og:image / twitter:image, <img src>, and any image URL in scripts.
// Addresses containing the original file name come first.
function extractImageUrls(html, pageUrl, originalUrl) {
  const text = html.replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
  let base = path.posix.basename(new URL(originalUrl).pathname);
  try {
    base = decodeURIComponent(base);
  } catch {
    // keep as is
  }
  base = base.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  const found = new Map();
  const add = (raw, weight) => {
    let abs;
    try {
      abs = new URL(raw, pageUrl).href;
    } catch {
      return;
    }
    let lower = abs.toLowerCase();
    try {
      lower = decodeURIComponent(lower);
    } catch {
      // keep as is
    }
    const score = weight + (base && lower.includes(base) ? 5 : 0);
    if (!found.has(abs) || found.get(abs) < score) found.set(abs, score);
  };
  for (const m of text.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*content=["']([^"']+)["']/gi)) add(m[1], 3);
  for (const m of text.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name)=["'](?:og:image|twitter:image)["']/gi)) add(m[1], 3);
  for (const m of text.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)) add(m[1], 1);
  for (const m of text.matchAll(/https?:\/\/[^"'\s<>()\\]+?\.(?:jpe?g|png|gif|webp|bmp)(?:\?[^"'\s<>()\\]*)?/gi)) add(m[0], 1);
  return [...found.entries()]
    .filter(([, score]) => score >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([u]) => u);
}

// Open the link like a browser. Returns the image directly if the server sends one,
// otherwise the HTML page (as text) with its final address and cookies.
async function openAsBrowser(url) {
  const jar = new Map();
  const r = await fetchBytes(toHttps(url), PROFILES.navigate, 0, jar);
  return { ...r, jar, ext: r.status === 200 ? sniff(r.buf) : null };
}

async function pageStrategy(url, mode) {
  let page;
  try {
    page = await openAsBrowser(url);
  } catch (err) {
    return { status: 'error', detail: err.code || err.message };
  }
  if (page.status === 404 || page.status === 410) return { status: 'not_found', finalUrl: page.finalUrl };
  if (page.ext) return { status: 'ok', ext: page.ext, buf: page.buf, finalUrl: page.finalUrl };
  if (page.status !== 200) return { status: `http_${page.status}`, finalUrl: page.finalUrl };
  const html = page.buf.toString('utf8');
  const original = toHttps(url);
  const candidates = mode === 'page-referer'
    ? [original]
    : extractImageUrls(html, page.finalUrl, original).filter((u) => u !== original);
  for (const candidate of candidates) {
    const r = await attempt(candidate, inPageImageHeaders(page.finalUrl, candidate, page.jar));
    if (r.status === 'ok') return { ...r, via: candidate };
  }
  return { status: candidates.length ? 'not_image' : 'no_image_in_page', finalUrl: page.finalUrl };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One address, retried on network errors and rate limiting.
async function attempt(target, headers) {
  let last = { status: 'error', detail: 'download failed' };
  for (let i = 0; i < 2; i += 1) {
    try {
      const r = await fetchBytes(target, headers);
      if (r.status === 429 || r.status === 503) {
        last = { status: `http_${r.status}`, detail: 'rate limited' };
        await sleep(20000);
        continue;
      }
      if (r.status === 404 || r.status === 410) return { status: 'not_found', finalUrl: r.finalUrl };
      if (r.status !== 200) return { status: `http_${r.status}`, finalUrl: r.finalUrl };
      const ext = sniff(r.buf);
      if (!ext) return { status: 'not_image', finalUrl: r.finalUrl, bytes: r.buf.length };
      return { status: 'ok', ext, buf: r.buf, finalUrl: r.finalUrl };
    } catch (err) {
      last = { status: 'error', detail: err.name === 'AbortError' ? 'timeout' : (err.code || err.cause?.code || err.message) };
      await sleep(1500);
    }
  }
  return last;
}

// Original link first; the https variant only when the http link got no answer at all.
// Photobucket: https first (that is what a browser opens today).
async function tryDownload(url, profile = 'image') {
  if (profile === 'page-referer' || profile === 'page-html') return pageStrategy(url, profile);
  if (profile === 'original-suffix') {
    const r = await attempt(`${toHttps(url)}~original`, PROFILES.image);
    return r.status === 'ok' ? { ...r, via: `${toHttps(url)}~original` } : r;
  }
  const headers = PROFILES[profile] || PROFILES.image;
  const https = url.startsWith('http://') ? `https://${url.slice(7)}` : null;
  let candidates = https ? [url, https] : [url];
  if (https && providerOf(new URL(url).hostname) === 'photobucket') candidates = [https, url];
  let best = null;
  for (const candidate of candidates) {
    const r = await attempt(candidate, headers);
    if (r.status === 'ok') return r;
    if (!best || (best.status === 'error' && r.status !== 'error')) best = r;
    if (r.status !== 'error') break;
  }
  return best;
}

async function waybackDownload(url) {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=20120101`;
  try {
    const r = await fetchBytes(api, { 'User-Agent': UA, Accept: 'application/json' });
    if (r.status !== 200) return { status: `wayback_http_${r.status}` };
    const snap = JSON.parse(r.buf.toString('utf8'))?.archived_snapshots?.closest;
    if (!snap?.available || String(snap.status) !== '200') return { status: 'wayback_none' };
    const result = await tryDownload(`https://web.archive.org/web/${snap.timestamp}id_/${url}`);
    return result.status === 'ok' ? { ...result, snapshot: snap.timestamp } : { status: `wayback_${result.status}` };
  } catch (err) {
    return { status: 'wayback_error', detail: err.message };
  }
}

// ---------- local files ----------
const BAD_CHARS = /[<>:"|?*\u0000-\u001f]/g;

// images/<provider>/<host>/<path>; very long paths go to images/<provider>/_long-paths/<hash>.<ext>
function localPath(out, url, ext) {
  const u = new URL(url);
  const host = u.hostname.toLowerCase();
  const provider = providerOf(host);
  let parts = u.pathname.split('/').filter(Boolean).map((p) => {
    let s = p;
    try {
      s = decodeURIComponent(p);
    } catch {
      // keep as is
    }
    return s.replace(BAD_CHARS, '_').replace(/[. ]+$/, '_').slice(0, 120) || '_';
  });
  if (!parts.length) parts = ['index'];
  let name = parts.pop();
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  if (u.search) name = `${name}__${hash}`;
  // The extension must match the real format (Photobucket may send WebP for a .jpg link).
  const current = /\.(jpe?g|jpe|png|gif|webp|bmp)$/i.exec(name);
  const same = current && (current[1].toLowerCase() === ext || (ext === 'jpg' && /^jpe?g|jpe$/i.test(current[1])));
  if (current && !same) name = `${name.slice(0, -current[0].length)}.${ext}`;
  else if (!current) name = `${name}.${ext}`;
  let full = path.join(out, IMAGES_DIR, provider, host, ...parts, name);
  if (full.length > 230) full = path.join(out, IMAGES_DIR, provider, '_long-paths', `${hash}.${ext}`);
  return full;
}

async function removeEmptyDirs(dir) {
  if (!existsSync(dir)) return;
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (e.isDirectory()) await removeEmptyDirs(path.join(dir, e.name));
  }
  if ((await fs.readdir(dir)).length === 0) await fs.rmdir(dir);
}

async function moveFile(from, to) {
  await fs.mkdir(path.dirname(to), { recursive: true });
  try {
    await fs.rename(from, to);
  } catch {
    await fs.copyFile(from, to);
    await fs.rm(from, { force: true });
  }
}

// ---------- manifest ----------
async function readManifest(file) {
  const map = new Map();
  if (!existsSync(file)) return map;
  const text = await fs.readFile(file, 'utf8');
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      map.set(rec.url, { ...(map.get(rec.url) || {}), ...rec });
    } catch {
      // ignore broken line
    }
  }
  return map;
}

// Files saved by the first version of this tool (files/<host>/..., _nghi-van/) are moved to the new layout.
async function migrateLayout(out, manifest, manifestFile) {
  const lines = [];
  const moved = new Map();
  for (const rec of manifest.values()) {
    if (!rec.file) continue;
    const oldRel = rec.file;
    let newRel = null;
    if (rec.status === 'ok' && /^files[\\/]/.test(oldRel) && rec.ext) {
      newRel = path.relative(out, localPath(out, rec.url, rec.ext));
    } else if (rec.status === 'suspect' && /^_nghi-van[\\/]/.test(oldRel)) {
      newRel = path.join(SUSPECT_DIR, path.basename(oldRel));
    }
    if (!newRel || newRel === oldRel) continue;
    const from = path.join(out, oldRel);
    if (!moved.has(oldRel) && existsSync(from)) {
      await moveFile(from, path.join(out, newRel));
      moved.set(oldRel, newRel);
    }
    rec.file = newRel;
    lines.push(JSON.stringify({ url: rec.url, file: newRel, at: new Date().toISOString() }));
  }
  if (lines.length) {
    await fs.appendFile(manifestFile, `${lines.join('\n')}\n`);
    await removeEmptyDirs(path.join(out, 'files'));
    await removeEmptyDirs(path.join(out, '_nghi-van'));
    console.log(`Moved ${moved.size} files from the old folder layout to ${IMAGES_DIR}/<provider>/...`);
  }
}

// Same bytes behind many different links => most likely the provider's "image not available" banner.
// Keep exactly one copy in _suspected-placeholders for review and mark those links as "suspect".
async function markSuspects(out, manifest, manifestFile) {
  const byHash = new Map();
  for (const rec of manifest.values()) {
    if (rec.status !== 'ok' || !rec.sha256) continue;
    const list = byHash.get(rec.sha256) || [];
    list.push(rec);
    byHash.set(rec.sha256, list);
  }
  const lines = [];
  const report = [];
  for (const [hash, list] of byHash) {
    if (list.length < SUSPECT_MIN_URLS) continue;
    const provider = providerOf(new URL(list[0].url).hostname);
    const keep = path.join(out, SUSPECT_DIR, `${provider}-${hash.slice(0, 12)}.${list[0].ext || 'img'}`);
    await fs.mkdir(path.dirname(keep), { recursive: true });
    for (const rec of list) {
      const src = rec.file ? path.join(out, rec.file) : null;
      if (src && existsSync(src)) {
        if (!existsSync(keep)) await fs.copyFile(src, keep);
        await fs.rm(src, { force: true });
      }
      const next = { url: rec.url, status: 'suspect', sha256: hash, file: path.relative(out, keep), at: new Date().toISOString() };
      manifest.set(rec.url, { ...rec, ...next });
      lines.push(JSON.stringify(next));
    }
    report.push({ file: path.relative(out, keep), urls: list.length, bytes: list[0].bytes });
  }
  if (lines.length) await fs.appendFile(manifestFile, `${lines.join('\n')}\n`);
  return report;
}

// ---------- probe ----------
// Download one link in every supported way so the results can be compared by eye.
async function probe(out, url) {
  const dir = path.join(out, '_probe');
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const httpsUrl = toHttps(url);
  const httpUrl = url.replace(/^https:\/\//i, 'http://');
  const lines = [];
  const save = async (name, r, target) => {
    let line = `  ${name.padEnd(24)} ${String(r.status).padEnd(16)}`;
    if (r.status === 'ok') {
      await fs.writeFile(path.join(dir, `${name}.${r.ext}`), r.buf);
      const hash = crypto.createHash('sha256').update(r.buf).digest('hex').slice(0, 12);
      line += ` ${String(r.buf.length).padStart(8)} bytes  sha ${hash}`;
    }
    if (r.finalUrl && r.finalUrl !== target) line += `  -> ${r.finalUrl}`;
    console.log(line);
    lines.push(line);
  };

  console.log(`Probing ${url}`);
  for (const [name, target, profile] of [
    ['1-https-navigate', httpsUrl, 'navigate'],
    ['2-http-navigate', httpUrl, 'navigate'],
    ['3-https-image', httpsUrl, 'image'],
    ['4-http-image', httpUrl, 'image'],
  ]) {
    await save(name, await attempt(target, PROFILES[profile]), target);
  }
  await save('5-original-suffix', await attempt(`${httpsUrl}~original`, PROFILES.image), `${httpsUrl}~original`);

  // Open like a browser, keep the HTML viewer page, then load images the way that page would.
  let page = null;
  try {
    page = await openAsBrowser(url);
  } catch (err) {
    console.log(`  (could not open the page: ${err.code || err.message})`);
  }
  if (page && !page.ext && page.status === 200) {
    await fs.writeFile(path.join(dir, 'page.html'), page.buf);
    console.log(`  page.html saved (${page.buf.length} bytes, cookies: ${[...page.jar.keys()].join(', ') || 'none'})`);
    const candidates = extractImageUrls(page.buf.toString('utf8'), page.finalUrl, httpsUrl);
    const withOriginal = [httpsUrl, ...candidates.filter((c) => c !== httpsUrl)];
    for (let i = 0; i < withOriginal.length; i += 1) {
      const candidate = withOriginal[i];
      const name = i === 0 ? '6-page-referer' : `7-page-html-${i}`;
      const r = await attempt(candidate, inPageImageHeaders(page.finalUrl, candidate, page.jar));
      await save(name, r, candidate);
      if (i > 0) console.log(`      ${candidate}`);
    }
  }
  await fs.writeFile(path.join(dir, 'probe.txt'), `${url}\n${lines.join('\n')}\n`);
  console.log(`Saved to ${dir}. Open the image files and check which ones have no watermark.`);
}

// ---------- reports ----------
// Labels written by the first version of this tool.
const OLD_LABELS = {
  'bai viet': 'posts', 'chu ky': 'signatures', tuong: 'wall messages',
  'tin nhan': 'private messages', 'binh luan': 'post comments', 'thong bao': 'announcements',
};

const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function writeIndex(out, all, manifest) {
  const header = ['url', 'provider', 'host', 'status', 'origin', 'file', 'bytes', 'refs', 'used_in', 'wayback'];
  const rows = [header.join(',')];
  for (const item of all) {
    const rec = manifest.get(item.url) || {};
    const origin = rec.status === 'ok' ? (String(rec.source || '').startsWith('wayback') ? 'wayback' : 'direct') : '';
    const status = rec.status === 'suspect' ? 'suspected_placeholder' : (rec.status || 'pending');
    rows.push([
      item.url, item.provider || providerOf(item.host), item.host, status, origin,
      (rec.file || '').split(path.sep).join('/'), rec.bytes || '', item.refs,
      (item.usedIn || item.kinds || []).map((k) => OLD_LABELS[k] || k).join('; '), rec.wayback || '',
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens the file as UTF-8.
  await fs.writeFile(path.join(out, 'index.csv'), `\uFEFF${rows.join('\r\n')}\r\n`, 'utf8');
}

function printSummary(all, manifest, out) {
  const byProvider = new Map();
  for (const item of all) {
    const p = item.provider || providerOf(item.host);
    const row = byProvider.get(p) || { links: 0, ok: 0, wayback: 0, dead: 0, pending: 0, bytes: 0 };
    const rec = manifest.get(item.url);
    row.links += 1;
    if (!rec || !rec.status) row.pending += 1;
    else if (rec.status === 'ok') {
      row.ok += 1;
      row.bytes += rec.bytes || 0;
      if (String(rec.source || '').startsWith('wayback')) row.wayback += 1;
    } else row.dead += 1;
    byProvider.set(p, row);
  }
  const rows = [...byProvider.entries()].sort((a, b) => b[1].links - a[1].links);
  console.log('\nProvider        links      saved  (wayback) not saved   pending        MB');
  let total = { links: 0, ok: 0, wayback: 0, dead: 0, pending: 0, bytes: 0 };
  for (const [p, r] of rows) {
    console.log(`${p.padEnd(14)}${String(r.links).padStart(7)}${String(r.ok).padStart(11)}${String(r.wayback).padStart(11)}`
      + `${String(r.dead).padStart(10)}${String(r.pending).padStart(10)}${(r.bytes / 1048576).toFixed(1).padStart(10)}`);
    for (const k of Object.keys(total)) total[k] += r[k];
  }
  console.log(`${'TOTAL'.padEnd(14)}${String(total.links).padStart(7)}${String(total.ok).padStart(11)}${String(total.wayback).padStart(11)}`
    + `${String(total.dead).padStart(10)}${String(total.pending).padStart(10)}${(total.bytes / 1048576).toFixed(1).padStart(10)}`);
  console.log(`Images: ${path.join(out, IMAGES_DIR)}   List: ${path.join(out, 'index.csv')}`);
}

// ---------- main ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.out) {
    console.log('Missing --out "<folder>". See the usage notes at the top of tools/rescue-images.js.');
    process.exit(1);
  }
  const out = path.resolve(opts.out);
  await fs.mkdir(out, { recursive: true });
  if (opts.probe) {
    await probe(out, opts.probe);
    return;
  }
  const urlsFile = path.join(out, 'urls.json');
  const manifestFile = path.join(out, 'manifest.jsonl');

  let all;
  if (!existsSync(urlsFile) || opts.rescan) {
    if (!process.env.DATABASE_URL) {
      console.log('The first run needs $env:DATABASE_URL (and the MySQL TCP proxy) to read the image links.');
      process.exit(1);
    }
    console.log('Reading image links from the database...');
    all = await scanDatabase(process.env.DATABASE_URL);
    all.sort((a, b) => b.refs - a.refs);
    await fs.writeFile(urlsFile, JSON.stringify(all, null, 1));
    console.log(`Found ${all.length} distinct image links.`);
  } else {
    all = JSON.parse(await fs.readFile(urlsFile, 'utf8'));
    for (const item of all) item.provider = item.provider || providerOf(item.host);
  }

  const manifest = await readManifest(manifestFile);
  await migrateLayout(out, manifest, manifestFile);

  let list = all;
  if (opts.provider) list = list.filter((u) => u.provider === opts.provider);
  if (opts.host) list = list.filter((u) => u.host.includes(opts.host));
  if (opts.refetch) {
    // Saved images whose last download used a different request style than the one chosen now.
    list = list.filter((u) => {
      const rec = manifest.get(u.url);
      const wanted = profileFor(u.provider, opts.profile);
      return rec?.status === 'ok' && !String(rec.source || '').startsWith('wayback') && (rec.profile || 'image') !== wanted;
    });
  } else if (opts.wayback) {
    list = list.filter((u) => {
      const rec = manifest.get(u.url);
      return rec && rec.status && rec.status !== 'ok' && rec.status !== 'suspect' && !rec.waybackTried;
    });
  } else {
    list = list.filter((u) => {
      const rec = manifest.get(u.url);
      return !FINAL.has(rec?.status) && !rec?.waybackTried;
    });
  }
  if (opts.sample > 0 && list.length > opts.sample) {
    const step = list.length / opts.sample;
    list = Array.from({ length: opts.sample }, (_, i) => list[Math.floor(i * step)]);
  }
  const mode = opts.refetch ? ' again (refetch)' : opts.wayback ? ' through the Wayback Machine' : '';
  console.log(`Processing ${list.length} links${mode}...`);

  const counts = {};
  let done = 0;
  let index = 0;
  let lastSave = Date.now();
  const concurrency = opts.wayback ? Math.min(2, opts.concurrency) : opts.concurrency;
  const worker = async () => {
    while (index < list.length) {
      const item = list[index];
      index += 1;
      const profile = profileFor(item.provider, opts.profile);
      const previous = manifest.get(item.url) || {};
      const result = opts.wayback ? await waybackDownload(item.url) : await tryDownload(item.url, profile);
      const rec = { url: item.url, at: new Date().toISOString() };
      if (opts.wayback) {
        rec.waybackTried = true;
        if (result.status === 'ok') rec.status = 'ok';
        else rec.wayback = result.status;
      } else if (opts.refetch) {
        // Never lose a saved image: on failure keep the old file and record why.
        if (result.status === 'ok') rec.status = 'ok';
        else rec.refetchFailed = result.status;
      } else {
        rec.status = result.status;
      }
      if (result.finalUrl && result.finalUrl !== item.url) rec.finalUrl = result.finalUrl;
      if (result.detail) rec.detail = result.detail;
      if (result.status === 'ok') {
        const file = localPath(out, item.url, result.ext);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, result.buf);
        const relative = path.relative(out, file);
        if (opts.refetch && previous.file && previous.file !== relative) {
          await fs.rm(path.join(out, previous.file), { force: true });
        }
        Object.assign(rec, {
          file: relative,
          ext: result.ext,
          bytes: result.buf.length,
          sha256: crypto.createHash('sha256').update(result.buf).digest('hex'),
          source: opts.wayback ? `wayback ${result.snapshot}` : 'direct',
          profile: opts.wayback ? 'image' : profile,
        });
      }
      manifest.set(item.url, { ...(manifest.get(item.url) || {}), ...rec });
      await fs.appendFile(manifestFile, `${JSON.stringify(rec)}\n`);
      const label = opts.refetch ? (rec.status === 'ok' ? 'replaced' : `kept_old (${rec.refetchFailed})`) : (rec.status || rec.wayback);
      counts[label] = (counts[label] || 0) + 1;
      done += 1;
      if (done % 25 === 0 || done === list.length) {
        const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
        process.stdout.write(`\r${done}/${list.length}: ${summary}        `);
      }
      if (Date.now() - lastSave > 60000) {
        lastSave = Date.now();
        await writeIndex(out, all, manifest);
      }
      if (opts.wayback) await sleep(800);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log('');

  const suspects = await markSuspects(out, manifest, manifestFile);
  if (suspects.length) {
    console.log(`Possible "image not available" banners (same image behind many links), one copy each in ${SUSPECT_DIR}:`);
    suspects.forEach((s) => console.log(`  ${s.file}: ${s.urls} links, ${Math.round((s.bytes || 0) / 1024)} KB`));
  }
  await writeIndex(out, all, manifest);
  printSummary(all, manifest, out);
}

main().catch((err) => {
  console.error('\nError:', err.message);
  process.exit(1);
});
