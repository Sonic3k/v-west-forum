import React from 'react';
import { Link } from 'react-router-dom';
import BBCode from './BBCode.jsx';
import { formatDate, formatNumber } from '../lib/format.js';

export function Label({ tone = 'muted', children }) {
  return <span className={`label label-${tone}`}>{children}</span>;
}

export function Status({ loading, error }) {
  if (error) {
    return (
      <div className="status status-error" role="alert">
        <p>{error}</p>
        <p className="muted">
          Nếu lỗi nhắc tới kết nối database, kiểm tra biến DATABASE_URL của service panel trên Railway.
        </p>
      </div>
    );
  }
  if (loading) return <p className="status">Đang tải…</p>;
  return null;
}

export function Breadcrumb({ items = [] }) {
  return (
    <nav className="crumbs" aria-label="Vị trí">
      <Link to="/">Trang chủ</Link>
      {items.map((it) => (
        <React.Fragment key={`${it.to || it.id}`}>
          <span className="crumbs-sep" aria-hidden="true">/</span>
          <Link to={it.to || `/f/${it.id}`}>{it.title}</Link>
        </React.Fragment>
      ))}
    </nav>
  );
}

// Trên điện thoại chỉ hiện trang hiện tại ±1 (các số xa hơn có class "far", ẩn bằng CSS).
export function Pagination({ page, pages, hrefFor }) {
  if (!pages || pages <= 1) return null;
  const nums = new Set([1, pages]);
  for (let n = page - 2; n <= page + 2; n += 1) if (n > 1 && n < pages) nums.add(n);
  const sorted = [...nums].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) items.push(<span key={`gap${n}`} className="pager-gap">…</span>);
    const far = Math.abs(n - page) === 2 && n !== 1 && n !== pages ? ' far' : '';
    items.push(
      n === page
        ? <span key={n} className="pager-current" aria-current="page">{n}</span>
        : <Link key={n} to={hrefFor(n)} className={`pager-num${far}`}>{n}</Link>,
    );
  });
  return (
    <nav className="pager" aria-label="Phân trang">
      {page > 1
        ? <Link to={hrefFor(page - 1)} className="pager-step">Trước</Link>
        : <span className="pager-step pager-off">Trước</span>}
      <span className="pager-nums">{items}</span>
      {page < pages
        ? <Link to={hrefFor(page + 1)} className="pager-step">Sau</Link>
        : <span className="pager-step pager-off">Sau</span>}
    </nav>
  );
}

// Tên thành viên có link tới trang thành viên (khách / tài khoản đã xóa thì chỉ hiện chữ).
export function UserLink({ id, name, color, className = '' }) {
  const style = color ? { color } : undefined;
  const label = name || (id ? `#${id}` : 'Khách');
  if (!id) return <span className={`uname ${className}`} style={style}>{label}</span>;
  return <Link to={`/u/${id}`} className={`uname ${className}`} style={style}>{label}</Link>;
}

export function UserList({ users }) {
  return users.map((u, i) => (
    <React.Fragment key={`${u.userId ?? u.id}-${i}`}>
      {i > 0 && ', '}
      <UserLink id={u.userId ?? u.id} name={u.username} />
    </React.Fragment>
  ));
}

