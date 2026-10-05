import React, { useRef, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { useApi } from '../lib/api.js';
import { formatDate, formatNumber } from '../lib/format.js';
import BBCode from '../components/BBCode.jsx';
import { collectAttachIds, parseBBCode } from '../lib/bbcode.js';
import { Status } from '../components/ui.jsx';

// Kiểu chữ cho file HTML tải về (file đứng một mình, không cần panel).
const FILE_CSS = `
body{margin:0;background:#fff;color:#1a2230;font:16px/1.65 Georgia,"Times New Roman",serif}
main{max-width:760px;margin:0 auto;padding:24px 18px 48px}
h1{font-size:28px;line-height:1.2;margin:0 0 8px}
.export-meta,.export-post header,.export-extra{font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#5b6577}
.export-post{border-top:1px solid #c9d0db;padding:12px 0 16px}
.export-post header strong{color:#1a2230}
.bb img{max-width:100%;height:auto}
.smilie{vertical-align:middle}
.bb-quote{margin:10px 0;padding:8px 12px;background:#eef1f5;border-left:3px solid #a9b3c2}
.bb-quote-by{font:600 13px system-ui,sans-serif;color:#5b6577}
.bb-code{background:#eef1f5;padding:8px;overflow-x:auto;font:13px/1.5 monospace}
.export-attach img{max-width:100%;height:auto;margin:6px 0}
a{color:#24508a}
`;

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function slugify(text) {
  return String(text || 'chu-de')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'chu-de';
}

// Nhúng ảnh của panel (đính kèm, avatar, smilie) vào file để file vẫn xem được khi không có mạng.
async function buildStandaloneHtml(node, title) {
  const clone = node.cloneNode(true);
  const origin = window.location.origin;
  await Promise.all(
    [...clone.querySelectorAll('img')].map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src.startsWith('/api/')) return;
      try {
        // Rescued images may live on the CDN: ask the panel to pass the bytes through (no CORS issue).
        const res = await fetch(src.startsWith('/api/external') ? `${src}&proxy=1` : src);
        if (!res.ok) throw new Error(String(res.status));
        img.setAttribute('src', await blobToDataUrl(await res.blob()));
        img.removeAttribute('loading');
      } catch {
        img.setAttribute('src', origin + src);
      }
    }),
  );
  clone.querySelectorAll('a[href^="/"]').forEach((a) => a.setAttribute('href', origin + a.getAttribute('href')));
  const safeTitle = title.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  return `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title><style>${FILE_CSS}</style></head>
<body><main>${clone.innerHTML}</main></body></html>`;
}

export default function ThreadExport() {
  const { id } = useParams();
  const { data, loading, error } = useApi(`/api/threads/${id}/all`);
  const docRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  if (data?.redirect) return <Navigate replace to={`/t/${data.redirect}/export`} />;
  if (!data) return <main className="page"><Status loading={loading} error={error} /></main>;
  const { thread, forum, posts, poll } = data;

  const download = async () => {
    setBusy(true);
    setMessage('');
    try {
      const html = await buildStandaloneHtml(docRef.current, thread.title);
      const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `${slugify(thread.title)}.html`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      setMessage('Đã tạo file. Nếu trình duyệt hỏi, chọn Tải xuống hoặc Lưu vào Tệp.');
    } catch (err) {
      setMessage(`Không tạo được file: ${err.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page export-page">
      <div className="export-actions no-print">
        <Link to={`/t/${id}`}>Quay lại chủ đề</Link>
        <div className="export-buttons">
          <button type="button" className="btn" onClick={download} disabled={busy}>
            {busy ? 'Đang tạo file…' : 'Tải file HTML'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => window.print()}>
            In hoặc lưu PDF
          </button>
        </div>
        <p className="hint muted">
          File HTML chứa sẵn ảnh đính kèm, mở được trên mọi máy kể cả khi không có mạng. Lưu PDF: bấm nút in rồi
          chọn Lưu thành PDF (trên điện thoại: Chia sẻ, In, rồi lưu).
        </p>
        {message && <p className="hint" role="status">{message}</p>}
      </div>

      <article ref={docRef} className="export-doc">
        <h1 className="page-title">{thread.title}</h1>
        <p className="export-meta">
          {forum && <>Box {forum.title}. </>}
          Lập bởi {thread.starter.username || 'Khách'}, {formatDate(thread.dateline)}. {formatNumber(posts.length)} bài.
          Lưu từ diễn đàn V-Westlife (bản sao lưu ngày 11/12/2012).
        </p>
        {poll && (
          <section className="export-post">
            <header><strong>Bình chọn:</strong> {poll.question}</header>
            <ul>
              {poll.options.map((o, i) => <li key={i}>{o.text}: {formatNumber(o.votes)} phiếu</li>)}
            </ul>
          </section>
        )}
        {posts.map((p) => {
          const attachMap = new Map(p.attachments.map((a) => [a.id, a]));
          const tree = parseBBCode(p.pagetext);
          const inlined = collectAttachIds(tree);
          const extra = p.attachments.filter((a) => !inlined.has(a.id));
          return (
            <section key={p.id} className="export-post">
              <header>
                #{p.number} <strong>{p.author?.username || p.username || 'Khách'}</strong>, {formatDate(p.dateline)}
                {p.visible === 2 ? ' (đã xóa)' : ''}
              </header>
              {p.title && <p><strong>{p.title}</strong></p>}
              <BBCode tree={tree} attachments={attachMap} />
              {extra.length > 0 && (
                <div className="export-attach">
                  {extra.map((a) => (a.isImage
                    ? <img key={a.id} src={`/api/attachments/${a.id}`} alt={a.filename} />
                    : <p key={a.id} className="export-extra">Đính kèm: {a.filename}</p>))}
                </div>
              )}
              {p.thanks.length > 0 && (
                <p className="export-extra">Cảm ơn: {p.thanks.map((t) => t.username).join(', ')}</p>
              )}
              {p.comments.map((c) => (
                <p key={c.id} className="export-extra">
                  {c.username}, {formatDate(c.dateline)}: {c.text}
                </p>
              ))}
            </section>
          );
        })}
      </article>
    </main>
  );
}
