const TZ = 'Asia/Ho_Chi_Minh';
const dateTime = new Intl.DateTimeFormat('vi-VN', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const dateOnly = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
const numbers = new Intl.NumberFormat('vi-VN');

export const formatDate = (ts) => (ts ? dateTime.format(new Date(ts * 1000)) : '');
export const formatDay = (ts) => (ts ? dateOnly.format(new Date(ts * 1000)) : '');
export const formatNumber = (n) => numbers.format(n || 0);
export const formatSize = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((bytes || 0) / 1024))} KB`;
