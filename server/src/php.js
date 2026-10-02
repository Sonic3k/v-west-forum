import { clean } from './text.js';

// vBulletin lưu một số cột dạng PHP serialize, ví dụ:
//   touserarray: a:1:{s:2:"cc";a:1:{i:5;s:4:"Name";}}  (vB4)  hoặc  a:1:{i:5;s:4:"Name";}  (vB3)
//   pmfolders:   a:2:{i:1;s:7:"Kỷ niệm";i:2;s:4:"Misc";}
// Độ dài chuỗi trong PHP tính theo byte nên phải phân tích trên Buffer.
export function phpUnserialize(input) {
  if (input == null || input === '') return null;
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  let pos = 0;

  const readUntil = (ch) => {
    const end = buf.indexOf(ch, pos);
    if (end < 0) throw new Error('unexpected end');
    const s = buf.toString('latin1', pos, end);
    pos = end + 1;
    return s;
  };

  const parse = () => {
    const type = String.fromCharCode(buf[pos]);
    if (type === 'N') {
      pos += 2;
      return null;
    }
    pos += 2;
    switch (type) {
      case 'b': return readUntil(';') === '1';
      case 'i': return Number.parseInt(readUntil(';'), 10);
      case 'd': return Number.parseFloat(readUntil(';'));
      case 's': {
        const len = Number.parseInt(readUntil(':'), 10);
        pos += 1;
        const s = buf.toString('utf8', pos, pos + len);
        pos += len + 2;
        return s;
      }
      case 'a': {
        const count = Number.parseInt(readUntil(':'), 10);
        pos += 1;
        const out = {};
        for (let i = 0; i < count; i += 1) {
          const key = parse();
          out[key] = parse();
        }
        pos += 1;
        return out;
      }
      default:
        throw new Error(`unsupported type ${type}`);
    }
  };

  try {
    return parse();
  } catch {
    return null;
  }
}

// Danh sách người nhận tin nhắn riêng: [{ userId, username }].
export function parseRecipients(touserarray) {
  const data = phpUnserialize(touserarray);
  if (!data || typeof data !== 'object') return [];
  const groups = data.cc || data.bcc ? [data.cc, data.bcc] : [data];
  const out = [];
  for (const group of groups) {
    if (!group || typeof group !== 'object') continue;
    for (const [id, name] of Object.entries(group)) {
      const userId = Number.parseInt(id, 10);
      if (Number.isInteger(userId) && !out.some((r) => r.userId === userId)) {
        out.push({ userId, username: clean(typeof name === 'string' ? name : '') });
      }
    }
  }
  return out;
}

// Thư mục hòm thư tự tạo: Map(folderId → tên).
export function parseFolders(pmfolders) {
  const data = phpUnserialize(pmfolders);
  const map = new Map();
  if (data && typeof data === 'object') {
    for (const [id, name] of Object.entries(data)) {
      const folderId = Number.parseInt(id, 10);
      if (Number.isInteger(folderId)) map.set(folderId, clean(String(name ?? '')));
    }
  }
  return map;
}
