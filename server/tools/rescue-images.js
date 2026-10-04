// Rescue externally hosted images (Photobucket, Blogspot, Flickr, ...) embedded with [IMG] in the forum,
// keeping the most original copy that can still be found. Reads the database only; files go to a local folder.
//
// Layout of the output folder:
//   images/<provider>/<host>/<original path>   one file per link, the best copy found
//   _suspected-placeholders/                   one copy of each image that looks like a "not available" banner
//   index.csv                                  url -> file, provider, quality, origin (open it with Excel)
//   urls.json, manifest.jsonl                  tool state (link list and per-link results; used to resume)
//
// Quality of a saved copy:
//   original  the file as the host serves it, or a Wayback Machine capture (Photobucket: captured before July 2017)
//   viewer    Photobucket today: no watermark, but possibly reduced and marked "Low Res"
//
// Usage (PowerShell, inside the server folder; the first run reads the database through the MySQL TCP proxy):
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/rescue-images.js --out "E:\FC Westlife\external-images"             step 1: download everything
//   node tools/rescue-images.js --out "E:\FC Westlife\external-images" --wayback   step 2: dead links + Photobucket
//                                                                                   upgrades from the Wayback Machine
// Options: --provider <name>   only one provider (photobucket, google, flickr, facebook, ...)
//          --sample <n>        only try n links, spread evenly over the list
//          --concurrency <n>   parallel downloads (default 4; Wayback always uses 2)
//          --rescan            read the link list from the database again
//          --probe <url>       download one link in every supported way into _probe/ to compare by eye
// Safe to stop and re-run at any time: finished links are skipped.
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
const TIMEOUT_MS = 30000;
const MAX_BYTES = 30 * 1024 * 1024;
const SUSPECT_MIN_URLS = 8; // identical bytes behind >= 8 different links => most likely a placeholder banner
const PHOTOBUCKET_CUTOFF = '20170701'; // Photobucket started blocking/watermarking embeds in July 2017
// Wayback Machine endpoints (overridable for testing).
const WAYBACK_API = process.env.WAYBACK_API_BASE || 'https://archive.org';
const WAYBACK_WEB = process.env.WAYBACK_WEB_BASE || 'https://web.archive.org';
const IMAGES_DIR = 'images';
const SUSPECT_DIR = '_suspected-placeholders';

// ---------- request styles ----------
const CH_UA = '"Chromium";v="126", "Google Chrome";v="126", "Not-A.Brand";v="99"';
const PROFILES = {
  // like an <img> tag on another site
  image: {
    'User-Agent': UA,
    Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  },
  // like typing the link into the browser address bar
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
    'sec-ch-ua': CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  },
};

// Photobucket: an embedded-style request gets a watermarked copy, a typed link gets an HTML viewer page.
// "page-referer" opens that page like a browser (keeping its cookies), then loads the image as the page does.
const defaultStrategy = (provider) => (provider === 'photobucket' ? 'page-referer' : 'image');

// ---------- arguments ----------
function parseArgs(argv) {
  const opts = { out: null, provider: null, sample: 0, concurrency: 4, wayback: false, rescan: false, probe: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--provider') opts.provider = String(argv[++i] || '').toLowerCase();
    else if (a === '--sample') opts.sample = Number(argv[++i]) || 0;
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Math.min(16, Number(argv[++i]) || 4));
    else if (a === '--wayback') opts.wayback = true;
    else if (a === '--rescan') opts.rescan = true;
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

// ---------- HTTP ----------
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

const cookieHeader = (jar) => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

// Plain node:http(s) instead of fetch(): fetch() rewrites some headers (e.g. Sec-Fetch-Mode: cors).
// jar: optional Map(name -> value); cookies set by every response are kept and sent on redirects.
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
        resolve({ status: statusCode, finalUrl: target.href, buf });
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHttps = (url) => url.replace(/^http:\/\//i, 'https://');

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

function siteRelation(from, to) {
  const a = new URL(from);
  const b = new URL(to);
  if (a.origin === b.origin) return 'same-origin';
  const root = (h) => h.split('.').slice(-2).join('.');
  return root(a.hostname) === root(b.hostname) ? 'same-site' : 'cross-site';
}

// Headers of an image that an HTML page loads itself (the page as Referer, with its cookies).
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
    'sec-ch-ua': CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
  };
  if (jar && jar.size) headers.Cookie = cookieHeader(jar);
  return headers;
}

