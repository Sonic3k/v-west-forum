import { Router } from 'express';
import { q } from '../db.js';
import { getLookups, mapThread, moderatedBy, THREAD_COLS } from '../lookups.js';
import { fold, getUsers, groupOf, nameRef, userBrief } from '../users.js';
import { clean, decodeEntities, toInt } from '../text.js';
import { parseFolders, parseRecipients } from '../php.js';

export const usersRouter = Router();

const LIST_PER_PAGE = 40;
const PER_PAGE = 20;
const CONVERSATION_LIMIT = 1000;

const SORTS = {
  posts: (a, b) => b.posts - a.posts || a.id - b.id,
  joined_new: (a, b) => b.joinDate - a.joinDate || b.id - a.id,
  joined_old: (a, b) => a.joinDate - b.joinDate || a.id - b.id,
  active: (a, b) => b.lastActivity - a.lastActivity || a.id - b.id,
  name: (a, b) => a.username.localeCompare(b.username, 'vi'),
};

const DEFAULT_FIELD_TITLES = { field1: 'Giới thiệu', field2: 'Nơi ở', field3: 'Sở thích', field4: 'Nghề nghiệp' };

function paging(req, total, perPage) {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const page = Math.min(Math.max(toInt(req.query.page) || 1, 1), pages);
  return { page, pages, offset: (page - 1) * perPage };
}

async function context() {
  const [lk, users] = await Promise.all([getLookups(), getUsers()]);
  return { lk, users };
}

function snippet(text, max = 240) {
  const s = decodeEntities(String(text || '')
    .replace(/\[(attach|img|video|youtube)[^\]]*\][\s\S]*?\[\/\1\]/gi, ' ')
    .replace(/\[\/?[a-zA-Z*]+(?:=[^\]]*)?\]/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max).trimEnd()}…` : s;
}

// vBulletin lưu ngày sinh dạng mm-dd-yyyy (năm 0000 = không ghi năm).
function formatBirthday(value) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value || '');
  if (!m || m[1] === '00') return null;
  return m[3] === '0000' ? `${m[2]}/${m[1]}` : `${m[2]}/${m[1]}/${m[3]}`;
}

// Danh sách thành viên: tìm theo tên (không phân biệt dấu), lọc nhóm, sắp xếp.
usersRouter.get('/', async (req, res) => {
  const { lk, users } = await context();
  const term = fold(String(req.query.q || '').trim());
  const group = toInt(req.query.group);
  const sort = Object.hasOwn(SORTS, req.query.sort) ? req.query.sort : 'posts';

  let list = users.list;
  if (term) list = list.filter((u) => u.fold.includes(term));
  if (group) list = list.filter((u) => u.usergroupid === group || u.membergroupids.includes(group));
  list = [...list].sort(SORTS[sort]);

  const counts = new Map();
  for (const u of users.list) counts.set(u.usergroupid, (counts.get(u.usergroupid) || 0) + 1);
  const groups = [...counts.entries()]
    .map(([id, count]) => ({ id, count, title: lk.groups.get(id)?.title || `Nhóm #${id}` }))
    .sort((a, b) => b.count - a.count);

  const { page, pages, offset } = paging(req, list.length, LIST_PER_PAGE);
  res.json({
    total: list.length,
    page,
    pages,
    sort,
    groups,
    users: list.slice(offset, offset + LIST_PER_PAGE).map((u) => userBrief(lk, u)),
  });
});

