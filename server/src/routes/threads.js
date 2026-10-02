import { Router } from 'express';
import { q } from '../db.js';
import { getLookups, breadcrumb, mapThread, mapUser, THREAD_COLS } from '../lookups.js';
import { clean, toInt } from '../text.js';

export const threadsRouter = Router();
export const postsRouter = Router();

export const POSTS_PER_PAGE = 20;
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp']);

threadsRouter.get('/:id', async (req, res) => {
  const lk = await getLookups();
  const id = toInt(req.params.id);
  const rows = await q(`SELECT ${THREAD_COLS} FROM thread WHERE threadid = ?`, [id]);
  if (!rows.length) {
    res.status(404).json({ error: 'Không tìm thấy chủ đề này.' });
    return;
  }
  const thread = mapThread(lk, rows[0]);
  if (thread.movedTo) {
    res.json({ redirect: thread.movedTo });
    return;
  }

  const [{ n: total }] = await q('SELECT COUNT(*) AS n FROM post WHERE threadid = ?', [id]);
  const pages = Math.max(1, Math.ceil(total / POSTS_PER_PAGE));
  const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);
  const offset = (page - 1) * POSTS_PER_PAGE;

  const postRows = await q(
    `SELECT postid, parentid, username, userid, title, dateline, pagetext, visible, attach, showsignature
       FROM post
      WHERE threadid = ?
      ORDER BY dateline, postid
      LIMIT ? OFFSET ?`,
    [id, POSTS_PER_PAGE, offset],
  );

  const postIds = postRows.map((p) => p.postid);
  const userIds = [...new Set(postRows.map((p) => p.userid).filter((uid) => uid > 0))];
  const [users, signatures, attachments, thanks, comments, poll] = await Promise.all([
    userIds.length
      ? q(`SELECT userid, username, usertitle, joindate, posts, usergroupid, displaygroupid, reputation
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
    rows[0].pollid > 0 ? loadPoll(rows[0].pollid) : null,
  ]);

  const userMap = new Map(users.map((u) => [u.userid, mapUser(lk, u)]));
  const sigMap = new Map(signatures.map((s) => [s.userid, s.signature || '']));
  const thanksBy = groupBy(thanks, (t) => t.postid);
  const commentsBy = groupBy(comments, (c) => c.postid);
  const attachBy = groupBy(attachments, (a) => a.postId);

  const posts = postRows.map((p, i) => ({
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

  const forum = lk.forums.get(thread.forumId);
  res.json({
    thread,
    forum: forum ? { id: forum.id, title: forum.title } : null,
    breadcrumb: forum ? [...breadcrumb(lk, forum.id), { id: forum.id, title: forum.title }] : [],
    poll,
    page,
    pages,
    total,
    posts,
  });
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
