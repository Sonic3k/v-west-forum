import { q } from './db.js';
import { clean } from './text.js';

// Bit trong forum.options của vBulletin 4.
const FORUM_ACTIVE = 1;
const FORUM_CAN_CONTAIN_THREADS = 4;

export const THREAD_COLS = `threadid, title, prefixid, forumid, postuserid, postusername, dateline,
  replycount, views, lastpost, lastposter, lastposterid, lastpostid,
  sticky, open, visible, pollid, attach`;

// Dữ liệu là bản lưu trữ, không đổi, nên chỉ đọc một lần rồi giữ trong bộ nhớ.
let loading = null;

export function getLookups() {
  if (!loading) {
    loading = build().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

async function build() {
  const [forumRows, modRows, groupRows, prefixRows, fieldRows, postContentType] = await Promise.all([
    q(`SELECT forumid, title, title_clean, description, description_clean, options, displayorder,
              replycount, threadcount, lastpost, lastposter, lastposterid, lastpostid,
              lastthread, lastthreadid, parentid, parentlist, link
         FROM forum`),
    q(`SELECT m.forumid, m.userid, u.username
         FROM moderator m
         LEFT JOIN user u ON u.userid = m.userid`),
    q('SELECT usergroupid, title, opentag FROM usergroup'),
    q("SELECT varname, text FROM phrase WHERE varname LIKE 'prefix\\_%\\_title\\_plain' ORDER BY languageid")
      .catch(() => []),
    q("SELECT varname, text FROM phrase WHERE varname LIKE 'field%\\_title' ORDER BY languageid")
      .catch(() => []),
    findPostContentType(),
  ]);

  const forums = new Map();
  for (const r of forumRows) {
    forums.set(r.forumid, {
      id: r.forumid,
      title: clean(r.title_clean || r.title) || `Box #${r.forumid}`,
      description: clean(r.description_clean || r.description),
      parentId: r.parentid,
      parentList: String(r.parentlist || '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
      isCategory: (r.options & FORUM_CAN_CONTAIN_THREADS) === 0,
      active: (r.options & FORUM_ACTIVE) !== 0,
      hidden: r.displayorder === 0,
      displayOrder: r.displayorder,
      link: r.link || null,
      threadCount: r.threadcount,
      postCount: r.replycount,
      last: r.lastpost
        ? {
            time: r.lastpost,
            poster: clean(r.lastposter),
            posterId: r.lastposterid,
            postId: r.lastpostid,
            threadId: r.lastthreadid,
            threadTitle: clean(r.lastthread),
          }
        : null,
      childIds: [],
    });
  }

  const roots = [];
  for (const f of forums.values()) {
    const parent = forums.get(f.parentId);
    if (parent && parent.id !== f.id) parent.childIds.push(f.id);
    else roots.push(f.id);
  }
  const byOrder = (a, b) => {
    const fa = forums.get(a);
    const fb = forums.get(b);
    return Number(fa.hidden) - Number(fb.hidden) || fa.displayOrder - fb.displayOrder || fa.id - fb.id;
  };
  roots.sort(byOrder);
  for (const f of forums.values()) f.childIds.sort(byOrder);

  // forumid = -1 là siêu quản lý (toàn diễn đàn).
  const moderators = new Map();
  for (const m of modRows) {
    const list = moderators.get(m.forumid) || [];
    if (!list.some((x) => x.userId === m.userid)) {
      list.push({ userId: m.userid, username: clean(m.username) || `#${m.userid}` });
    }
    moderators.set(m.forumid, list);
  }
  for (const list of moderators.values()) list.sort((a, b) => a.username.localeCompare(b.username, 'vi'));

  const groups = new Map();
  for (const g of groupRows) {
    groups.set(g.usergroupid, { title: clean(g.title), color: extractColor(g.opentag) });
  }

  const prefixes = new Map();
  for (const p of prefixRows) {
    const m = /^prefix_(.+)_title_plain$/.exec(p.varname);
    if (m) prefixes.set(m[1], clean(p.text));
  }

  // Tên các trường hồ sơ tùy chỉnh (userfield.field1, field2...).
  const profileFields = new Map();
  for (const f of fieldRows) {
    const m = /^(field\d+)_title$/.exec(f.varname);
    if (m) profileFields.set(m[1], clean(f.text));
  }

  return { forums, roots, moderators, groups, prefixes, profileFields, postContentType };
}

async function findPostContentType() {
  try {
    const rows = await q(`SELECT ct.contenttypeid, p.class AS package
                            FROM contenttype ct
                            LEFT JOIN package p ON p.packageid = ct.packageid
                           WHERE ct.class = 'Post'`);
    const found = rows.find((r) => r.package === 'vBForum') || rows[0];
    if (found) return found.contenttypeid;
  } catch {
    // Không có bảng contenttype: thử cách dưới.
  }
  const rows = await q(`SELECT contenttypeid, COUNT(*) AS n FROM attachment
                         GROUP BY contenttypeid ORDER BY n DESC LIMIT 1`);
  return rows[0]?.contenttypeid ?? null;
}

// Màu tên nhóm thành viên lấy từ opentag, ví dụ <span style="color: red;">.
function extractColor(opentag) {
  const m = /color\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20})/.exec(opentag || '');
  return m ? m[1] : null;
}

// Các box một thành viên làm quản lý (forumid = -1 là siêu quản lý).
export function moderatedBy(lk, userId) {
  const out = [];
  for (const [forumId, list] of lk.moderators) {
    if (!list.some((m) => m.userId === userId)) continue;
    if (forumId === -1) out.push({ id: -1, title: 'Siêu quản lý toàn diễn đàn' });
    else if (lk.forums.has(forumId)) out.push({ id: forumId, title: lk.forums.get(forumId).title });
  }
  return out;
}

export function forumSummary(lk, id) {
  const f = lk.forums.get(id);
  if (!f) return null;
  return {
    id: f.id,
    title: f.title,
    description: f.description,
    isCategory: f.isCategory,
    active: f.active,
    hidden: f.hidden,
    link: f.link,
    threadCount: f.threadCount,
    postCount: f.postCount,
    last: f.last,
    moderators: lk.moderators.get(id) || [],
  };
}

export function forumTree(lk, id, depth) {
  const node = forumSummary(lk, id);
  if (!node) return null;
  node.children = depth > 0 ? lk.forums.get(id).childIds.map((cid) => forumTree(lk, cid, depth - 1)) : [];
  return node;
}

// Các box cha, từ ngoài vào trong (không gồm chính box đó).
export function breadcrumb(lk, id) {
  const f = lk.forums.get(id);
  if (!f) return [];
  const chain = f.parentList.filter((pid) => pid !== id).reverse();
  return chain.filter((pid) => lk.forums.has(pid)).map((pid) => ({ id: pid, title: lk.forums.get(pid).title }));
}

export function mapThread(lk, r) {
  const moved = r.open === 10 && r.pollid > 0;
  return {
    id: r.threadid,
    title: clean(r.title) || `Chủ đề #${r.threadid}`,
    prefix: r.prefixid ? lk.prefixes.get(r.prefixid) || null : null,
    forumId: r.forumid,
    starter: { userId: r.postuserid, username: clean(r.postusername) },
    dateline: r.dateline,
    replies: r.replycount,
    views: r.views,
    last: { time: r.lastpost, poster: clean(r.lastposter), posterId: r.lastposterid, postId: r.lastpostid },
    sticky: r.sticky !== 0,
    closed: r.open === 0,
    movedTo: moved ? r.pollid : null,
    poll: !moved && r.pollid > 0,
    visible: r.visible,
    attach: r.attach,
  };
}

export function mapUser(lk, u) {
  const group = lk.groups.get(u.displaygroupid || u.usergroupid) || lk.groups.get(u.usergroupid);
  return {
    id: u.userid,
    username: clean(u.username),
    title: clean(u.usertitle),
    group: group?.title || null,
    color: group?.color || null,
    joinDate: u.joindate,
    posts: u.posts,
    reputation: u.reputation,
  };
}

export async function loadAnnouncements(forumIds) {
  const rows = await q(
    `SELECT a.announcementid, a.title, a.userid, u.username, a.startdate, a.enddate,
            a.pagetext, a.forumid, a.views
       FROM announcement a
       LEFT JOIN user u ON u.userid = a.userid
      WHERE a.forumid IN (?)
      ORDER BY a.startdate DESC`,
    [forumIds],
  );
  return rows.map((a) => ({
    id: a.announcementid,
    title: clean(a.title),
    author: { userId: a.userid, username: clean(a.username) },
    startDate: a.startdate,
    endDate: a.enddate,
    pagetext: a.pagetext || '',
    views: a.views,
  }));
}
