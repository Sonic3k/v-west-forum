import { Router } from 'express';
import { q } from '../db.js';
import { getLookups, breadcrumb, mapThread, mapUser, THREAD_COLS } from '../lookups.js';
import { avatarUrl, getAssets } from '../assets.js';
import { clean, toInt } from '../text.js';

export const threadsRouter = Router();
export const postsRouter = Router();

export const POSTS_PER_PAGE = 20;
const EXPORT_LIMIT = 5000;
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);

async function loadThread(lk, id) {
  const rows = await q(`SELECT ${THREAD_COLS} FROM thread WHERE threadid = ?`, [id]);
  return rows.length ? { row: rows[0], thread: mapThread(lk, rows[0]) } : null;
}

function threadEnvelope(lk, thread) {
  const forum = lk.forums.get(thread.forumId);
  return {
    thread,
    forum: forum ? { id: forum.id, title: forum.title } : null,
    breadcrumb: forum ? [...breadcrumb(lk, forum.id), { id: forum.id, title: forum.title }] : [],
  };
}

// Bài viết của một chủ đề kèm người viết, chữ ký, đính kèm, cảm ơn, bình luận.
async function loadPosts(lk, threadId, offset, limit) {
  const postRows = await q(
    `SELECT postid, parentid, username, userid, title, dateline, pagetext, visible, attach, showsignature
       FROM post
      WHERE threadid = ?
      ORDER BY dateline, postid
      LIMIT ? OFFSET ?`,
    [threadId, limit, offset],
  );
  const postIds = postRows.map((p) => p.postid);
  const userIds = [...new Set(postRows.map((p) => p.userid).filter((uid) => uid > 0))];
  const [assets, users, signatures, attachments, thanks, comments] = await Promise.all([
    getAssets(),
    userIds.length
      ? q(`SELECT userid, username, usertitle, joindate, posts, usergroupid, displaygroupid, reputation, avatarid
             FROM user WHERE userid IN (?)`, [userIds])
      : [],
    userIds.length
      ? q('SELECT userid, signature FROM usertextfield WHERE userid IN (?)', [userIds])
      : [],
    loadAttachments(lk, postIds),
    postIds.length
      ? q('SELECT postid, userid, username, date FROM post_thanks WHERE postid IN (?) ORDER BY date, id', [postIds])
      : [],
    postIds.length
      ? q(`SELECT c.id, c.postid, c.userid, u.username, c.comment, c.dateline
             FROM vbcomment c
             LEFT JOIN user u ON u.userid = c.userid
            WHERE c.postid IN (?)
            ORDER BY c.dateline, c.id`, [postIds]).catch(() => [])
      : [],
  ]);

  const userMap = new Map(users.map((u) => [u.userid, { ...mapUser(lk, u), avatar: avatarUrl(assets, u.userid, u.avatarid) }]));
  const sigMap = new Map(signatures.map((s) => [s.userid, s.signature || '']));
  const thanksBy = groupBy(thanks, (t) => t.postid);
  const commentsBy = groupBy(comments, (c) => c.postid);
  const attachBy = groupBy(attachments, (a) => a.postId);

  return postRows.map((p, i) => ({
    id: p.postid,
    number: offset + i + 1,
    dateline: p.dateline,
    title: clean(p.title),
    pagetext: p.pagetext || '',
    visible: p.visible,
    author: userMap.get(p.userid) || null,
    username: clean(p.username),
    signature: p.showsignature && sigMap.get(p.userid) ? sigMap.get(p.userid) : null,
    attachments: attachBy.get(p.postid) || [],
    thanks: (thanksBy.get(p.postid) || []).map((t) => ({
      userId: t.userid, username: clean(t.username), date: t.date,
    })),
    comments: (commentsBy.get(p.postid) || []).map((c) => ({
      id: c.id, userId: c.userid, username: clean(c.username) || `#${c.userid}`, text: c.comment || '', dateline: c.dateline,
    })),
  }));
}

