import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { passwordGate } from './passwordGate.js';
import { forumsRouter } from './routes/forums.js';
import { threadsRouter, postsRouter } from './routes/threads.js';
import { attachmentsRouter } from './routes/attachments.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = process.env.WEB_DIST || path.resolve(here, '../../web/dist');

const app = express();
app.disable('x-powered-by');

// Railway healthcheck: không cần mật khẩu, không cần database.
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(passwordGate);

// Kiểm tra kết nối database: mở /api/health/db trên trình duyệt.
app.get('/api/health/db', async (req, res) => {
  const [rows] = await pool.query('SELECT VERSION() AS version, DATABASE() AS db');
  res.json({ ok: true, ...rows[0] });
});

app.use('/api/forums', forumsRouter);
app.use('/api/threads', threadsRouter);
app.use('/api/posts', postsRouter);
app.use('/api/attachments', attachmentsRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Không có API này.' }));

app.use('/assets', express.static(path.join(webDist, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(webDist, { index: false }));
app.use((req, res, next) => {
  if (req.method !== 'GET') {
    next();
    return;
  }
  res.sendFile(path.join(webDist, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) {
    next(err);
    return;
  }
  const detail = err.code ? `${err.code}: ${err.message}` : err.message;
  res.status(500).json({ error: `Lỗi máy chủ (${detail})` });
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => console.log(`V-Westlife panel đang chạy ở cổng ${port}`));
