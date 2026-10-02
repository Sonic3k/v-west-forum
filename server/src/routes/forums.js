import { Router } from 'express';
import { q } from '../db.js';
import {
  getLookups, forumTree, breadcrumb, mapThread, loadAnnouncements, THREAD_COLS,
} from '../lookups.js';
import { toInt } from '../text.js';

export const forumsRouter = Router();

const PER_PAGE = 30;
const SORTS = {
  lastpost: 'lastpost DESC, threadid DESC',
  dateline: 'dateline DESC, threadid DESC',
  replies: 'replycount DESC, lastpost DESC',
  views: 'views DESC, lastpost DESC',
};

// Trang chủ: cây box (danh mục → box → box con) và thông báo chung.
forumsRouter.get('/', async (req, res) => {
  const lk = await getLookups();
  const announcements = await loadAnnouncements([-1]);
  res.json({
    forums: lk.roots.map((id) => forumTree(lk, id, 2)),
    superModerators: lk.moderators.get(-1) || [],
    announcements,
  });
});

// Một box: box con, thông báo, chủ đề dán và chủ đề thường.
forumsRouter.get('/:id', async (req, res) => {
  const lk = await getLookups();
  const id = toInt(req.params.id);
  if (!lk.forums.has(id)) {
    res.status(404).json({ error: 'Không tìm thấy box này.' });
    return;
  }

  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'lastpost';
  const [[{ n: total }], [{ n: stickyTotal }]] = await Promise.all([
    q('SELECT COUNT(*) AS n FROM thread WHERE forumid = ? AND sticky = 0', [id]),
    q('SELECT COUNT(*) AS n FROM thread WHERE forumid = ? AND sticky <> 0', [id]),
  ]);
  const pages = Math.max(1, Math.ceil(total / PER_PAGE));
  const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);

  const [stickyRows, threadRows, announcements] = await Promise.all([
    page === 1
      ? q(`SELECT ${THREAD_COLS} FROM thread WHERE forumid = ? AND sticky <> 0 ORDER BY lastpost DESC`, [id])
      : Promise.resolve([]),
    q(
      `SELECT ${THREAD_COLS} FROM thread WHERE forumid = ? AND sticky = 0
        ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`,
      [id, PER_PAGE, (page - 1) * PER_PAGE],
    ),
    loadAnnouncements([id]),
  ]);

  res.json({
    forum: forumTree(lk, id, 2),
    breadcrumb: breadcrumb(lk, id),
    announcements,
    sort,
    page,
    pages,
    total,
    stickyTotal,
    stickies: stickyRows.map((r) => mapThread(lk, r)),
    threads: threadRows.map((r) => mapThread(lk, r)),
  });
});
