import { decodeEntities } from './text.js';

const MARKS = /[\u0300-\u036f]/g;
const foldCache = new Map();

function foldChar(ch) {
  if (ch.charCodeAt(0) < 128) return ch.toLowerCase();
  let v = foldCache.get(ch);
  if (v === undefined) {
    if (ch === 'đ' || ch === 'Đ') v = 'd';
    else {
      const base = ch.normalize('NFD').replace(MARKS, '').toLowerCase();
      if (base.length === ch.length) v = base;
      else {
        const lower = ch.toLowerCase();
        v = lower.length === ch.length ? lower : ch;
      }
    }
    if (foldCache.size < 20000) foldCache.set(ch, v);
  }
  return v;
}

// Bỏ dấu, chữ thường, đ → d. Giữ nguyên độ dài chuỗi để tô sáng đúng vị trí trong bản gốc.
export function foldSame(input) {
  const parts = [];
  for (const ch of String(input || '')) parts.push(foldChar(ch));
  return parts.join('');
}

// Nội dung bài để tìm: bỏ thẻ BBCode (giữ chữ bên trong), bỏ link ảnh/đính kèm, gộp khoảng trắng.
export function stripForSearch(text) {
  return decodeEntities(
    String(text || '')
      .replace(/\[(attach|img|video|youtube)[^\]]*\][\s\S]*?\[\/\1\]/gi, ' ')
      .replace(/\[\/?[a-zA-Z*]+(?:=[^\]]*)?\]/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

// "sinh nhật" (trong ngoặc kép) là một cụm; các từ rời phải cùng xuất hiện.
export function parseTerms(query) {
  const terms = [];
  const re = /"([^"]+)"|(\S+)/g;
  let m;
  while ((m = re.exec(String(query || '')))) {
    const t = foldSame((m[1] || m[2]).replace(/\s+/g, ' ').trim());
    if (t && !terms.includes(t)) terms.push(t);
  }
  return terms.slice(0, 8);
}

export function escapeLike(term) {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// Đoạn trích quanh chỗ khớp đầu tiên, kèm vị trí cần tô sáng.
export function makeSnippet(text, terms, radius = 110) {
  const folded = foldSame(text);
  let first = -1;
  for (const t of terms) {
    const i = folded.indexOf(t);
    if (i >= 0 && (first < 0 || i < first)) first = i;
  }
  let start = 0;
  let end = Math.min(text.length, radius * 2);
  if (first >= 0) {
    start = Math.max(0, first - radius);
    end = Math.min(text.length, first + radius);
    if (start > 0) {
      const sp = text.indexOf(' ', start);
      if (sp > -1 && sp < first) start = sp + 1;
    }
  }
  if (end < text.length) {
    const sp = text.lastIndexOf(' ', end);
    if (sp > Math.max(start, first)) end = sp;
  }
  const part = folded.slice(start, end);
  const marks = [];
  for (const t of terms) {
    let i = part.indexOf(t);
    while (i >= 0) {
      marks.push([i, i + t.length]);
      i = part.indexOf(t, i + t.length);
    }
  }
  marks.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const mk of marks) {
    const last = merged[merged.length - 1];
    if (last && mk[0] <= last[1]) last[1] = Math.max(last[1], mk[1]);
    else merged.push([...mk]);
  }
  return { text: text.slice(start, end), before: start > 0, after: end < text.length, marks: merged };
}
