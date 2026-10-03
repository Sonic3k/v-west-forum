import { Router } from 'express';
import { q } from '../db.js';
import { getLookups, mapThread, THREAD_COLS } from '../lookups.js';
import { fold, getUsers, nameRef } from '../users.js';
import { clean, toInt } from '../text.js';
import { escapeLike, foldSame, makeSnippet, parseTerms, stripForSearch } from '../textsearch.js';
import { searchStatus, startSearchIndex } from '../searchIndex.js';

// Nếu lần dựng chỉ mục trước bị lỗi (ví dụ database chưa sẵn sàng lúc khởi động) thì thử lại.
function retryIfNeeded() {
  if (searchStatus.state === 'error' || searchStatus.state === 'idle') startSearchIndex();
}

export const searchRouter = Router();

const PER_PAGE = 20;
const VN_OFFSET = 7 * 3600;

function paging(req, total) {
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);
  return { page, pages, offset: (page - 1) * PER_PAGE };
}

function forumSubtree(lk, id) {
  const out = [];
  const walk = (fid) => {
    out.push(fid);
    for (const c of lk.forums.get(fid)?.childIds || []) walk(c);
  };
  if (lk.forums.has(id)) walk(id);
  return out;
}

// Người viết: khớp đúng tên trước (không phân biệt dấu), không có thì tìm tên chứa chuỗi đó.
function resolveAuthors(users, name) {
  const f = fold(name.trim());
  if (!f) return null;
  const exact = users.list.filter((u) => u.fold === f).map((u) => u.id);
  if (exact.length) return exact;
  return users.list.filter((u) => u.fold.includes(f)).slice(0, 50).map((u) => u.id);
}

function yearRange(year) {
  const y = toInt(year);
  if (!y || y < 1990 || y > 2100) return null;
  return [Date.UTC(y, 0, 1) / 1000 - VN_OFFSET, Date.UTC(y + 1, 0, 1) / 1000 - VN_OFFSET];
}

async function filters(req) {
  const [lk, users] = await Promise.all([getLookups(), getUsers()]);
  const terms = parseTerms(req.query.q);
  const author = String(req.query.author || '').trim();
  const authorIds = author ? resolveAuthors(users, author) : null;
  const forumId = toInt(req.query.forum);
  const forumIds = forumId ? forumSubtree(lk, forumId) : null;
  const years = yearRange(req.query.year);
  const sort = req.query.sort === 'old' ? 'old' : 'new';
  return { lk, users, terms, author, authorIds, forumIds, years, sort };
}

let yearsCache = null;

// Dữ liệu cho bộ lọc: các năm có bài và cây box.
searchRouter.get('/meta', async (req, res) => {
  const lk = await getLookups();
  if (!yearsCache) {
    const [r] = await q('SELECT MIN(dateline) AS a, MAX(dateline) AS b FROM post WHERE dateline > 0');
    const from = new Date((r.a + VN_OFFSET) * 1000).getUTCFullYear();
    const to = new Date((r.b + VN_OFFSET) * 1000).getUTCFullYear();
    yearsCache = [];
    for (let y = to; y >= from; y -= 1) yearsCache.push(y);
  }
  const forums = [];
  const walk = (id, depth) => {
    const f = lk.forums.get(id);
    forums.push({ id, title: f.title, depth });
    f.childIds.forEach((c) => walk(c, depth + 1));
  };
  lk.roots.forEach((id) => walk(id, 0));
  res.json({ years: yearsCache, forums, status: searchStatus });
});

searchRouter.get('/status', (req, res) => {
  retryIfNeeded();
  res.json(searchStatus);
});

