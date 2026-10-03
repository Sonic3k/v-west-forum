// Cứu ảnh từ các dịch vụ ngoài (Photobucket, Blogspot, Flickr...) được nhúng bằng [IMG] trong forum.
// Chỉ ĐỌC database; ảnh được lưu vào thư mục trên máy bạn. Chạy lại bao nhiêu lần cũng được:
// link đã xử lý sẽ được bỏ qua (ghi trong manifest.jsonl).
//
// PowerShell, trong thư mục server, cần bật TCP Proxy của MySQL ở lần chạy đầu:
//   $env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
//   node tools/rescue-images.js --out "E:\FC Westlife\anh-ngoai" --host photobucket --sample 50   (tải thử)
//   node tools/rescue-images.js --out "E:\FC Westlife\anh-ngoai"                                  (tải hết)
//   node tools/rescue-images.js --out "E:\FC Westlife\anh-ngoai" --wayback                        (thử Wayback cho link chết)
//
// Tùy chọn: --host <chuỗi>  chỉ xử lý link có host chứa chuỗi này
//           --sample <n>    chỉ thử n link (rải đều trong danh sách)
//           --concurrency <n> số link tải cùng lúc (mặc định 4)
//           --rescan        đọc lại danh sách link từ database
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import mysql from 'mysql2/promise';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const SUSPECT_MIN_URLS = 8; // cùng một nội dung ảnh xuất hiện ở >= 8 link khác nhau → nghi là ảnh báo lỗi
const FINAL = new Set(['ok', 'not_found', 'suspect']);

// ---------- tham số ----------
function parseArgs(argv) {
  const opts = { out: null, host: null, sample: 0, concurrency: 4, wayback: false, rescan: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.out = argv[++i];
    else if (a === '--host') opts.host = String(argv[++i] || '').toLowerCase();
    else if (a === '--sample') opts.sample = Number(argv[++i]) || 0;
    else if (a === '--concurrency') opts.concurrency = Math.max(1, Math.min(16, Number(argv[++i]) || 4));
    else if (a === '--wayback') opts.wayback = true;
    else if (a === '--rescan') opts.rescan = true;
  }
  return opts;
}

// ---------- đọc link từ database ----------
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

// [tên, bảng, cột chứa nội dung]
const SOURCES = [
  ['bai viet', 'post', 'pagetext'],
  ['chu ky', 'usertextfield', 'signature'],
  ['tuong', 'visitormessage', 'pagetext'],
  ['tin nhan', 'pmtext', 'message'],
  ['binh luan', 'vbcomment', 'comment'],
  ['thong bao', 'announcement', 'pagetext'],
];

async function scanDatabase(uri) {
  const db = await mysql.createConnection({ uri, charset: 'BINARY', typeCast: utf8Cast });
  const urls = new Map();
  const IMG = /\[img(?:=[^\]]*)?\]\s*([\s\S]*?)\s*\[\/img\]/gi;
  for (const [kind, table, column] of SOURCES) {
    let rows = [];
    try {
      // Kết nối BINARY nên so sánh phân biệt hoa thường: dùng LOWER để bắt cả [IMG] lẫn [img].
      [rows] = await db.query(`SELECT ${column} AS t FROM ${table} WHERE LOWER(${column}) LIKE '%[img%'`);
    } catch (err) {
      console.log(`  (bỏ qua ${kind}: ${err.code || err.message})`);
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
        if (/westlife/.test(host)) continue; // ảnh trên chính forum cũ: đã có trong database/ảnh đã nhập
        const item = urls.get(url) || { url, host, refs: 0, kinds: [] };
        item.refs += 1;
        if (!item.kinds.includes(kind)) item.kinds.push(kind);
        urls.set(url, item);
        found += 1;
      }
    }
    console.log(`  ${kind}: ${rows.length} mục có [IMG], ${found} link`);
  }
  await db.end();
  return [...urls.values()];
}

// ---------- tải ảnh ----------
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('latin1', 0, 2) === 'BM') return 'bmp';
  return null;
}

