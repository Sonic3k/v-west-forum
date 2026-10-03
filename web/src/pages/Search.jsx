import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getJson, useApi } from '../lib/api.js';
import { formatDate, formatNumber } from '../lib/format.js';
import { Label, Pagination, Status, ThreadRow, UserLink } from '../components/ui.jsx';

const FIELDS = ['q', 'type', 'author', 'forum', 'year', 'sort'];

// Đoạn trích có tô sáng các chỗ khớp.
function Highlighted({ snippet }) {
  const parts = [];
  let idx = 0;
  snippet.marks.forEach(([a, b], i) => {
    if (a > idx) parts.push(snippet.text.slice(idx, a));
    parts.push(<mark key={i}>{snippet.text.slice(a, b)}</mark>);
    idx = b;
  });
  if (idx < snippet.text.length) parts.push(snippet.text.slice(idx));
  return (
    <p className="feed-snippet">
      {snippet.before && '… '}
      {parts}
      {snippet.after && ' …'}
    </p>
  );
}

function IndexProgress({ status, onReady }) {
  const [current, setCurrent] = useState(status);
  const notified = useRef(false);
  useEffect(() => {
    if (current.state === 'ready') {
      if (!notified.current) {
        notified.current = true;
        onReady();
      }
      return undefined;
    }
    const timer = setTimeout(() => {
      getJson('/api/search/status').then(setCurrent).catch(() => {});
    }, 3000);
    return () => clearTimeout(timer);
  }, [current, onReady]);
  if (current.state === 'error') {
    return <p className="status status-error">Chưa chuẩn bị được dữ liệu tìm kiếm: {current.error}</p>;
  }
  const pct = current.total ? Math.floor((current.done * 100) / current.total) : 0;
  return (
    <p className="status">
      Panel đang chuẩn bị dữ liệu tìm kiếm lần đầu ({pct}%). Việc này chỉ diễn ra một lần, mất khoảng một hai phút.
    </p>
  );
}

export default function Search() {
  const [params, setParams] = useSearchParams();
  const current = Object.fromEntries(FIELDS.map((k) => [k, params.get(k) || '']));
  const type = current.type === 'threads' ? 'threads' : 'posts';
  const page = Number(params.get('page')) || 1;
  const [form, setForm] = useState(current);
  const [showFilters, setShowFilters] = useState(Boolean(current.author || current.forum || current.year));
  const [nonce, setNonce] = useState(0);
  const [indexReady, setIndexReady] = useState(false);
  const meta = useApi('/api/search/meta');
  const handleReady = useCallback(() => {
    setIndexReady(true);
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    setForm(Object.fromEntries(FIELDS.map((k) => [k, params.get(k) || ''])));
  }, [params]);

  const hasQuery = Boolean(current.q.trim() || (type === 'threads' && current.author.trim()));
  const apiQuery = new URLSearchParams({ ...current, page: String(page), n: String(nonce) }).toString();
  const results = useApi(hasQuery ? `/api/search/${type}?${apiQuery}` : '/api/search/status');

  const submit = (e) => {
    e.preventDefault();
    const next = {};
    for (const k of FIELDS) if (form[k]) next[k] = form[k].trim();
    if (type === 'threads') next.type = 'threads';
    setParams(next);
  };
  const setType = (t) => {
    const next = {};
    for (const k of FIELDS) if (current[k]) next[k] = current[k];
    if (t === 'threads') next.type = 'threads';
    else delete next.type;
    setParams(next);
  };
  const hrefFor = (n) => {
    const p = new URLSearchParams();
    for (const k of FIELDS) if (current[k]) p.set(k, current[k]);
    if (n > 1) p.set('page', String(n));
    return `/search?${p.toString()}`;
  };

  const status = meta.data?.status;
  const indexNotReady = type === 'posts' && status && status.state !== 'ready' && !indexReady;

  return (
    <main className="page">
      <h1 className="page-title">Tìm kiếm</h1>
      <div className="seg" role="group" aria-label="Tìm trong">
        <button type="button" className={`seg-item${type === 'posts' ? ' is-active' : ''}`} onClick={() => setType('posts')}>
          Nội dung bài viết
        </button>
        <button type="button" className={`seg-item${type === 'threads' ? ' is-active' : ''}`} onClick={() => setType('threads')}>
          Tiêu đề chủ đề
        </button>
      </div>

      <form className="search-form" onSubmit={submit} role="search">
        <div className="search-row">
          <input
            type="search"
            value={form.q}
            onChange={(e) => setForm({ ...form, q: e.target.value })}
            placeholder={type === 'posts' ? 'Ví dụ: offline Hồ Gươm' : 'Ví dụ: sinh nhật'}
            aria-label="Từ khóa"
            enterKeyHint="search"
          />
          <button type="submit" className="btn">Tìm</button>
        </div>
        <p className="hint muted">
          Gõ có dấu hay không dấu đều được. Các từ rời phải cùng xuất hiện; đặt trong ngoặc kép để tìm đúng cả cụm.
        </p>
        <button type="button" className="link-button" aria-expanded={showFilters} onClick={() => setShowFilters(!showFilters)}>
          {showFilters ? 'Ẩn bộ lọc' : 'Lọc theo người viết, box, năm'}
        </button>
        {showFilters && (
          <div className="filters">
            <label className="field field-grow">
              <span className="field-label">{type === 'threads' ? 'Người lập chủ đề' : 'Người viết'}</span>
              <input type="text" value={form.author} onChange={(e) => setForm({ ...form, author: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Box</span>
              <select value={form.forum} onChange={(e) => setForm({ ...form, forum: e.target.value })}>
                <option value="">Tất cả box</option>
                {meta.data?.forums.map((f) => (
                  <option key={f.id} value={f.id}>{`${'\u00a0\u00a0'.repeat(f.depth)}${f.title}`}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Năm</span>
              <select value={form.year} onChange={(e) => setForm({ ...form, year: e.target.value })}>
                <option value="">Mọi năm</option>
                {meta.data?.years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Thứ tự</span>
              <select value={form.sort} onChange={(e) => setForm({ ...form, sort: e.target.value })}>
                <option value="">Mới nhất trước</option>
                <option value="old">Cũ nhất trước</option>
              </select>
            </label>
          </div>
        )}
      </form>

      {indexNotReady && <IndexProgress status={status} onReady={handleReady} />}

      {hasQuery && !results.data && <Status loading={results.loading} error={indexNotReady ? null : results.error} />}
      {hasQuery && results.data && (
        <section className={results.loading ? 'is-loading' : ''}>
          <p className="muted result-count">
            {results.data.note || `${formatNumber(results.data.total)} kết quả`}
          </p>
          {type === 'posts' ? (
            <ul className="feed">
              {results.data.results.map((r) => (
                <li key={r.postId} className="feed-item">
                  <div className="feed-head">
                    <Link to={`/p/${r.postId}`} className="feed-thread">{r.threadTitle}</Link>
                    {r.visible === 2 && <Label tone="danger">Đã xóa</Label>}
                  </div>
                  <p className="muted feed-meta">
                    <UserLink id={r.author.userId} name={r.author.username} color={r.author.color} />,{' '}
                    {formatDate(r.dateline)}
                    {r.forum && <> trong <Link to={`/f/${r.forum.id}`}>{r.forum.title}</Link></>}
                  </p>
                  <Highlighted snippet={r.snippet} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="tlist">
              {results.data.threads.map((t) => <ThreadRow key={t.id} thread={t} showForum />)}
            </div>
          )}
          <Pagination page={results.data.page} pages={results.data.pages} hrefFor={hrefFor} />
        </section>
      )}
    </main>
  );
}