// Image addresses inside an HTML page (og:image, <img src>, URLs in scripts); the original file name first.
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
  return [...found.entries()].filter(([, score]) => score >= 3).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([u]) => u);
}

async function openAsBrowser(url) {
  const jar = new Map();
  const r = await fetchBytes(toHttps(url), PROFILES.navigate, 0, jar);
  return { ...r, jar, ext: r.status === 200 ? sniff(r.buf) : null };
}

// Open the link like a browser, then load the image the way the viewer page does.
async function pageReferer(url) {
  let page;
  try {
    page = await openAsBrowser(url);
  } catch (err) {
    return { status: 'error', detail: err.code || err.message };
  }
  if (page.status === 404 || page.status === 410) return { status: 'not_found', finalUrl: page.finalUrl };
  if (page.ext) return { status: 'ok', ext: page.ext, buf: page.buf, finalUrl: page.finalUrl };
  if (page.status !== 200) return { status: `http_${page.status}`, finalUrl: page.finalUrl };
  const original = toHttps(url);
  return attempt(original, inPageImageHeaders(page.finalUrl, original, page.jar));
}

// One link with one strategy. Plain links: the original address first, https only if http got no answer.
async function download(url, strategy) {
  if (strategy === 'page-referer') return pageReferer(url);
  const https = url.startsWith('http://') ? toHttps(url) : null;
  let best = null;
  for (const candidate of https ? [url, https] : [url]) {
    const r = await attempt(candidate, PROFILES.image);
    if (r.status === 'ok') return r;
    if (!best || (best.status === 'error' && r.status !== 'error')) best = r;
    if (r.status !== 'error') break;
  }
  return best;
}