threadsRouter.get('/:id', async (req, res) => {
  const lk = await getLookups();
  const found = await loadThread(lk, toInt(req.params.id));
  if (!found) {
    res.status(404).json({ error: 'Không tìm thấy chủ đề này.' });
    return;
  }
  const { row, thread } = found;
  if (thread.movedTo) {
    res.json({ redirect: thread.movedTo });
    return;
  }
  const [{ n: total }] = await q('SELECT COUNT(*) AS n FROM post WHERE threadid = ?', [thread.id]);
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);
  const [posts, poll] = await Promise.all([
    loadPosts(lk, thread.id, (page - 1) * POSTS_PER_PAGE, POSTS_PER_PAGE),
    row.pollid > 0 ? loadPoll(row.pollid) : null,
  ]);
  res.json({ ...threadEnvelope(lk, thread), poll, page, pages, total, posts });
});

// Toàn bộ chủ đề trong một lần (dùng cho trang xuất file).
threadsRouter.get('/:id/all', async (req, res) => {
  const lk = await getLookups();
  const found = await loadThread(lk, toInt(req.params.id));
  if (!found) {
    res.status(404).json({ error: 'Không tìm thấy chủ đề này.' });
    return;
  }
  const { row, thread } = found;
  if (thread.movedTo) {
    res.json({ redirect: thread.movedTo });
    return;
  }
  const [posts, poll] = await Promise.all([
    loadPosts(lk, thread.id, 0, EXPORT_LIMIT),
    row.pollid > 0 ? loadPoll(row.pollid) : null,
  ]);
  res.json({ ...threadEnvelope(lk, thread), poll, total: posts.length, posts });
});

// Tìm chủ đề và trang chứa một bài viết (dùng cho link "bài mới nhất", trích dẫn...).
postsRouter.get('/:id/locate', async (req, res) => {
  const id = toInt(req.params.id);
  const rows = await q('SELECT postid, threadid, dateline FROM post WHERE postid = ?', [id]);
  if (!rows.length) {
    res.status(404).json({ error: 'Không tìm thấy bài viết này.' });
    return;
  }
  const p = rows[0];
  const [{ n }] = await q(
    `SELECT COUNT(*) AS n FROM post
      WHERE threadid = ? AND (dateline < ? OR (dateline = ? AND postid < ?))`,
    [p.threadid, p.dateline, p.dateline, p.postid],
  );
  res.json({ postId: p.postid, threadId: p.threadid, page: Math.floor(n / POSTS_PER_PAGE) + 1 });
});

async function loadAttachments(lk, postIds) {
  if (!postIds.length || lk.postContentType == null) return [];
  const rows = await q(
    `SELECT a.attachmentid, a.contentid, a.filename, a.counter, a.state,
            fd.filesize, fd.extension, fd.width, fd.height, fd.thumbnail_filesize
       FROM attachment a
       LEFT JOIN filedata fd ON fd.filedataid = a.filedataid
      WHERE a.contenttypeid = ? AND a.contentid IN (?)
      ORDER BY a.displayorder, a.attachmentid`,
    [lk.postContentType, postIds],
  );
  return rows.map((a) => {
    const ext = String(a.extension || '').toLowerCase();
    return {
      id: a.attachmentid,
      postId: a.contentid,
      filename: clean(a.filename),
      extension: ext,
      isImage: IMAGE_EXT.has(ext),
      size: a.filesize || 0,
      width: a.width || null,
      height: a.height || null,
      hasThumb: (a.thumbnail_filesize || 0) > 0,
      views: a.counter,
    };
  });
}

async function loadPoll(pollId) {
  const rows = await q(
    'SELECT pollid, question, dateline, options, votes, active, timeout, multiple, voters FROM poll WHERE pollid = ?',
    [pollId],
  );
  if (!rows.length) return null;
  const p = rows[0];
  const options = String(p.options || '').split('|||');
  const votes = String(p.votes || '').split('|||').map((v) => Number.parseInt(v, 10) || 0);
  return {
    question: clean(p.question),
    options: options.map((text, i) => ({ text: clean(text), votes: votes[i] || 0 })),
    voters: p.voters,
    active: Boolean(p.active),
    multiple: Boolean(p.multiple),
    dateline: p.dateline,
    timeout: p.timeout,
  };
}

function groupBy(list, keyFn) {
  const map = new Map();
  for (const item of list) {
    const key = keyFn(item);
    const arr = map.get(key);
    if (arr) arr.push(item);
    else map.set(key, [item]);
  }
  return map;
}
