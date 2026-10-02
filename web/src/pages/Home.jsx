import React from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { Announcements, ForumRow, Status, UserList } from '../components/ui.jsx';

export default function Home() {
  const { data, loading, error } = useApi('/api/forums');
  if (!data) return <main className="page"><Status loading={loading} error={error} /></main>;

  return (
    <main className="page">
      <h1 className="visually-hidden">Danh sách box</h1>
      <Announcements items={data.announcements} />
      {data.forums.map((node) =>
        node.isCategory ? (
          <section key={node.id} className="cat">
            <h2 className="cat-title"><Link to={`/f/${node.id}`}>{node.title}</Link></h2>
            {node.description && <p className="cat-desc">{node.description}</p>}
            <div className="flist">
              {node.children.map((f) => <ForumRow key={f.id} forum={f} />)}
            </div>
          </section>
        ) : (
          <section key={node.id} className="cat">
            <div className="flist"><ForumRow forum={node} /></div>
          </section>
        ),
      )}
      {data.superModerators.length > 0 && (
        <p className="supermods muted">
          Siêu quản lý toàn diễn đàn: <UserList users={data.superModerators} />
        </p>
      )}
    </main>
  );
}