// Tìm trong nội dung bài viết (bảng panel_post_search đã bỏ dấu).
searchRouter.get('/posts', async (req, res) => {
  retryIfNeeded();
  if (searchStatus.state !== 'ready') {
    res.status(503).json({ error: 'Dữ liệu tìm kiếm đang được chuẩn bị.', status: searchStatus });
    return;
  }
  const f = await filters(req);
  if (!f.terms.length) {
    res.status(400).json({ error: 'Nhập từ khóa để tìm.' });
    return;
  }
  if (f.authorIds && !f.authorIds.length) {
    res.json({ total: 0, page: 1, pages: 1, results: [], note: `Không có thành viên nào tên "${f.author}".` });
    return;
  }

  const where = [];
  const params = [];
  for (const t of f.terms) {
    where.push('folded LIKE ?');
    params.push(Buffer.from(`%${escapeLike(t)}%`, 'utf8'));
  }
  if (f.authorIds) {
    where.push('userid IN (?)');
    params.push(f.authorIds);
  }
  if (f.forumIds) {
    where.push('forumid IN (?)');
    params.push(f.forumIds);
  }
  if (f.years) {
    where.push('dateline >= ? AND dateline < ?');
    params.push(...f.years);
  }
  const whereSql = where.join(' AND ');
  const [{ n: total }] = await q(`SELECT COUNT(*) AS n FROM panel_post_search WHERE ${whereSql}`, params);
  const { page, pages, offset } = paging(req, total);
  const order = f.sort === 'old' ? 'dateline ASC, postid ASC' : 'dateline DESC, postid DESC';
  const idRows = total
    ? await q(`SELECT postid FROM panel_post_search WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, PER_PAGE, offset])
    : [];
  const ids = idRows.map((r) => r.postid);

  const posts = ids.length
    ? await q(
      `SELECT p.postid, p.threadid, p.userid, p.username, p.title, p.dateline, p.pagetext, p.visible,
              t.title AS threadtitle, t.forumid
         FROM post p LEFT JOIN thread t ON t.threadid = p.threadid
        WHERE p.postid IN (?)`,
      [ids],
    )
    : [];
  const byId = new Map(posts.map((p) => [p.postid, p]));
  const results = ids.filter((id) => byId.has(id)).map((id) => {
    const p = byId.get(id);
    const text = stripForSearch(`${p.title ? `${p.title}. ` : ''}${p.pagetext || ''}`);
    return {
      postId: p.postid,
      threadId: p.threadid,
      threadTitle: clean(p.threadtitle) || `Chủ đề #${p.threadid}`,
      forum: f.lk.forums.has(p.forumid) ? { id: p.forumid, title: f.lk.forums.get(p.forumid).title } : null,
      author: nameRef(f.lk, f.users, p.userid, p.username),
      dateline: p.dateline,
      visible: p.visible,
      snippet: makeSnippet(text, f.terms),
    };
  });

  res.json({ total, page, pages, terms: f.terms, results });
});

// Tìm theo tiêu đề chủ đề (khoảng 5.000 chủ đề, lọc trong bộ nhớ).
let threadsCache = null;

async function allThreads(lk) {
  if (!threadsCache) {
    threadsCache = q(`SELECT ${THREAD_COLS} FROM thread`).then((rows) =>
      rows.map((r) => {
        const t = mapThread(lk, r);
        return { ...t, forumTitle: lk.forums.get(t.forumId)?.title || null, folded: foldSame(t.title) };
      }),
    ).catch((err) => {
      threadsCache = null;
      throw err;
    });
  }
  return threadsCache;
}

searchRouter.get('/threads', async (req, res) => {
  const f = await filters(req);
  if (!f.terms.length && !f.authorIds) {
    res.status(400).json({ error: 'Nhập từ khóa hoặc tên người lập chủ đề.' });
    return;
  }
  const threads = await allThreads(f.lk);
  const authorSet = f.authorIds ? new Set(f.authorIds) : null;
  const forumSet = f.forumIds ? new Set(f.forumIds) : null;
  let list = threads.filter((t) =>
    f.terms.every((term) => t.folded.includes(term))
    && (!authorSet || authorSet.has(t.starter.userId))
    && (!forumSet || forumSet.has(t.forumId))
    && (!f.years || (t.dateline >= f.years[0] && t.dateline < f.years[1])));
  list = list.sort((a, b) => (f.sort === 'old' ? a.dateline - b.dateline : b.dateline - a.dateline));
  const { page, pages, offset } = paging(req, list.length);
  res.json({
    total: list.length,
    page,
    pages,
    terms: f.terms,
    threads: list.slice(offset, offset + PER_PAGE).map(({ folded, ...t }) => ({
      ...t,
      titleMarks: makeSnippet(t.title, f.terms, 1000).marks,
    })),
  });
});
