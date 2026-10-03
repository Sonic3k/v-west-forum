import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { parseBBCode, nodeText, safeUrl, internalRoute, internalImage } from '../lib/bbcode.js';
import { decodeEntities } from '../lib/text.js';
import { useSmilies } from '../lib/smilies.jsx';

const SIZES = { 1: '0.75em', 2: '0.875em', 3: '1em', 4: '1.25em', 5: '1.5em', 6: '1.875em', 7: '2.25em' };
const COLOR_RE = /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i;
const FONT_RE = /^[\w\s,'-]{1,60}$/;
const URL_RE = /\bhttps?:\/\/[^\s<>"'[\]]+/gi;

export default function BBCode({ text, tree, attachments, sigpic, className = 'bb' }) {
  const smilies = useSmilies();
  const root = useMemo(() => tree || parseBBCode(text), [text, tree]);
  return <div className={className}>{renderNodes(root.children, { attachments, smilies, sigpic }, 'n')}</div>;
}

// Thay mã smilie (ví dụ 3lol3) bằng ảnh trong một đoạn chữ thường.
function withSmilies(text, smilies, keyPrefix) {
  if (!smilies || !text) return [text];
  const out = [];
  let idx = 0;
  for (const m of text.matchAll(smilies.re)) {
    if (m.index > idx) out.push(text.slice(idx, m.index));
    out.push(
      <img
        key={`${keyPrefix}s${m.index}`}
        className="smilie"
        src={smilies.map.get(m[0])}
        alt={m[0]}
        title={m[0]}
        loading="lazy"
      />,
    );
    idx = m.index + m[0].length;
  }
  if (idx < text.length) out.push(text.slice(idx));
  return out;
}

function renderNodes(nodes, ctx, prefix) {
  return nodes.map((node, i) => renderNode(node, ctx, `${prefix}.${i}`));
}

function SmartLink({ href, children }) {
  const route = internalRoute(href);
  if (route) return <Link to={route}>{children}</Link>;
  if (!/^(https?|ftp|mailto):/i.test(href)) return <span>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
    </a>
  );
}

function RemoteImage({ src, alt = '' }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <a className="bb-broken" href={src} target="_blank" rel="noopener noreferrer nofollow">
        Ảnh không còn tải được
      </a>
    );
  }
  return (
    <img
      className="bb-img"
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
}

function InlineAttachment({ id, attachments }) {
  const a = attachments?.get(id);
  const url = `/api/attachments/${id}`;
  if (a && !a.isImage) return <a href={url}>{a.filename}</a>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="bb-attach">
      <RemoteImage src={url} alt={a?.filename || ''} />
    </a>
  );
}

function Quote({ opt, children }) {
  const [name, postId] = (opt || '').split(';');
  const who = decodeEntities(name || '').trim();
  const pid = (postId || '').trim();
  return (
    <blockquote className="bb-quote">
      {who && (
        <div className="bb-quote-by">
          {/^\d+$/.test(pid) ? <Link to={`/p/${pid}`}>{who} viết</Link> : `${who} viết`}
        </div>
      )}
      {children}
    </blockquote>
  );
}

function renderText(str, key, ctx = {}) {
  const s = decodeEntities(str);
  const out = [];
  s.split('\n').forEach((line, li) => {
    if (li > 0) out.push(<br key={`br${li}`} />);
    let idx = 0;
    for (const m of line.matchAll(URL_RE)) {
      if (m.index > idx) out.push(...withSmilies(line.slice(idx, m.index), ctx.smilies, `${li}.${idx}`));
      out.push(
        <SmartLink key={`u${li}.${m.index}`} href={m[0]}>
          {m[0]}
        </SmartLink>,
      );
      idx = m.index + m[0].length;
    }
    if (idx < line.length) out.push(...withSmilies(line.slice(idx), ctx.smilies, `${li}.${idx}`));
  });
  return <React.Fragment key={key}>{out}</React.Fragment>;
}

