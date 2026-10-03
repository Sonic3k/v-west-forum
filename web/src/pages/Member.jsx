import React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { formatDate, formatDay, formatNumber } from '../lib/format.js';
import BBCode from '../components/BBCode.jsx';
import { Avatar, Label, Pagination, Status, Tabs, ThreadRow, UserLink } from '../components/ui.jsx';

const TABS = ['profile', 'wall', 'pm', 'threads', 'posts', 'friends'];

export default function Member() {
  const { id, tab: rawTab } = useParams();
  const tab = TABS.includes(rawTab) ? rawTab : 'profile';
  const { data, loading, error } = useApi(`/api/users/${id}`);

  if (!data) return <main className="page"><Status loading={loading} error={error} /></main>;
  const { user, counts } = data;
  const base = `/u/${id}`;

  return (
    <main className="page">
      <nav className="crumbs" aria-label="Vị trí">
        <Link to="/u">Thành viên</Link>
      </nav>
      <header className="member-head">
        <div className="member-top">
          <Avatar src={user.avatar} name={user.username} size="lg" />
          <h1 className="page-title member-name" style={user.color ? { color: user.color } : undefined}>
            {user.username}
          </h1>
        </div>
        <p className="member-roles">
          {user.title && <span className="member-title">{user.title}</span>}
          {user.groups.length > 0 && <span className="muted">{user.groups.join(', ')}</span>}
        </p>
        {user.status && <p className="member-status">“{user.status}”</p>}
        <p className="member-dates muted">
          Tham gia {formatDay(user.joinDate)}.
          {user.lastActivity ? ` Hoạt động lần cuối ${formatDate(user.lastActivity)}.` : ''}
        </p>
        <ul className="member-stats">
          <li><strong>{formatNumber(user.posts)}</strong> bài viết</li>
          <li><strong>{formatNumber(counts.threads)}</strong> chủ đề</li>
          <li><strong>{formatNumber(user.thanksReceived)}</strong> lần được cảm ơn</li>
          <li><strong>{formatNumber(user.thanksGiven)}</strong> lần cảm ơn người khác</li>
        </ul>
      </header>

      <Tabs
        items={[
          { to: base, label: 'Hồ sơ', active: tab === 'profile' },
          { to: `${base}/wall`, label: 'Tường', count: counts.wallReceived + counts.wallSent, active: tab === 'wall' },
          { to: `${base}/pm`, label: 'Hòm thư', count: counts.pms, active: tab === 'pm' },
          { to: `${base}/threads`, label: 'Chủ đề', count: counts.threads, active: tab === 'threads' },
          { to: `${base}/posts`, label: 'Bài viết', count: user.posts, active: tab === 'posts' },
          { to: `${base}/friends`, label: 'Bạn bè', count: counts.friends, active: tab === 'friends' },
        ]}
      />

      <div className="tab-panel">
        {tab === 'profile' && <ProfileTab data={data} />}
        {tab === 'wall' && <WallTab id={id} counts={counts} />}
        {tab === 'pm' && <PmTab id={id} />}
        {tab === 'threads' && <ThreadsTab id={id} />}
        {tab === 'posts' && <PostsTab id={id} />}
        {tab === 'friends' && <FriendsTab id={id} />}
      </div>
    </main>
  );
}

function hoursOnline(seconds) {
  if (!seconds) return null;
  const hours = Math.round(seconds / 3600);
  return hours >= 1 ? `${formatNumber(hours)} giờ` : `${Math.max(1, Math.round(seconds / 60))} phút`;
}

