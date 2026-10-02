import React from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { Announcements, Breadcrumb, ForumRow, Pagination, Status, ThreadRow } from '../components/ui.jsx';
import { formatNumber } from '../lib/format.js';

const SORTS = [
  ['lastpost', 'Bài mới nhất'],
  ['dateline', 'Ngày lập chủ đề'],
  ['replies', 'Nhiều trả lời nhất'],
  ['views', 'Nhiều lượt xem nhất'],
];

export default function Forum() {
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const sort = params.get('sort') || 'lastpost';
  const { data, loading, error } = useApi(`/api/forums/${id}?page=${page}&sort=${sort}`);

  if (!data) return <main className="page"><Status loading={loading} error={error} /></main>;
  const { forum } = data;
  const hrefFor = (n) => `/f/${id}?page=${n}${sort !== 'lastpost' ? `&sort=${sort}` : ''}`;
  const hasThreads = data.stickies.length > 0 || data.threads.length > 0;

  return (
    <main className={`page${loading ? ' is-loading' : ''}`}>
      <Breadcrumb items={data.breadcrumb} />
      <h1 className="page-title">{forum.title}</h1>
      {forum.description && <p className="page-desc">{forum.description}</p>}
      {forum.moderators.length > 0 && (
        <p className="page-meta">
          <span className="muted">Quản lý box: </span>
          {forum.moderators.map((m) => m.username).join(', ')}
        </p>
      )}

      {forum.children.length > 0 && (
        <section className="block">
          <h2 className="block-title">Box con</h2>
          <div className="flist">
            {forum.children.map((f) => <ForumRow key={f.id} forum={f} />)}
          </div>
        </section>
      )}

      <Announcements items={data.announcements} />

      {!forum.isCategory && (
        <section className="block">
          <div className="block-head">
            <h2 className="block-title">
              Chủ đề <span className="muted count">{formatNumber(data.total + data.stickyTotal)}</span>
            </h2>
            <label className="sort">
              <span className="muted">Sắp xếp theo</span>
              <select
                value={sort}
                onChange={(e) => setParams(e.target.value === 'lastpost' ? {} : { sort: e.target.value })}
              >
                {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
          {!hasThreads && <p className="empty">Box này chưa có chủ đề nào.</p>}
          {hasThreads && (
            <div className="tlist">
              {data.stickies.map((t) => <ThreadRow key={t.id} thread={t} />)}
              {data.threads.map((t) => <ThreadRow key={t.id} thread={t} />)}
            </div>
          )}
          <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
        </section>
      )}
    </main>
  );
}