// Hồ sơ đầy đủ (trừ mật khẩu, salt, IP).
usersRouter.get('/:id', async (req, res) => {
  const { lk, users } = await context();
  const id = toInt(req.params.id);
  const rows = await q(
    `SELECT userid, username, usergroupid, membergroupids, displaygroupid, email, homepage,
            icq, aim, yahoo, msn, skype, fbname, usertitle, joindate, lastvisit, lastactivity,
            lastpost, lastpostid, posts, reputation, birthday, referrerid, profilevisits, friendcount,
            infractions, warnings, post_thanks_user_amount, post_thanks_thanked_posts,
            post_thanks_thanked_times, timespentonline, dbtech_status_status
       FROM user WHERE userid = ?`,
    [id],
  );
  if (!rows.length) {
    res.status(404).json({ error: 'Không tìm thấy thành viên này.' });
    return;
  }
  const u = rows[0];

  const [fieldRows, textRows, [{ n: threads }], [{ n: wallReceived }], [{ n: wallSent }], [{ n: pms }], [{ n: friends }]] =
    await Promise.all([
      q('SELECT * FROM userfield WHERE userid = ?', [id]),
      q('SELECT signature FROM usertextfield WHERE userid = ?', [id]),
      q('SELECT COUNT(*) AS n FROM thread WHERE postuserid = ?', [id]),
      q('SELECT COUNT(*) AS n FROM visitormessage WHERE userid = ?', [id]),
      q('SELECT COUNT(*) AS n FROM visitormessage WHERE postuserid = ?', [id]),
      q('SELECT COUNT(*) AS n FROM pm WHERE userid = ?', [id]),
      q("SELECT COUNT(*) AS n FROM userlist WHERE userid = ? AND type = 'buddy' AND friend = 'yes'", [id]),
    ]);

  const brief = users.byId.get(id);
  const group = brief ? groupOf(lk, brief) : lk.groups.get(u.usergroupid);
  const groupIds = [u.usergroupid, ...String(u.membergroupids || '').split(',').map((s) => toInt(s))]
    .filter((g, i, all) => Number.isInteger(g) && g > 0 && all.indexOf(g) === i);

  const fields = [];
  const fieldRow = fieldRows[0] || {};
  for (const key of Object.keys(fieldRow).filter((k) => /^field\d+$/.test(k)).sort((a, b) => toInt(a.slice(5)) - toInt(b.slice(5)))) {
    const value = decodeEntities(String(fieldRow[key] || '')).trim();
    if (value) fields.push({ title: lk.profileFields.get(key) || DEFAULT_FIELD_TITLES[key] || key, value });
  }

  const contacts = [
    ['Email', u.email],
    ['Trang web', u.homepage],
    ['Yahoo', u.yahoo],
    ['Skype', u.skype],
    ['MSN', u.msn],
    ['ICQ', u.icq],
    ['AIM', u.aim],
    ['Facebook', u.fbname],
  ]
    .map(([label, value]) => ({ label, value: clean(value) }))
    .filter((c) => c.value && c.value !== '0');

  res.json({
    user: {
      id: u.userid,
      username: clean(u.username),
      color: group?.color || null,
      title: clean(u.usertitle),
      group: group?.title || null,
      groups: groupIds.map((g) => lk.groups.get(g)?.title).filter(Boolean),
      status: clean(u.dbtech_status_status) || null,
      joinDate: u.joindate,
      lastVisit: u.lastvisit,
      lastActivity: u.lastactivity,
      lastPost: u.lastpost,
      lastPostId: u.lastpostid,
      birthday: formatBirthday(u.birthday),
      posts: u.posts,
      reputation: u.reputation,
      profileVisits: u.profilevisits,
      infractions: u.infractions,
      warnings: u.warnings,
      thanksGiven: u.post_thanks_user_amount,
      thanksReceived: u.post_thanks_thanked_times,
      thankedPosts: u.post_thanks_thanked_posts,
      timeOnline: u.timespentonline || 0,
      referrer: u.referrerid ? nameRef(lk, users, u.referrerid) : null,
      signature: textRows[0]?.signature || '',
    },
    contacts,
    fields,
    moderates: moderatedBy(lk, id),
    counts: { threads, wallReceived, wallSent, pms, friends },
  });
});

function mapWall(lk, users, m) {
  return {
    id: m.vmid,
    owner: nameRef(lk, users, m.userid),
    author: nameRef(lk, users, m.postuserid, m.postusername),
    dateline: m.dateline,
    state: m.state,
    title: clean(m.title),
    text: m.pagetext || '',
  };
}

const WALL_COLS = 'vmid, userid, postuserid, postusername, dateline, state, title, pagetext';

// Tường: tin người khác để lại (received) hoặc tin thành viên này để lại cho người khác (sent).
usersRouter.get('/:id/wall', async (req, res) => {
  const { lk, users } = await context();
  const id = toInt(req.params.id);
  const dir = req.query.dir === 'sent' ? 'sent' : 'received';
  const col = dir === 'sent' ? 'postuserid' : 'userid';
  const [{ n: total }] = await q(`SELECT COUNT(*) AS n FROM visitormessage WHERE ${col} = ?`, [id]);
  const { page, pages, offset } = paging(req, total, PER_PAGE);
  const rows = await q(
    `SELECT ${WALL_COLS} FROM visitormessage WHERE ${col} = ?
      ORDER BY dateline DESC, vmid DESC LIMIT ? OFFSET ?`,
    [id, PER_PAGE, offset],
  );
  res.json({ dir, total, page, pages, messages: rows.map((m) => mapWall(lk, users, m)) });
});