function ProfileTab({ data }) {
  const { user, contacts, fields, moderates } = data;
  const rows = [
    ['Ngày sinh', user.birthday],
    ['Lần đăng nhập trước', user.lastVisit ? formatDate(user.lastVisit) : null],
    ['Bài viết cuối', user.lastPost
      ? <Link to={`/p/${user.lastPostId}`}>{formatDate(user.lastPost)}</Link>
      : null],
    ['Danh tiếng', formatNumber(user.reputation)],
    ['Số bài được cảm ơn', formatNumber(user.thankedPosts)],
    ['Lượt xem hồ sơ', formatNumber(user.profileVisits)],
    ['Thời gian online', hoursOnline(user.timeOnline)],
    ['Vi phạm, cảnh cáo', user.infractions || user.warnings ? `${user.infractions} vi phạm, ${user.warnings} cảnh cáo` : null],
    ['Người giới thiệu', user.referrer
      ? <UserLink id={user.referrer.userId} name={user.referrer.username} color={user.referrer.color} />
      : null],
  ].filter(([, v]) => v != null && v !== '');

  return (
    <div className="profile">
      <section className="profile-block">
        <h2 className="block-title">Thông tin</h2>
        <dl className="facts">
          {rows.map(([k, v]) => (
            <div key={k} className="fact"><dt>{k}</dt><dd>{v}</dd></div>
          ))}
        </dl>
      </section>

      {contacts.length > 0 && (
        <section className="profile-block">
          <h2 className="block-title">Liên lạc</h2>
          <dl className="facts">
            {contacts.map((c) => (
              <div key={c.label} className="fact">
                <dt>{c.label}</dt>
                <dd className="break">{c.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {fields.length > 0 && (
        <section className="profile-block">
          <h2 className="block-title">Giới thiệu bản thân</h2>
          <dl className="facts facts-wide">
            {fields.map((f) => (
              <div key={f.title} className="fact"><dt>{f.title}</dt><dd className="pre">{f.value}</dd></div>
            ))}
          </dl>
        </section>
      )}

      {moderates.length > 0 && (
        <section className="profile-block">
          <h2 className="block-title">Box đang quản lý</h2>
          <ul className="plain-list">
            {moderates.map((f) => (
              <li key={f.id}>{f.id > 0 ? <Link to={`/f/${f.id}`}>{f.title}</Link> : f.title}</li>
            ))}
          </ul>
        </section>
      )}

      {user.profilePic && (
        <section className="profile-block">
          <h2 className="block-title">Ảnh hồ sơ</h2>
          <img className="profile-pic" src={user.profilePic} alt={`Ảnh hồ sơ của ${user.username}`} loading="lazy" />
        </section>
      )}

      {user.signature && (
        <section className="profile-block">
          <h2 className="block-title">Chữ ký</h2>
          <BBCode text={user.signature} className="bb sig sig-full" />
        </section>
      )}
    </div>
  );
}

function stateLabel(state) {
  if (state === 'deleted') return <Label tone="danger">Đã xóa</Label>;
  if (state === 'moderation') return <Label tone="warn">Chờ duyệt</Label>;
  return null;
}

function WallTab({ id, counts }) {
  const [params] = useSearchParams();
  const dir = params.get('dir') === 'sent' ? 'sent' : 'received';
  const page = Number(params.get('page')) || 1;
  const { data, loading, error } = useApi(`/api/users/${id}/wall?dir=${dir}&page=${page}`);
  const hrefFor = (n) => `/u/${id}/wall?dir=${dir}${n > 1 ? `&page=${n}` : ''}`;

  return (
    <section>
      <div className="seg" role="group" aria-label="Chọn loại tin">
        <Link to={`/u/${id}/wall`} state={{ keepScroll: true }} className={`seg-item${dir === 'received' ? ' is-active' : ''}`}>
          Người khác viết ({formatNumber(counts.wallReceived)})
        </Link>
        <Link to={`/u/${id}/wall?dir=sent`} state={{ keepScroll: true }} className={`seg-item${dir === 'sent' ? ' is-active' : ''}`}>
          Viết cho người khác ({formatNumber(counts.wallSent)})
        </Link>
      </div>
      {!data && <Status loading={loading} error={error} />}
      {data && data.messages.length === 0 && <p className="empty">Chưa có tin nhắn nào ở đây.</p>}
      {data && (
        <>
          <ul className="feed">
            {data.messages.map((m) => {
              const other = dir === 'sent' ? m.owner : m.author;
              return (
                <li key={m.id} className="feed-item">
                  <div className="feed-head">
                    {dir === 'sent' ? (
                      <span>Gửi tới <UserLink id={m.owner.userId} name={m.owner.username} color={m.owner.color} /></span>
                    ) : (
                      <UserLink id={m.author.userId} name={m.author.username} color={m.author.color} />
                    )}
                    <span className="muted">{formatDate(m.dateline)}</span>
                    {stateLabel(m.state)}
                  </div>
                  {m.title && <p className="feed-title">{m.title}</p>}
                  <BBCode text={m.text} className="bb feed-body" />
                  {other.userId > 0 && Number(other.userId) !== Number(id) && (
                    <Link to={`/u/${id}/wall/${other.userId}`} className="feed-link">
                      Xem cả cuộc trò chuyện với {other.username}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
        </>
      )}
    </section>
  );
}

function PmTab({ id }) {
  const [params] = useSearchParams();
  const folder = params.get('folder') ?? '0';
  const page = Number(params.get('page')) || 1;
  const { data, loading, error } = useApi(`/api/users/${id}/pms?folder=${folder}&page=${page}`);
  const hrefFor = (n) => `/u/${id}/pm?folder=${data?.folder ?? folder}${n > 1 ? `&page=${n}` : ''}`;

  if (!data) return <Status loading={loading} error={error} />;
  const sentFolder = data.folder === -1;

  return (
    <section>
      <div className="seg seg-wrap" role="group" aria-label="Thư mục">
        {data.folders.map((f) => (
          <Link
            key={f.id}
            to={`/u/${id}/pm?folder=${f.id}`}
            state={{ keepScroll: true }}
            className={`seg-item${f.id === data.folder ? ' is-active' : ''}`}
          >
            {f.name} ({formatNumber(f.count)})
          </Link>
        ))}
      </div>
      {data.messages.length === 0 && <p className="empty">Thư mục này trống.</p>}
      <ul className="pm-list">
        {data.messages.map((m) => {
          const partner = sentFolder ? m.to[0] : m.from;
          return (
            <li key={m.id}>
              <details className="pm">
                <summary>
                  <span className="pm-title">{m.title || '(Không có tiêu đề)'}</span>
                  <span className="pm-meta muted">
                    {sentFolder
                      ? <>Gửi tới {m.to.map((t) => t.username).join(', ') || 'không rõ'}</>
                      : <>Từ {m.from.username}</>}
                    , {formatDate(m.dateline)}
                  </span>
                </summary>
                <div className="pm-body">
                  <p className="pm-people muted">
                    Từ <UserLink id={m.from.userId} name={m.from.username} color={m.from.color} /> tới{' '}
                    {m.to.map((t, i) => (
                      <React.Fragment key={t.userId}>
                        {i > 0 && ', '}
                        <UserLink id={t.userId} name={t.username} color={t.color} />
                      </React.Fragment>
                    ))}
                  </p>
                  <BBCode text={m.message} className="bb" />
                  {partner && partner.userId > 0 && (
                    <Link to={`/u/${id}/pm/${partner.userId}`} className="feed-link">
                      Xem cả cuộc trò chuyện với {partner.username}
                    </Link>
                  )}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
      <Pagination page={data.page} pages={data.pages} hrefFor={hrefFor} />
    </section>
  );
}

function ThreadsTab({ id }) {
  const [params] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const { data, loading, error } = useApi(`/api/users/${id}/threads?page=${page}`);
  if (!data) return <Status loading={loading} error={error} />;
  return (
    <section>
      {data.threads.length === 0 && <p className="empty">Thành viên này chưa lập chủ đề nào.</p>}
      <div className="tlist">
        {data.threads.map((t) => <ThreadRow key={t.id} thread={t} showForum />)}
      </div>
      <Pagination page={data.page} pages={data.pages} hrefFor={(n) => `/u/${id}/threads${n > 1 ? `?page=${n}` : ''}`} />
    </section>
  );
}

function PostsTab({ id }) {
  const [params] = useSearchParams();
  const page = Number(params.get('page')) || 1;
  const { data, loading, error } = useApi(`/api/users/${id}/posts?page=${page}`);
  if (!data) return <Status loading={loading} error={error} />;
  return (
    <section>
      {data.posts.length === 0 && <p className="empty">Thành viên này chưa có bài viết nào.</p>}
      <ul className="feed">
        {data.posts.map((p) => (
          <li key={p.id} className="feed-item">
            <div className="feed-head">
              <Link to={`/p/${p.id}`} className="feed-thread">{p.threadTitle}</Link>
              {p.visible === 2 && <Label tone="danger">Đã xóa</Label>}
              {p.visible === 0 && <Label tone="warn">Chờ duyệt</Label>}
            </div>
            <p className="muted feed-meta">
              {formatDate(p.dateline)}
              {p.forum && <> trong <Link to={`/f/${p.forum.id}`}>{p.forum.title}</Link></>}
            </p>
            {p.snippet && <p className="feed-snippet">{p.snippet}</p>}
          </li>
        ))}
      </ul>
      <Pagination page={data.page} pages={data.pages} hrefFor={(n) => `/u/${id}/posts${n > 1 ? `?page=${n}` : ''}`} />
    </section>
  );
}

function PeopleList({ title, people, countLabel, empty }) {
  return (
    <section className="profile-block">
      <h2 className="block-title">{title}</h2>
      {people.length === 0 ? (
        <p className="empty">{empty}</p>
      ) : (
        <ul className="people">
          {people.map((p) => (
            <li key={p.id}>
              <UserLink id={p.id} name={p.username} color={p.color} />
              {p.count != null
                ? <span className="muted"> {formatNumber(p.count)} {countLabel}</span>
                : p.joinDate ? <span className="muted"> tham gia {formatDay(p.joinDate)}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FriendsTab({ id }) {
  const { data, loading, error } = useApi(`/api/users/${id}/friends`);
  if (!data) return <Status loading={loading} error={error} />;
  return (
    <div className="profile">
      <PeopleList title="Bạn bè" people={data.friends} empty="Chưa kết bạn với ai." />
      {data.contacts.length > 0 && (
        <PeopleList title="Danh sách liên hệ" people={data.contacts} empty="" />
      )}
      <PeopleList title="Hay cảm ơn bài của người này" people={data.thankedBy} countLabel="lần" empty="Chưa có ai cảm ơn." />
      <PeopleList title="Người này hay cảm ơn" people={data.thanked} countLabel="lần" empty="Chưa cảm ơn ai." />
    </div>
  );
}