async function fetchBytes(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' },
      redirect: 'follow',
      signal: ctrl.signal,
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return { status: res.status, finalUrl: res.url, buf };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tải một địa chỉ, thử lại khi lỗi mạng hoặc bị giới hạn tốc độ.
async function attempt(target) {
  let last = { status: 'error', detail: 'không tải được' };
  for (let i = 0; i < 2; i += 1) {
    try {
      const r = await fetchBytes(target);
      if (r.status === 429 || r.status === 503) {
        last = { status: `http_${r.status}`, detail: 'bị giới hạn tốc độ' };
        await sleep(20000);
        continue;
      }
      if (r.status === 404 || r.status === 410) return { status: 'not_found', finalUrl: r.finalUrl };
      if (r.status !== 200) return { status: `http_${r.status}`, finalUrl: r.finalUrl };
      const ext = sniff(r.buf);
      if (!ext) return { status: 'not_image', finalUrl: r.finalUrl, bytes: r.buf.length };
      return { status: 'ok', ext, buf: r.buf, finalUrl: r.finalUrl };
    } catch (err) {
      last = { status: 'error', detail: err.name === 'AbortError' ? 'quá thời gian' : (err.cause?.code || err.message) };
      await sleep(1500);
    }
  }
  return last;
}

// Thử link gốc; chỉ thử bản https khi link http lỗi mạng (máy chủ không trả lời).
async function tryDownload(url) {
  const candidates = [url];
  if (url.startsWith('http://')) candidates.push(`https://${url.slice(7)}`);
  let best = null;
  for (const candidate of candidates) {
    const r = await attempt(candidate);
    if (r.status === 'ok') return r;
    if (!best || (best.status === 'error' && r.status !== 'error')) best = r;
    if (r.status !== 'error') break;
  }
  return best;
}

async function waybackDownload(url) {
  const api = `https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=20120101`;
  try {
    const r = await fetchBytes(api);
    if (r.status !== 200) return { status: `wayback_http_${r.status}` };
    const snap = JSON.parse(r.buf.toString('utf8'))?.archived_snapshots?.closest;
    if (!snap?.available || String(snap.status) !== '200') return { status: 'wayback_none' };
    const result = await tryDownload(`https://web.archive.org/web/${snap.timestamp}id_/${url}`);
    return result.status === 'ok' ? { ...result, snapshot: snap.timestamp } : { status: `wayback_${result.status}` };
  } catch (err) {
    return { status: 'wayback_error', detail: err.message };
  }
}

// ---------- lưu file ----------
const BAD = /[<>:"|?*\u0000-\u001f]/g;

function localPath(out, url, ext) {
  const u = new URL(url);
  let parts = u.pathname.split('/').filter(Boolean).map((p) => {
    let s = p;
    try {
      s = decodeURIComponent(p);
    } catch {
      // giữ nguyên
    }
    return s.replace(BAD, '_').replace(/[. ]+$/, '_').slice(0, 120) || '_';
  });
  if (!parts.length) parts = ['index'];
  let name = parts.pop();
  const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 8);
  if (u.search) name = `${name}__${hash}`;
  if (!new RegExp(`\\.(${ext}|jpe?g)$`, 'i').test(name)) name = `${name}.${ext}`;
  let full = path.join(out, 'files', u.hostname.toLowerCase(), ...parts, name);
  if (full.length > 230) full = path.join(out, 'files', u.hostname.toLowerCase(), '_dai', `${hash}.${ext}`);
  return full;
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
      // bỏ dòng hỏng
    }
  }
  return map;
}

// Cùng một nội dung ảnh ở rất nhiều link khác nhau → nhiều khả năng là ảnh báo lỗi của dịch vụ.
// Giữ đúng 1 bản trong _nghi-van để bạn tự xem, đánh dấu các link đó là "suspect".
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
    const keep = path.join(out, '_nghi-van', `${hash.slice(0, 12)}.${list[0].ext || 'img'}`);
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
    report.push({ file: path.relative(out, keep), urls: list.length, bytes: list[0].bytes, example: list[0].url });
  }
  if (lines.length) await fs.appendFile(manifestFile, `${lines.join('\n')}\n`);
  return report;
}

