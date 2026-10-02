import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { parseBBCode, collectAttachIds } from '../lib/bbcode.js';
import { formatDate, formatDay, formatNumber, formatSize } from '../lib/format.js';
import BBCode from '../components/BBCode.jsx';
import { Breadcrumb, Label, Pagination, Status, UserLink, UserList } from '../components/ui.jsx';

export default function Thread() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const { hash } = useLocation();
  const page = Number(params.get('page')) || 1;
  const { data, loading, error } = useApi(`/api/threads/${id}?page=${page}`);

  const attachments = useMemo(() => {
    const map = new Map();
    data?.posts?.forEach((p) => p.attachments.forEach((a) => map.set(a.id, a)));
    return map;
  }, [data]);

  useEffect(() => {
    if (!data?.posts || !hash) return;
    document.getElementById(hash.slice(1))?.scrollIntoView();
  }, [data, hash]);

  if (data?.redirect) return <Navigate replace to={`/t/${data.redirect}`} />;
  if (!data) return <main className="page"><Status loading={loading} error={error} /></main>;

  const { thread } = data;
  const hrefFor = (n) => `/t/${id}?page=${n}`;

  return (
    <main className={`page${loading ? ' is-loading' : ''}`}>
      <Breadcrumb items={data.breadcrumb} />
      <h1 className="page-title thread-title">
        {thread.prefix && <span className="prefix">{thread.prefix}</span>}
        {thread.title}
      </h1>
      <p className="page-meta">
        <span>
          Lập bởi <strong><UserLink id={thread.starter.userId} name={thread.starter.username} /></strong>,{' '}
          {formatDate(thread.dateline)}.
        </span>{' '}
        <span>{formatNumber(data.total)} bài, {formatNumber(thread.views)} lượt xem.</span>{' '}
        {thread.sticky && <Label tone="pin">Dán</Label>}
        {thread.closed && <Label>Đã khóa</Label>}
        {thread.visible === 0 && <Label tone="warn">Chờ duyệt</Label>}
        {thread.visible === 2 && <Label tone="danger">Đã xóa</Label>}
      </p>

      {data.poll && <Poll poll={data.poll} />}

      <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
      <div className="posts">
        {data.posts.map((p) => <Post key={p.id} post={p} attachments={attachments} />)}
      </div>
      <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
    </main>
  );
}

function Post({ post, attachments }) {
  const tree = useMemo(() => parseBBCode(post.pagetext), [post.pagetext]);
  const inlined = useMemo(() => collectAttachIds(tree), [tree]);
  const extra = post.attachments.filter((a) => !inlined.has(a.id));
  const author = post.author;

  return (
    <article className={`post${post.visible !== 1 ? ' is-muted' : ''}`} id={`post-${post.id}`}>
      <header className="post-head">
        <a href={`#post-${post.id}`} className="post-num">#{post.number}</a>
        <time dateTime={new Date(post.dateline * 1000).toISOString()}>{formatDate(post.dateline)}</time>
        {post.visible === 0 && <Label tone="warn">Chờ duyệt</Label>}
        {post.visible === 2 && <Label tone="danger">Đã xóa</Label>}
      </header>
      <div className="post-grid">
        <aside className="author">
          <UserLink id={author?.id} name={author?.username || post.username} color={author?.color} />
          {author ? (
            <>
              {author.title && <span className="author-title">{author.title}</span>}
              {author.group && <span className="muted">{author.group}</span>}
              <span className="muted">Tham gia {formatDay(author.joinDate)}</span>
              <span className="muted">{formatNumber(author.posts)} bài viết</span>
            </>
          ) : (
            <span className="muted">Tài khoản không còn</span>
          )}
        </aside>
        <div className="post-main">
          {post.title && <h2 className="post-title">{post.title}</h2>}
          <BBCode tree={tree} attachments={attachments} className="bb post-body" />
          {extra.length > 0 && <AttachmentList items={extra} />}
          {post.thanks.length > 0 && <Thanks list={post.thanks} />}
          {post.comments.length > 0 && <Comments list={post.comments} />}
          {post.signature && <BBCode text={post.signature} className="bb sig" />}
        </div>
      </div>
    </article>
  );
}

function AttachmentList({ items }) {
  return (
    <div className="attachments">
      <h3 className="mini-title">Đính kèm</h3>
      <ul>
        {items.map((a) => (
          <li key={a.id}>
            <a href={`/api/attachments/${a.id}`} target="_blank" rel="noreferrer">
              {a.isImage ? (
                <img
                  src={`/api/attachments/${a.id}${a.hasThumb ? '?thumb=1' : ''}`}
                  alt={a.filename}
                  loading="lazy"
                />
              ) : null}
              <span>{a.filename}</span>
            </a>
            <span className="muted"> {formatSize(a.size)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Thanks({ list }) {
  const [all, setAll] = useState(false);
  const LIMIT = 25;
  const shown = all ? list : list.slice(0, LIMIT);
  return (
    <p className="thanks">
      <span className="muted">{formatNumber(list.length)} người cảm ơn: </span>
      <UserList users={shown} />
      {!all && list.length > LIMIT && (
        <>
          {' '}
          <button type="button" className="link-button" onClick={() => setAll(true)}>
            xem thêm {list.length - LIMIT} người
          </button>
        </>
      )}
    </p>
  );
}

function Comments({ list }) {
  return (
    <div className="comments">
      <h3 className="mini-title">Bình luận ({list.length})</h3>
      {list.map((c) => (
        <div key={c.id} className="comment">
          <UserLink id={c.userId} name={c.username} className="comment-who" />
          <span className="muted comment-when">{formatDate(c.dateline)}</span>
          <BBCode text={c.text} className="bb comment-text" />
        </div>
      ))}
    </div>
  );
}

function Poll({ poll }) {
  const total = poll.options.reduce((sum, o) => sum + o.votes, 0);
  return (
    <section className="poll" aria-label="Bình chọn">
      <h2 className="poll-q">{poll.question}</h2>
      <ul>
        {poll.options.map((o, i) => {
          const pct = total ? Math.round((o.votes * 100) / total) : 0;
          return (
            <li key={i}>
              <div className="poll-row">
                <span>{o.text}</span>
                <span className="muted">{formatNumber(o.votes)} phiếu, {pct}%</span>
              </div>
              <div className="poll-bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></div>
            </li>
          );
        })}
      </ul>
      <p className="muted">
        {formatNumber(poll.voters)} người bình chọn{poll.multiple ? ', được chọn nhiều phương án' : ''}
        {poll.active ? '' : ', đã đóng'}.
      </p>
    </section>
  );
}