function renderNode(node, ctx, key) {
  if (typeof node === 'string') return renderText(node, key, ctx);
  const kids = () => renderNodes(node.children, ctx, key);
  const plain = () => <React.Fragment key={key}>{kids()}</React.Fragment>;

  switch (node.tag) {
    case 'b': return <strong key={key}>{kids()}</strong>;
    case 'i': return <em key={key}>{kids()}</em>;
    case 'u': return <u key={key}>{kids()}</u>;
    case 's':
    case 'strike': return <s key={key}>{kids()}</s>;
    case 'sub': return <sub key={key}>{kids()}</sub>;
    case 'sup': return <sup key={key}>{kids()}</sup>;
    case 'highlight': return <mark key={key}>{kids()}</mark>;
    case 'color':
      return COLOR_RE.test(node.opt || '') ? <span key={key} style={{ color: node.opt }}>{kids()}</span> : plain();
    case 'size': {
      const n = Math.min(7, Math.max(1, Number.parseInt(node.opt, 10) || 3));
      return <span key={key} style={{ fontSize: SIZES[n] }}>{kids()}</span>;
    }
    case 'font':
      return FONT_RE.test(node.opt || '') ? <span key={key} style={{ fontFamily: node.opt }}>{kids()}</span> : plain();
    case 'left':
    case 'center':
    case 'right':
      return <div key={key} style={{ textAlign: node.tag }}>{kids()}</div>;
    case 'indent': return <div key={key} className="bb-indent">{kids()}</div>;
    case 'url': {
      const href = safeUrl(node.opt ?? nodeText(node));
      return href ? <SmartLink key={key} href={href}>{kids()}</SmartLink> : plain();
    }
    case 'email': {
      const addr = decodeEntities(node.opt || node.raw || '').trim();
      return /^[^\s@]+@[^\s@]+$/.test(addr)
        ? <a key={key} href={`mailto:${addr}`}>{decodeEntities(node.raw || addr)}</a>
        : renderText(node.raw || '', key);
    }
    case 'img': {
      const src = safeUrl(node.raw);
      const local = src ? internalImage(src) : null;
      if (local) return <RemoteImage key={key} src={local} />;
      return src && /^https?:/i.test(src) ? <RemoteImage key={key} src={src} /> : renderText(node.raw, key);
    }
    case 'quote': return <Quote key={key} opt={node.opt}>{kids()}</Quote>;
    case 'code':
    case 'php':
    case 'html':
      return <pre key={key} className="bb-code"><code>{decodeEntities(node.raw)}</code></pre>;
    case 'noparse': return renderText(node.raw, key);
    case 'list': {
      const items = node.children.filter((c) => typeof c !== 'string' || c.trim());
      const children = renderNodes(items, ctx, key);
      return node.opt && /^[1aAiI]$/.test(node.opt)
        ? <ol key={key} type={node.opt}>{children}</ol>
        : <ul key={key}>{children}</ul>;
    }
    case '*': return <li key={key}>{kids()}</li>;
    case 'attach': {
      const id = Number.parseInt(node.raw, 10);
      return Number.isInteger(id) ? <InlineAttachment key={key} id={id} attachments={ctx.attachments} /> : null;
    }
    case 'youtube': {
      const vid = (node.raw || '').trim();
      return /^[\w-]{6,20}$/.test(vid)
        ? <SmartLink key={key} href={`https://www.youtube.com/watch?v=${vid}`}>Video YouTube ({vid})</SmartLink>
        : renderText(node.raw, key);
    }
    case 'sigpic':
      return ctx.sigpic
        ? <RemoteImage key={key} src={ctx.sigpic} alt={decodeEntities(node.raw || '').trim() || 'Ảnh chữ ký'} />
        : null;
    case 'video': {
      const href = safeUrl(node.raw);
      return href ? <SmartLink key={key} href={href}>{href}</SmartLink> : renderText(node.raw, key);
    }
    default: return plain();
  }
}
