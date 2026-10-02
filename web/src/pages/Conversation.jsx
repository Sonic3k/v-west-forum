import React from 'react';
import { Link, useParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { formatDate, formatNumber } from '../lib/format.js';
import BBCode from '../components/BBCode.jsx';
import { Label, Status, UserLink } from '../components/ui.jsx';
import NotFound from './NotFound.jsx';

// Trò chuyện giữa hai thành viên: kind = "wall" (tường) hoặc "pm" (tin nhắn riêng).
export default function Conversation() {
  const { id, kind, other } = useParams();
  const valid = kind === 'wall' || kind === 'pm';
  const path = kind === 'pm' ? `/api/users/${id}/pms/with/${other}` : `/api/users/${id}/wall/${other}`;
  const { data, loading, error } = useApi(valid ? path : '/api/health');
  if (!valid) return <NotFound />;
  if (!data?.messages) return <main className="page"><Status loading={loading} error={error} /></main>;

  const { me, other: them, messages } = data;
  const backTab = kind === 'pm' ? 'pm' : 'wall';

  return (
    <main className="page">
      <nav className="crumbs" aria-label="Vị trí">
        <Link to="/u">Thành viên</Link>
        <span className="crumbs-sep" aria-hidden="true">/</span>
        <Link to={`/u/${id}/${backTab}`}>{me.username}</Link>
      </nav>
      <h1 className="page-title convo-title">
        {kind === 'pm' ? 'Tin nhắn riêng' : 'Trò chuyện trên tường'}
      </h1>
      <p className="page-meta">
        Giữa <UserLink id={me.userId} name={me.username} color={me.color} /> và{' '}
        <UserLink id={them.userId} name={them.username} color={them.color} />,{' '}
        {formatNumber(messages.length)} tin.
      </p>
      {messages.length === 0 && <p className="empty">Hai người chưa nhắn gì cho nhau ở đây.</p>}
      <ol className="convo">
        {messages.map((m) => {
          const mine = m.author ? m.author.userId === me.userId : m.from.userId === me.userId;
          const who = m.author || m.from;
          return (
            <li key={`${m.id}-${m.dateline}`} className={`bubble${mine ? ' is-mine' : ''}`}>
              <div className="bubble-head">
                <UserLink id={who.userId} name={who.username} color={who.color} />
                <span className="muted">{formatDate(m.dateline)}</span>
                {m.state === 'deleted' && <Label tone="danger">Đã xóa</Label>}
                {m.state === 'moderation' && <Label tone="warn">Chờ duyệt</Label>}
              </div>
              {m.title && <p className="bubble-title">{m.title}</p>}
              <BBCode text={m.text ?? m.message} className="bb bubble-body" />
            </li>
          );
        })}
      </ol>
    </main>
  );
}
