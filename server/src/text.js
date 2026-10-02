// vBulletin lưu tiêu đề, tên thành viên... dưới dạng đã escape HTML (&quot;, &amp;...).
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

export function decodeEntities(input) {
  if (input == null) return '';
  return String(input).replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = hex ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
    }
    const value = NAMED[code.toLowerCase()];
    return value === undefined ? match : value;
  });
}

export function stripTags(input) {
  return input == null ? '' : String(input).replace(/<[^>]*>/g, '');
}

// Dùng cho tiêu đề, tên box, tên thành viên: bỏ thẻ HTML rồi giải mã entity.
export function clean(input) {
  return decodeEntities(stripTags(input)).trim();
}

export function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}
