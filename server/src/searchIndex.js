import { pool, q } from './db.js';
import { foldSame, stripForSearch } from './textsearch.js';

// Bảng phụ panel_post_search: nội dung bài đã bỏ dấu, chữ thường, để tìm nhanh và không phân biệt dấu.
// Chỉ thêm bảng mới (tiền tố panel_), không sửa bảng gốc của vBulletin.
// Tự dựng lại khi số bài thay đổi hoặc khi đổi VERSION (đổi cách bỏ dấu).
const VERSION = 1;
const BATCH = 1000;

export const searchStatus = { state: 'idle', done: 0, total: 0, error: null };

export function startSearchIndex() {
  if (searchStatus.state === 'building' || searchStatus.state === 'ready') return;
  searchStatus.state = 'building';
  searchStatus.error = null;
  build()
    .then(() => {
      searchStatus.state = 'ready';
      console.log(`Chỉ mục tìm kiếm sẵn sàng (${searchStatus.total} bài).`);
    })
    .catch((err) => {
      console.error('Không dựng được chỉ mục tìm kiếm:', err);
      searchStatus.state = 'error';
      searchStatus.error = err.code ? `${err.code}: ${err.message}` : err.message;
    });
}

async function build() {
  await q(`CREATE TABLE IF NOT EXISTS panel_meta (
             k VARCHAR(64) NOT NULL PRIMARY KEY,
             v VARCHAR(255) NOT NULL
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS panel_post_search (
             postid INT UNSIGNED NOT NULL PRIMARY KEY,
             threadid INT UNSIGNED NOT NULL,
             userid INT UNSIGNED NOT NULL,
             forumid INT NOT NULL,
             dateline INT UNSIGNED NOT NULL,
             visible SMALLINT NOT NULL,
             folded MEDIUMTEXT NOT NULL,
             KEY dateline (dateline)
           ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`);

  const [{ n, m }] = await q('SELECT COUNT(*) AS n, COALESCE(MAX(postid), 0) AS m FROM post');
  const signature = `${VERSION}:${n}:${m}`;
  searchStatus.total = n;
  const meta = await q("SELECT v FROM panel_meta WHERE k = 'search'");
  if (meta[0]?.v === signature) {
    searchStatus.done = n;
    return;
  }

  console.log(`Đang dựng chỉ mục tìm kiếm cho ${n} bài...`);
  await q('TRUNCATE TABLE panel_post_search');
  searchStatus.done = 0;
  let last = 0;
  for (;;) {
    const rows = await q(
      `SELECT p.postid, p.threadid, p.userid, p.dateline, p.visible, p.title, p.pagetext, t.forumid
         FROM post p
         LEFT JOIN thread t ON t.threadid = p.threadid
        WHERE p.postid > ?
        ORDER BY p.postid
        LIMIT ?`,
      [last, BATCH],
    );
    if (!rows.length) break;
    const values = rows.map((r) => [
      r.postid,
      r.threadid || 0,
      r.userid || 0,
      r.forumid ?? 0,
      r.dateline || 0,
      r.visible ?? 1,
      // Kết nối dùng charset BINARY: chữ có dấu phải gửi dạng Buffer.
      Buffer.from(foldSame(stripForSearch(`${r.title || ''} ${r.pagetext || ''}`)), 'utf8'),
    ]);
    await pool.query(
      'INSERT INTO panel_post_search (postid, threadid, userid, forumid, dateline, visible, folded) VALUES ?',
      [values],
    );
    last = rows[rows.length - 1].postid;
    searchStatus.done += rows.length;
  }
  await q("REPLACE INTO panel_meta (k, v) VALUES ('search', ?)", [signature]);
}
