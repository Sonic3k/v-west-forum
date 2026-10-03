import { q } from './db.js';
import { clean } from './text.js';
import { avatarUrl } from './assets.js';

// Bỏ dấu tiếng Việt và chữ hoa để tìm "thao" ra "Thảo", "dung" ra "Dũng", "Đức".
export function fold(input) {
  return String(input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

// Khoảng 8.000 thành viên: giữ thông tin cơ bản trong bộ nhớ để tìm, lọc, sắp xếp nhanh.
let loading = null;

export function getUsers() {
  if (!loading) {
    loading = build().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

async function build() {
  const rows = await q(`SELECT userid, username, usergroupid, displaygroupid, membergroupids,
                               joindate, lastactivity, posts, usertitle, avatarid
                          FROM user`);
  const list = rows.map((r) => {
    const username = clean(r.username) || `#${r.userid}`;
    return {
      id: r.userid,
      username,
      fold: fold(username),
      usergroupid: r.usergroupid,
      displaygroupid: r.displaygroupid,
      membergroupids: String(r.membergroupids || '')
        .split(',')
        .map((s) => Number.parseInt(s, 10))
        .filter(Number.isInteger),
      joinDate: r.joindate,
      lastActivity: r.lastactivity,
      posts: r.posts,
      title: clean(r.usertitle),
      avatarid: r.avatarid,
    };
  });
  return { list, byId: new Map(list.map((u) => [u.id, u])) };
}

export function groupOf(lk, u) {
  return lk.groups.get(u.displaygroupid || u.usergroupid) || lk.groups.get(u.usergroupid) || null;
}

export function userBrief(lk, u, assets = null) {
  const group = groupOf(lk, u);
  return {
    id: u.id,
    avatar: avatarUrl(assets, u.id, u.avatarid),
    username: u.username,
    color: group?.color || null,
    group: group?.title || null,
    title: u.title,
    joinDate: u.joinDate,
    lastActivity: u.lastActivity,
    posts: u.posts,
  };
}

// Tên + màu cho một userid bất kỳ (người đã bị xóa thì dùng tên lưu kèm bài/tin nhắn).
export function nameRef(lk, users, id, fallbackName = '') {
  const u = users.byId.get(id);
  if (!u) return { userId: id || 0, username: clean(fallbackName) || (id ? `#${id}` : 'Khách'), color: null };
  return { userId: u.id, username: u.username, color: groupOf(lk, u)?.color || null };
}