export function ForumRow({ forum }) {
  const muted = forum.hidden || !forum.active;
  return (
    <div className={`frow${muted ? ' is-muted' : ''}`}>
      <div className="frow-main">
        <h3 className="frow-title">
          <Link to={`/f/${forum.id}`}>{forum.title}</Link>
          {!forum.active && <Label>Đã đóng</Label>}
          {forum.hidden && <Label>Ẩn</Label>}
          {forum.link && <Label>Liên kết ngoài</Label>}
        </h3>
        {forum.description && <p className="frow-desc">{forum.description}</p>}
        {forum.children?.length > 0 && (
          <p className="frow-sub">
            <span className="muted">Box con: </span>
            {forum.children.map((c, i) => (
              <React.Fragment key={c.id}>
                {i > 0 && ', '}
                <Link to={`/f/${c.id}`}>{c.title}</Link>
              </React.Fragment>
            ))}
          </p>
        )}
        {forum.moderators?.length > 0 && (
          <p className="frow-sub">
            <span className="muted">Quản lý: </span>
            <UserList users={forum.moderators} />
          </p>
        )}
      </div>
      <div className="frow-stats">
        <span><strong>{formatNumber(forum.threadCount)}</strong> chủ đề</span>
        <span><strong>{formatNumber(forum.postCount)}</strong> bài</span>
      </div>
      <div className="frow-last">
        {forum.last ? (
          <>
            <Link to={`/p/${forum.last.postId}`} className="frow-last-title">
              {forum.last.threadTitle || 'Bài mới nhất'}
            </Link>
            <span className="muted">
              <UserLink id={forum.last.posterId} name={forum.last.poster} />, {formatDate(forum.last.time)}
            </span>
          </>
        ) : (
          <span className="muted">Chưa có bài</span>
        )}
      </div>
    </div>
  );
}

export function ThreadRow({ thread: t, showForum = false }) {
  const to = `/t/${t.movedTo || t.id}`;
  const classes = ['trow'];
  if (t.sticky) classes.push('is-sticky');
  if (t.visible !== 1) classes.push('is-muted');
  return (
    <div className={classes.join(' ')}>
      <div className="trow-main">
        <div className="trow-title">
          {t.sticky && <Label tone="pin">Dán</Label>}
          {t.movedTo && <Label>Đã chuyển</Label>}
          {t.closed && <Label>Đã khóa</Label>}
          {t.visible === 0 && <Label tone="warn">Chờ duyệt</Label>}
          {t.visible === 2 && <Label tone="danger">Đã xóa</Label>}
          {t.poll && <Label>Bình chọn</Label>}
          {t.prefix && <span className="prefix">{t.prefix}</span>}
          <Link to={to}>{t.title}</Link>
        </div>
        <div className="trow-meta muted">
          <UserLink id={t.starter.userId} name={t.starter.username} />, {formatDate(t.dateline)}
          {showForum && t.forumTitle && (
            <>
              {' '}trong <Link to={`/f/${t.forumId}`}>{t.forumTitle}</Link>
            </>
          )}
        </div>
      </div>
      {!t.movedTo && (
        <>
          <div className="trow-stats">
            <span><strong>{formatNumber(t.replies)}</strong> trả lời</span>
            <span><strong>{formatNumber(t.views)}</strong> lượt xem</span>
          </div>
          <div className="trow-last">
            {t.last.time ? (
              <>
                <span className="last-label muted">Bài cuối</span>
                <Link to={`/p/${t.last.postId}`}>{formatDate(t.last.time)}</Link>
                <span className="muted"><UserLink id={t.last.posterId} name={t.last.poster} /></span>
              </>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

export function Announcements({ items }) {
  if (!items?.length) return null;
  return (
    <section className="notices" aria-label="Thông báo">
      {items.map((a) => (
        <details key={a.id} className="notice">
          <summary className="notice-toggle">
            <Label tone="pin">Thông báo</Label>
            <span className="notice-title">{a.title}</span>
            <span className="muted notice-meta">{a.author.username}, {formatDate(a.startDate)}</span>
          </summary>
          <BBCode text={a.pagetext} className="bb notice-body" />
        </details>
      ))}
    </section>
  );
}

// Thanh tab cuộn ngang được trên điện thoại.
export function Tabs({ items }) {
  return (
    <nav className="tabs" aria-label="Mục">
      {items.map((it) => (
        <Link
          key={it.to}
          to={it.to}
          state={{ keepScroll: true }}
          className={`tab${it.active ? ' is-active' : ''}`}
          aria-current={it.active ? 'page' : undefined}
        >
          {it.label}
          {it.count != null && <span className="tab-count">{formatNumber(it.count)}</span>}
        </Link>
      ))}
    </nav>
  );
}