// Trò chuyện trên tường giữa hai người, theo thứ tự thời gian.
usersRouter.get('/:id/wall/:other', async (req, res) => {
  const { lk, users } = await context();
  const a = toInt(req.params.id);
  const b = toInt(req.params.other);
  const rows = await q(
    `SELECT ${WALL_COLS} FROM visitormessage
      WHERE (userid = ? AND postuserid = ?) OR (userid = ? AND postuserid = ?)
      ORDER BY dateline, vmid LIMIT ?`,
    [a, b, b, a, CONVERSATION_LIMIT],
  );
  res.json({ me: nameRef(lk, users, a), other: nameRef(lk, users, b), messages: rows.map((m) => mapWall(lk, users, m)) });
});

function mapPm(lk, users, r) {
  return {
    id: r.pmid ?? r.pmtextid,
    pmtextId: r.pmtextid,
    folder: r.folderid,
    from: nameRef(lk, users, r.fromuserid, r.fromusername),
    to: parseRecipients(r.touserarray).map((x) => nameRef(lk, users, x.userId, x.username)),
    title: clean(r.title),
    message: r.message || '',
    dateline: r.dateline,
  };
}

// Hòm thư: danh sách thư mục và tin nhắn trong một thư mục (0 = hộp đến, -1 = đã gửi).
usersRouter.get('/:id/pms', async (req, res) => {
  const { lk, users } = await context();
  const id = toInt(req.params.id);
  const [folderRows, textRows] = await Promise.all([
    q('SELECT folderid, COUNT(*) AS n FROM pm WHERE userid = ? GROUP BY folderid', [id]),
    q('SELECT pmfolders FROM usertextfield WHERE userid = ?', [id]),
  ]);
  const names = parseFolders(textRows[0]?.pmfolders);
  const counts = new Map(folderRows.map((f) => [f.folderid, f.n]));
  const ids = new Set([0, -1, ...counts.keys(), ...names.keys()]);
  const folders = [...ids]
    .sort((x, y) => (x === 0 ? -1 : y === 0 ? 1 : x === -1 ? -1 : y === -1 ? 1 : x - y))
    .map((fid) => ({
      id: fid,
      name: fid === 0 ? 'Hộp thư đến' : fid === -1 ? 'Đã gửi' : names.get(fid) || `Thư mục ${fid}`,
      count: counts.get(fid) || 0,
    }));

  const requested = toInt(req.query.folder);
  const folder = folders.some((f) => f.id === requested) ? requested : 0;
  const total = counts.get(folder) || 0;
  const { page, pages, offset } = paging(req, total, PER_PAGE);
  const rows = await q(
    `SELECT pm.pmid, pm.folderid, pt.pmtextid, pt.fromuserid, pt.fromusername, pt.title,
            pt.message, pt.touserarray, pt.dateline
       FROM pm JOIN pmtext pt ON pt.pmtextid = pm.pmtextid
      WHERE pm.userid = ? AND pm.folderid = ?
      ORDER BY pt.dateline DESC, pm.pmid DESC
      LIMIT ? OFFSET ?`,
    [id, folder, PER_PAGE, offset],
  );
  res.json({ folders, folder, total, page, pages, messages: rows.map((r) => mapPm(lk, users, r)) });
});

// Toàn bộ tin nhắn riêng qua lại giữa hai người.
usersRouter.get('/:id/pms/with/:other', async (req, res) => {
  const { lk, users } = await context();
  const a = toInt(req.params.id);
  const b = toInt(req.params.other);
  const rows = await q(
    `SELECT pt.pmtextid, pt.fromuserid, pt.fromusername, pt.title, pt.message, pt.touserarray, pt.dateline
       FROM pmtext pt
      WHERE pt.fromuserid IN (?, ?)
        AND pt.pmtextid IN (SELECT pmtextid FROM pm WHERE userid IN (?, ?))
      ORDER BY pt.dateline, pt.pmtextid
      LIMIT ?`,
    [a, b, a, b, CONVERSATION_LIMIT * 2],
  );
  const messages = rows
    .map((r) => mapPm(lk, users, r))
    .filter((m) => {
      const other = m.from.userId === a ? b : a;
      return m.to.some((t) => t.userId === other);
    })
    .slice(0, CONVERSATION_LIMIT);
  res.json({ me: nameRef(lk, users, a), other: nameRef(lk, users, b), messages });
});

