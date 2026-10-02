import { decodeEntities } from './text.js';

// Các thẻ BBCode của vBulletin 4 mà panel hiển thị. Thẻ lạ được giữ nguyên dạng chữ.
const KNOWN = new Set([
  'b', 'i', 'u', 's', 'strike', 'sub', 'sup', 'color', 'size', 'font', 'highlight',
  'left', 'center', 'right', 'indent', 'url', 'email', 'img', 'quote',
  'code', 'php', 'html', 'noparse', 'list', '*', 'attach', 'youtube', 'video',
]);
// Nội dung bên trong được lấy nguyên văn, không phân tích thẻ lồng.
const RAW = new Set(['code', 'php', 'html', 'noparse', 'img', 'attach', 'youtube', 'video', 'email']);
// Thẻ dạng khối: bỏ một dòng trống ngay sau thẻ mở/đóng như vBulletin.
const BLOCK = new Set(['quote', 'left', 'center', 'right', 'indent', 'list', 'code', 'php', 'html']);

const TAG_RE = /\[(\/?)([a-zA-Z]+|\*)(?:=([^\]]*))?\]/g;

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) return v.slice(1, -1);
  return v;
}

function trimTrailingNewline(node) {
  const last = node.children[node.children.length - 1];
  if (typeof last === 'string') {
    const trimmed = last.replace(/\n$/, '');
    if (trimmed) node.children[node.children.length - 1] = trimmed;
    else node.children.pop();
  }
}

function findOpen(stack, name) {
  for (let i = stack.length - 1; i > 0; i -= 1) if (stack[i].tag === name) return i;
  return -1;
}

export function parseBBCode(input) {
  const text = String(input || '').replace(/\r\n?/g, '\n');
  const root = { tag: 'root', children: [] };
  const stack = [root];
  const top = () => stack[stack.length - 1];
  let eatNewline = false;
  let last = 0;

  const pushText = (chunk) => {
    let t = chunk;
    if (eatNewline) {
      t = t.replace(/^\n/, '');
      eatNewline = false;
    }
    if (t) top().children.push(t);
  };

  const closeTo = (index) => {
    for (let i = stack.length - 1; i >= index; i -= 1) {
      trimTrailingNewline(stack[i]);
    }
    const closed = stack[index];
    stack.length = index;
    if (BLOCK.has(closed.tag)) eatNewline = true;
  };

  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(text))) {
    const [full, closing, rawName, rawOpt] = m;
    const name = rawName.toLowerCase();
    if (!KNOWN.has(name)) continue;

    pushText(text.slice(last, m.index));
    last = TAG_RE.lastIndex;
    const opt = rawOpt == null ? null : unquote(rawOpt);

    if (closing) {
      if (name === '*') continue;
      const index = findOpen(stack, name);
      if (index === -1) pushText(full);
      else closeTo(index);
      continue;
    }

    if (name === '*') {
      const listIndex = findOpen(stack, 'list');
      if (listIndex === -1) {
        pushText(full);
        continue;
      }
      for (let i = stack.length - 1; i > listIndex; i -= 1) trimTrailingNewline(stack[i]);
      stack.length = listIndex + 1;
      const item = { tag: '*', opt: null, children: [] };
      top().children.push(item);
      stack.push(item);
      continue;
    }

    if (RAW.has(name)) {
      const closeRe = new RegExp(`\\[\\/${name}\\]`, 'i');
      const rest = text.slice(last);
      const close = closeRe.exec(rest);
      const raw = close ? rest.slice(0, close.index) : rest;
      top().children.push({ tag: name, opt, raw: raw.replace(/^\n/, '').replace(/\n$/, ''), children: [] });
      last = close ? last + close.index + close[0].length : text.length;
      TAG_RE.lastIndex = last;
      if (BLOCK.has(name)) eatNewline = true;
      continue;
    }

    const node = { tag: name, opt, children: [] };
    top().children.push(node);
    stack.push(node);
    if (BLOCK.has(name)) eatNewline = true;
  }
  pushText(text.slice(last));
  return root;
}

export function nodeText(node) {
  if (typeof node === 'string') return node;
  if (node.raw != null) return node.raw;
  return node.children.map(nodeText).join('');
}

// Các file đính kèm đã chèn vào nội dung bằng [ATTACH] (không hiện lại ở cuối bài).
export function collectAttachIds(node, out = new Set()) {
  if (typeof node === 'string') return out;
  if (node.tag === 'attach') {
    const id = Number.parseInt(node.raw, 10);
    if (Number.isInteger(id)) out.add(id);
  }
  node.children.forEach((child) => collectAttachIds(child, out));
  return out;
}

export function safeUrl(input) {
  const s = decodeEntities(String(input || '')).trim().replace(/^["']|["']$/g, '');
  if (/^(https?|ftp):\/\//i.test(s)) return s;
  if (/^mailto:/i.test(s)) return s;
  if (/^www\./i.test(s)) return `http://${s}`;
  if (/^(showthread|forumdisplay|member)\.php/i.test(s)) return s;
  return null;
}

// Link cũ trỏ về chính diễn đàn (showthread.php, forumdisplay.php) → trang tương ứng trong panel.
export function internalRoute(href) {
  let url;
  try {
    url = new URL(href, 'http://local.invalid/');
  } catch {
    return null;
  }
  if (url.host !== 'local.invalid' && !/westlife/i.test(url.host)) return null;
  const leadingId = (url.search.slice(1).match(/^(\d+)/) || [])[1];
  const param = (key) => {
    const v = url.searchParams.get(key);
    return v && /^\d+$/.test(v) ? v : null;
  };
  if (/showthread\.php$/i.test(url.pathname)) {
    const p = param('p');
    if (p) return `/p/${p}`;
    const t = param('t') || leadingId;
    if (t) return `/t/${t}`;
  }
  if (/forumdisplay\.php$/i.test(url.pathname)) {
    const f = param('f') || leadingId;
    if (f) return `/f/${f}`;
  }
  return null;
}
