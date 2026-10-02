import React, { useState } from 'react';
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
        <React.Fragment key={it.id}>
          <span className="crumbs-sep" aria-hidden="true">/</span>
          <Link to={`/f/${it.id}`}>{it.title}</Link>
        </React.Fragment>
      ))}
    </nav>
  );
}

export function Pagination({ page, pages, hrefFor }) {
  if (!pages || pages <= 1) return null;
  const nums = new Set([1, pages]);
  for (let n = page - 2; n <= page + 2; n += 1) if (n > 1 && n < pages) nums.add(n);
  const sorted = [...nums].sort((a, b) => a - b);
  const items = [];
  sorted.forEach((n, i) => {
    if (i > 0 && n - sorted[i - 1] > 1) items.push(<span key={`gap${n}`} className="pager-gap">…</span>);
    items.push(
      n === page
        ? <span key={n} className="pager-current" aria-current="page">{n}</span>
        : <Link key={n} to={hrefFor(n)}>{n}</Link>,
    );
  });
  return (
    <nav className="pager" aria-label="Phân trang">
      {page > 1 ? <Link to={hrefFor(page - 1)}>Trang trước</Link> : <span className="pager-off">Trang trước</span>}
      <span className="pager-nums">{items}</span>
      {page < pages ? <Link to={hrefFor(page + 1)}>Trang sau</Link> : <span className="pager-off">Trang sau</span>}
    </nav>
  );
}

export function UserName({ name, color }) {
  return (
    <span className="uname" style={color ? { color } : undefined}>
      {name || 'Khách'}
    </span>
  );
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
            {forum.moderators.map((m) => m.username).join(', ')}
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
            <span className="muted">{forum.last.poster}, {formatDate(forum.last.time)}</span>
          </>
        ) : (
          <span className="muted">Chưa có bài</span>
        )}
      </div>
    </div>
  );
}

export function ThreadRow({ thread: t }) {
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
          {t.starter.username || 'Khách'}, {formatDate(t.dateline)}
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
                <Link to={`/p/${t.last.postId}`}>{formatDate(t.last.time)}</Link>
                <span className="muted">{t.last.poster}</span>
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
        <Announcement key={a.id} item={a} />
      ))}
    </section>
  );
}

function Announcement({ item }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="notice">
      <button type="button" className="notice-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Label tone="pin">Thông báo</Label>
        <span className="notice-title">{item.title}</span>
        <span className="muted notice-meta">{item.author.username}, {formatDate(item.startDate)}</span>
      </button>
      {open && <BBCode text={item.pagetext} className="bb notice-body" />}
    </div>
  );
}
