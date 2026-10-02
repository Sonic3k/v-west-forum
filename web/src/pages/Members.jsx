import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { formatDate, formatDay, formatNumber } from '../lib/format.js';
import { Pagination, Status, UserLink } from '../components/ui.jsx';

const SORTS = [
  ['posts', 'Nhiều bài nhất'],
  ['joined_old', 'Tham gia sớm nhất'],
  ['joined_new', 'Tham gia gần nhất'],
  ['active', 'Hoạt động gần nhất'],
  ['name', 'Tên A-Z'],
];

export default function Members() {
  const [params, setParams] = useSearchParams();
  const q = params.get('q') || '';
  const group = params.get('group') || '';
  const sort = params.get('sort') || 'posts';
  const page = Number(params.get('page')) || 1;
  const [text, setText] = useState(q);

  const update = (changes) => {
    const next = { q, group, sort, ...changes };
    const clean = {};
    if (next.q) clean.q = next.q;
    if (next.group) clean.group = next.group;
    if (next.sort && next.sort !== 'posts') clean.sort = next.sort;
    if (changes.page && changes.page > 1) clean.page = String(changes.page);
    setParams(clean, { replace: true, state: { keepScroll: true } });
  };

  // Gõ tới đâu lọc tới đó (chờ 300ms sau lần gõ cuối).
  useEffect(() => {
    if (text === q) return undefined;
    const timer = setTimeout(() => update({ q: text.trim() }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text]);

  const query = new URLSearchParams({ q, group, sort, page: String(page) }).toString();
  const { data, loading, error } = useApi(`/api/users?${query}`);

  const hrefFor = (n) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (group) p.set('group', group);
    if (sort !== 'posts') p.set('sort', sort);
    if (n > 1) p.set('page', String(n));
    const s = p.toString();
    return `/u${s ? `?${s}` : ''}`;
  };

  return (
    <main className={`page${loading && data ? ' is-loading' : ''}`}>
      <h1 className="page-title">Thành viên</h1>
      <div className="filters">
        <label className="field field-grow">
          <span className="field-label">Tìm theo tên</span>
          <input
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Gõ có dấu hay không dấu đều được"
            autoComplete="off"
            enterKeyHint="search"
          />
        </label>
        <label className="field">
          <span className="field-label">Nhóm</span>
          <select value={group} onChange={(e) => update({ group: e.target.value })}>
            <option value="">Tất cả nhóm</option>
            {data?.groups?.map((g) => (
              <option key={g.id} value={g.id}>{g.title} ({formatNumber(g.count)})</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Sắp xếp</span>
          <select value={sort} onChange={(e) => update({ sort: e.target.value })}>
            {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      {!data && <Status loading={loading} error={error} />}
      {data && (
        <>
          <p className="muted result-count">{formatNumber(data.total)} thành viên</p>
          {data.users.length === 0 && <p className="empty">Không có thành viên nào khớp. Thử bỏ bớt chữ hoặc chọn lại nhóm.</p>}
          <ul className="mlist">
            {data.users.map((u) => (
              <li key={u.id} className="mrow">
                <div className="mrow-main">
                  <UserLink id={u.id} name={u.username} color={u.color} className="mrow-name" />
                  <span className="muted mrow-sub">{[u.title, u.group].filter(Boolean).join(', ')}</span>
                </div>
                <div className="mrow-stats">
                  <span><strong>{formatNumber(u.posts)}</strong> bài</span>
                  <span className="muted">Tham gia {formatDay(u.joinDate)}</span>
                  {u.lastActivity ? <span className="muted">Lần cuối {formatDate(u.lastActivity)}</span> : null}
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
        </>
      )}
    </main>
  );
}