// Chủ đề thành viên đã lập.
usersRouter.get('/:id/threads', async (req, res) => {
  const { lk } = await context();
  const id = toInt(req.params.id);
  const [{ n: total }] = await q('SELECT COUNT(*) AS n FROM thread WHERE postuserid = ?', [id]);
  const { page, pages, offset } = paging(req, total, PER_PAGE);
  const rows = await q(
    `SELECT ${THREAD_COLS} FROM thread WHERE postuserid = ?
      ORDER BY dateline DESC, threadid DESC LIMIT ? OFFSET ?`,
    [id, PER_PAGE, offset],
  );
  res.json({
    total,
    page,
    pages,
    threads: rows.map((r) => ({ ...mapThread(lk, r), forumTitle: lk.forums.get(r.forumid)?.title || null })),
  });
});

// Bài viết của thành viên, mới nhất trước, kèm đoạn trích.
usersRouter.get('/:id/posts', async (req, res) => {
  const { lk } = await context();
  const id = toInt(req.params.id);
  const [{ n: total }] = await q('SELECT COUNT(*) AS n FROM post WHERE userid = ?', [id]);
  const { page, pages, offset } = paging(req, total, PER_PAGE);
  const rows = await q(
    `SELECT p.postid, p.threadid, p.title, p.dateline, p.pagetext, p.visible, t.title AS threadtitle, t.forumid
       FROM post p LEFT JOIN thread t ON t.threadid = p.threadid
      WHERE p.userid = ?
      ORDER BY p.dateline DESC, p.postid DESC LIMIT ? OFFSET ?`,
    [id, PER_PAGE, offset],
  );
  res.json({
    total,
    page,
    pages,
    posts: rows.map((p) => ({
      id: p.postid,
      threadId: p.threadid,
      threadTitle: clean(p.threadtitle) || `Chủ đề #${p.threadid}`,
      forum: lk.forums.has(p.forumid) ? { id: p.forumid, title: lk.forums.get(p.forumid).title } : null,
      title: clean(p.title),
      dateline: p.dateline,
      visible: p.visible,
      snippet: snippet(p.pagetext),
    })),
  });
});

// Bạn bè, danh sách liên hệ, và những người hay cảm ơn qua lại.
usersRouter.get('/:id/friends', async (req, res) => {
  const { lk, users } = await context();
  const id = toInt(req.params.id);
  const [relations, thankedBy, thanked] = await Promise.all([
    q("SELECT relationid, friend FROM userlist WHERE userid = ? AND type = 'buddy'", [id]),
    q(`SELECT pt.userid AS uid, COUNT(*) AS n
         FROM post_thanks pt JOIN post p ON p.postid = pt.postid
        WHERE p.userid = ?
        GROUP BY pt.userid ORDER BY n DESC LIMIT 20`, [id]),
    q(`SELECT p.userid AS uid, COUNT(*) AS n
         FROM post_thanks pt JOIN post p ON p.postid = pt.postid
        WHERE pt.userid = ?
        GROUP BY p.userid ORDER BY n DESC LIMIT 20`, [id]),
  ]);
  const brief = (uid) => {
    const u = users.byId.get(uid);
    return u ? userBrief(lk, u) : { id: uid, username: `#${uid}`, color: null };
  };
  const byName = (x, y) => x.username.localeCompare(y.username, 'vi');
  res.json({
    friends: relations.filter((r) => r.friend === 'yes').map((r) => brief(r.relationid)).sort(byName),
    contacts: relations.filter((r) => r.friend !== 'yes').map((r) => brief(r.relationid)).sort(byName),
    thankedBy: thankedBy.filter((r) => r.uid !== id).map((r) => ({ ...brief(r.uid), count: r.n })),
    thanked: thanked.filter((r) => r.uid !== id).map((r) => ({ ...brief(r.uid), count: r.n })),
  });
});