// ---------- chạy ----------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.out) {
    console.log('Thiếu --out "<thư mục lưu ảnh>". Xem hướng dẫn ở đầu file tools/rescue-images.js.');
    process.exit(1);
  }
  const out = path.resolve(opts.out);
  await fs.mkdir(out, { recursive: true });
  const urlsFile = path.join(out, 'urls.json');
  const manifestFile = path.join(out, 'manifest.jsonl');

  let all;
  if (!existsSync(urlsFile) || opts.rescan) {
    if (!process.env.DATABASE_URL) {
      console.log('Lần đầu cần đặt $env:DATABASE_URL (và bật TCP Proxy) để đọc danh sách link từ database.');
      process.exit(1);
    }
    console.log('Đang đọc link ảnh từ database...');
    all = await scanDatabase(process.env.DATABASE_URL);
    all.sort((a, b) => b.refs - a.refs);
    await fs.writeFile(urlsFile, JSON.stringify(all, null, 1));
    const hosts = new Map();
    for (const u of all) hosts.set(u.host.replace(/^(i\d+|img\d+|s\d+|www)\./, ''), (hosts.get(u.host.replace(/^(i\d+|img\d+|s\d+|www)\./, '')) || 0) + 1);
    console.log(`Tổng ${all.length} link ảnh khác nhau. Nhiều nhất:`);
    [...hosts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).forEach(([h, n]) => console.log(`  ${h}: ${n}`));
  } else {
    all = JSON.parse(await fs.readFile(urlsFile, 'utf8'));
  }

  const manifest = await readManifest(manifestFile);
  let list = opts.host ? all.filter((u) => u.host.includes(opts.host)) : all;
  if (opts.wayback) {
    list = list.filter((u) => {
      const rec = manifest.get(u.url);
      return rec && rec.status !== 'ok' && rec.status !== 'suspect' && !rec.waybackTried;
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
  console.log(`Sẽ xử lý ${list.length} link${opts.wayback ? ' qua Wayback Machine' : ''}.`);

  const counts = {};
  let done = 0;
  let index = 0;
  const concurrency = opts.wayback ? Math.min(2, opts.concurrency) : opts.concurrency;
  const worker = async () => {
    while (index < list.length) {
      const item = list[index];
      index += 1;
      const result = opts.wayback ? await waybackDownload(item.url) : await tryDownload(item.url);
      const rec = { url: item.url, at: new Date().toISOString() };
      if (opts.wayback) {
        rec.waybackTried = true;
        if (result.status === 'ok') rec.status = 'ok';
        else rec.wayback = result.status;
      } else {
        rec.status = result.status;
      }
      if (result.finalUrl && result.finalUrl !== item.url) rec.finalUrl = result.finalUrl;
      if (result.detail) rec.detail = result.detail;
      if (result.status === 'ok') {
        const file = localPath(out, item.url, result.ext);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, result.buf);
        Object.assign(rec, {
          file: path.relative(out, file),
          ext: result.ext,
          bytes: result.buf.length,
          sha256: crypto.createHash('sha256').update(result.buf).digest('hex'),
          source: opts.wayback ? `wayback ${result.snapshot}` : 'direct',
        });
      }
      manifest.set(item.url, { ...(manifest.get(item.url) || {}), ...rec });
      await fs.appendFile(manifestFile, `${JSON.stringify(rec)}\n`);
      const label = rec.status || rec.wayback;
      counts[label] = (counts[label] || 0) + 1;
      done += 1;
      if (done % 25 === 0 || done === list.length) {
        const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ');
        process.stdout.write(`\r${done}/${list.length}: ${summary}        `);
      }
      if (opts.wayback) await sleep(800);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  console.log('');

  const suspects = await markSuspects(out, manifest, manifestFile);
  if (suspects.length) {
    console.log('Ảnh nghi là ảnh báo lỗi của dịch vụ (cùng nội dung ở nhiều link), đã gom vào thư mục _nghi-van:');
    suspects.forEach((s) => console.log(`  ${s.file}: ${s.urls} link, ${Math.round((s.bytes || 0) / 1024)} KB`));
  }

  // Tổng kết theo trạng thái và dung lượng.
  const total = {};
  let okBytes = 0;
  let fromWayback = 0;
  let waybackTried = 0;
  for (const rec of manifest.values()) {
    total[rec.status] = (total[rec.status] || 0) + 1;
    if (rec.status === 'ok') okBytes += rec.bytes || 0;
    if (rec.status === 'ok' && String(rec.source || '').startsWith('wayback')) fromWayback += 1;
    if (rec.waybackTried) waybackTried += 1;
  }
  console.log('Tổng cộng đến giờ:', Object.entries(total).map(([k, v]) => `${k} ${v}`).join(', '));
  if (waybackTried) console.log(`Wayback: đã thử ${waybackTried} link chết, cứu thêm được ${fromWayback}.`);
  console.log(`Ảnh cứu được: ${total.ok || 0} file, ${(okBytes / 1048576).toFixed(1)} MB, lưu ở ${path.join(out, 'files')}`);
}

main().catch((err) => {
  console.error('\nLỗi:', err.message);
  process.exit(1);
});
