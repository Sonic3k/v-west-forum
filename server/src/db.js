import mysql from 'mysql2/promise';

// Dữ liệu vBulletin cũ: cột khai báo latin1 nhưng thực chất chứa byte UTF-8.
// Kết nối với charset BINARY để MySQL trả nguyên byte (không chuyển đổi),
// rồi tự giải mã UTF-8 ở đây. Byte lỗi sẽ thành ký tự thay thế (U+FFFD).
//
// Lưu ý: vì kết nối là BINARY, tham số chứa chữ có dấu (khi làm tìm kiếm)
// phải truyền dạng Buffer, ví dụ Buffer.from(text, 'utf8').
const TEXT_TYPES = new Set([
  'VAR_STRING', 'STRING', 'VARCHAR',
  'BLOB', 'TINY_BLOB', 'MEDIUM_BLOB', 'LONG_BLOB',
  'ENUM', 'SET', 'JSON',
]);

function utf8Cast(field, next) {
  if (TEXT_TYPES.has(field.type)) {
    const buf = field.buffer();
    return buf === null ? null : buf.toString('utf8');
  }
  return next();
}

function rawCast(field, next) {
  if (TEXT_TYPES.has(field.type)) return field.buffer();
  return next();
}

const uri = process.env.DATABASE_URL || process.env.MYSQL_URL;
if (!uri) {
  console.warn('Chưa có biến DATABASE_URL: panel sẽ không đọc được database.');
}

export const pool = mysql.createPool({
  uri,
  charset: 'BINARY',
  typeCast: utf8Cast,
  connectionLimit: 5,
  waitForConnections: true,
  enableKeepAlive: true,
});

// Chuỗi đã giải mã UTF-8.
export async function q(sql, params = []) {
  const [rows] = await pool.query(sql, params);
  return rows;
}

// Giữ nguyên Buffer (dùng cho file đính kèm).
export async function qRaw(sql, params = []) {
  const [rows] = await pool.query({ sql, typeCast: rawCast }, params);
  return rows;
}
