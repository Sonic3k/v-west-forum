import { createHash, timingSafeEqual } from 'node:crypto';

// Tùy chọn: chỉ bật khi đặt biến PANEL_PASSWORD. Không đặt thì panel mở tự do.
// Khi bật, trình duyệt tự hiện hộp hỏi mật khẩu (tên đăng nhập gõ gì cũng được).
const sha = (s) => createHash('sha256').update(s, 'utf8').digest();

export function passwordGate(req, res, next) {
  const password = process.env.PANEL_PASSWORD;
  if (!password) {
    next();
    return;
  }
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const given = decoded.slice(decoded.indexOf(':') + 1);
    if (timingSafeEqual(sha(given), sha(password))) {
      next();
      return;
    }
  }
  res.set('WWW-Authenticate', 'Basic realm="V-Westlife", charset="UTF-8"');
  res.status(401).send('Cần mật khẩu để xem.');
}