// Larger versions to try before the link itself (thumbnails and resized copies point to the original).
function originalCandidates(url, provider) {
  const out = [];
  try {
    const u = new URL(url);
    if (provider === 'google') {
      // Blogger / Google Photos: /s400/ or =s400 means "resized to 400px"; s0 means original size.
      const sized = u.pathname.replace(/\/(?:s|w|h)\d+(?:-[a-z0-9-]+)?\//i, '/s0/');
      if (sized !== u.pathname) out.push(`${u.origin}${sized}${u.search}`);
      if (/=[swh]\d+[^/?#]*$/i.test(u.pathname)) out.push(`${u.origin}${u.pathname.replace(/=[swh]\d+[^/?#]*$/i, '=s0')}${u.search}`);
    }
    if (provider === 'photobucket') {
      const base = path.posix.basename(u.pathname);
      if (/^th_/i.test(base)) out.push(`${u.origin}${u.pathname.slice(0, -base.length)}${base.slice(3)}${u.search}`);
    }
  } catch {
    // keep only the link itself
  }
  return [...new Set([...out, url])];
}

async function bestDownload(item) {
  const strategy = defaultStrategy(item.provider);
  let last = null;
  for (const candidate of originalCandidates(item.url, item.provider)) {
    const r = await download(candidate, strategy);
    if (r.status === 'ok') return { ...r, strategy, via: candidate !== item.url ? candidate : undefined };
    last = r;
  }
  return { ...last, strategy };
}

// ---------- Wayback Machine ----------
async function waybackDownload(url, provider) {
  const when = provider === 'photobucket' ? '20150101' : '20120101';
  const api = `${WAYBACK_API}/wayback/available?url=${encodeURIComponent(url)}&timestamp=${when}`;
  try {
    const r = await fetchBytes(api, { 'User-Agent': UA, Accept: 'application/json' });
    if (r.status !== 200) return { status: `wayback_http_${r.status}` };
    const snap = JSON.parse(r.buf.toString('utf8'))?.archived_snapshots?.closest;
    if (!snap?.available || String(snap.status) !== '200') return { status: 'wayback_none' };
    // After July 2017 Photobucket captures are usually watermarks or "please update your account" banners.
    if (provider === 'photobucket' && String(snap.timestamp) >= PHOTOBUCKET_CUTOFF) return { status: 'wayback_too_late' };
    const result = await attempt(`${WAYBACK_WEB}/web/${snap.timestamp}id_/${url}`, PROFILES.image);
    return result.status === 'ok' ? { ...result, snapshot: String(snap.timestamp) } : { status: `wayback_${result.status}` };
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
  // The extension follows the real format (Photobucket may send WebP for a .jpg link).
  const current = /\.(jpe?g|jpe|png|gif|webp|bmp)$/i.exec(name);
  const same = current && (current[1].toLowerCase() === ext || (ext === 'jpg' && /^(jpe?g|jpe)$/i.test(current[1])));
  if (current && !same) name = `${name.slice(0, -current[0].length)}.${ext}`;
  else if (!current) name = `${name}.${ext}`;
  let full = path.join(out, IMAGES_DIR, provider, host, ...parts, name);
  if (full.length > 230) full = path.join(out, IMAGES_DIR, provider, '_long-paths', `${hash}.${ext}`);
  return full;
}

async function saveImage(out, url, result, previousFile) {
  const file = localPath(out, url, result.ext);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, result.buf);
  const relative = path.relative(out, file);
  if (previousFile && previousFile !== relative) await fs.rm(path.join(out, previousFile), { force: true });
  return {
    file: relative,
    ext: result.ext,
    bytes: result.buf.length,
    sha256: crypto.createHash('sha256').update(result.buf).digest('hex'),
  };
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
    let line = `  ${name.padEnd(24)} ${String(r.status).padEnd(18)}`;
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
  await save('1-https-navigate', await attempt(httpsUrl, PROFILES.navigate), httpsUrl);
  await save('2-https-image', await attempt(httpsUrl, PROFILES.image), httpsUrl);
  await save('3-http-image', await attempt(httpUrl, PROFILES.image), httpUrl);
  await save('4-page-referer', await pageReferer(url), httpsUrl);
  let page = null;
  try {
    page = await openAsBrowser(url);
  } catch {
    // no page
  }
  if (page && !page.ext && page.status === 200) {
    await fs.writeFile(path.join(dir, 'page.html'), page.buf);
    const candidates = extractImageUrls(page.buf.toString('utf8'), page.finalUrl, httpsUrl).filter((c) => c !== httpsUrl);
    for (let i = 0; i < candidates.length; i += 1) {
      await save(`5-page-html-${i + 1}`, await attempt(candidates[i], inPageImageHeaders(page.finalUrl, candidates[i], page.jar)), candidates[i]);
      console.log(`      ${candidates[i]}`);
    }
  }
  const provider = providerOf(new URL(url).hostname);
  const wb = await waybackDownload(url, provider);
  await save(`6-wayback${wb.snapshot ? `-${wb.snapshot}` : ''}`, wb, url);
  await fs.writeFile(path.join(dir, 'probe.txt'), `${url}\n${lines.join('\n')}\n`);
  console.log(`Saved to ${dir}.`);
}

// ---------- reports ----------
const csvCell = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

async function writeIndex(out, all, manifest) {
  const header = ['url', 'provider', 'host', 'status', 'quality', 'origin', 'file', 'bytes', 'refs', 'used_in', 'saved_from', 'wayback'];
  const rows = [header.join(',')];
  for (const item of all) {
    const rec = manifest.get(item.url) || {};
    const ok = rec.status === 'ok';
    rows.push([
      item.url,
      item.provider,
      item.host,
      rec.status === 'suspect' ? 'suspected_placeholder' : (rec.status || 'pending'),
      ok ? rec.quality || '' : '',
      ok ? rec.origin || '' : '',
      (rec.file || '').split(path.sep).join('/'),
      rec.bytes || '',
      item.refs,
      (item.usedIn || []).join('; '),
      rec.via || '',
      rec.wayback || '',
    ].map(csvCell).join(','));
  }
  // BOM so Excel opens the file as UTF-8.
  await fs.writeFile(path.join(out, 'index.csv'), `\uFEFF${rows.join('\r\n')}\r\n`, 'utf8');
}

function printSummary(all, manifest, out) {
  const byProvider = new Map();
  const blank = () => ({ links: 0, saved: 0, original: 0, viewer: 0, wayback: 0, lost: 0, pending: 0, bytes: 0 });
  for (const item of all) {
    const row = byProvider.get(item.provider) || blank();
    const rec = manifest.get(item.url);
    row.links += 1;
    if (!rec || !rec.status) row.pending += 1;
    else if (rec.status === 'ok') {
      row.saved += 1;
      row.bytes += rec.bytes || 0;
      if (rec.quality === 'viewer') row.viewer += 1;
      else row.original += 1;
      if (rec.origin === 'wayback') row.wayback += 1;
    } else row.lost += 1;
    byProvider.set(item.provider, row);
  }
  const cols = [['links', 7], ['saved', 8], ['original', 10], ['viewer', 8], ['wayback', 9], ['lost', 8], ['pending', 9]];
  const line = (name, r) => `${name.padEnd(13)}${cols.map(([k, w]) => String(r[k]).padStart(w)).join('')}${(r.bytes / 1048576).toFixed(1).padStart(10)}`;
  console.log(`\n${'provider'.padEnd(13)}${cols.map(([k, w]) => k.padStart(w)).join('')}${'MB'.padStart(10)}`);
  const total = blank();
  for (const [p, r] of [...byProvider.entries()].sort((a, b) => b[1].links - a[1].links)) {
    console.log(line(p, r));
    for (const k of Object.keys(total)) total[k] += r[k];
  }
  console.log(line('TOTAL', total));
  console.log('original = file as served by the host or an early Wayback capture; viewer = Photobucket copy without watermark (may be reduced).');
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
  let list = opts.provider ? all.filter((u) => u.provider === opts.provider) : all;
  if (opts.wayback) {
    // Dead links, and Photobucket "viewer" copies that may have an original capture.
    list = list.filter((u) => {
      const rec = manifest.get(u.url);
      if (!rec?.status || rec.waybackTried) return false;
      if (rec.status === 'ok') return rec.quality === 'viewer';
      return rec.status !== 'suspect';
    });
  } else {
    list = list.filter((u) => !manifest.get(u.url)?.status);
  }
  if (opts.sample > 0 && list.length > opts.sample) {
    const step = list.length / opts.sample;
    list = Array.from({ length: opts.sample }, (_, i) => list[Math.floor(i * step)]);
  }
  console.log(`Processing ${list.length} links${opts.wayback ? ' through the Wayback Machine' : ''}...`);

  const counts = {};
  let done = 0;
  let index = 0;
  let lastSave = Date.now();
  const concurrency = opts.wayback ? Math.min(2, opts.concurrency) : opts.concurrency;
  const worker = async () => {
    while (index < list.length) {
      const item = list[index];
      index += 1;
      const previous = manifest.get(item.url) || {};
      const rec = { url: item.url, at: new Date().toISOString() };
      let label;
      if (opts.wayback) {
        const result = await waybackDownload(item.url, item.provider);
        rec.waybackTried = true;
        if (result.status === 'ok') {
          Object.assign(rec, await saveImage(out, item.url, result, previous.file), {
            status: 'ok', quality: 'original', origin: 'wayback', snapshot: result.snapshot,
          });
          label = previous.status === 'ok' ? 'upgraded' : 'recovered';
        } else {
          rec.wayback = result.status;
          label = result.status;
        }
        await sleep(800);
      } else {
        const result = await bestDownload(item);
        rec.status = result.status;
        rec.strategy = result.strategy;
        if (result.detail) rec.detail = result.detail;
        if (result.status === 'ok') {
          Object.assign(rec, await saveImage(out, item.url, result, null), {
            quality: result.strategy === 'page-referer' ? 'viewer' : 'original',
            origin: 'direct',
          });
          if (result.via) rec.via = result.via;
        }
        label = result.status;
      }
      manifest.set(item.url, { ...previous, ...rec });
      await fs.appendFile(manifestFile, `${JSON.stringify(rec)}\n`);
      counts[label] = (counts[label] || 0) + 1;
      done += 1;
      if (done % 25 === 0 || done === list.length) {
        process.stdout.write(`\r${done}/${list.length}: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}        `);
      }
      if (Date.now() - lastSave > 60000) {
        lastSave = Date.now();
        await writeIndex(out, all, manifest);
      }
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
