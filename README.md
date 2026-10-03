# V-Westlife – kho lưu trữ diễn đàn

Panel chỉ đọc cho database vBulletin 4 của diễn đàn V-Westlife (bản sao lưu 11/12/2012).
Node (Express) + React (Vite), deploy trên Railway bằng `Dockerfile`.

## Biến môi trường

- `DATABASE_URL` (bắt buộc): đặt bằng `${{MySQL.MYSQL_URL}}` để dùng mạng nội bộ của Railway.
- `PANEL_PASSWORD` (tùy chọn): đặt thì trình duyệt sẽ hỏi mật khẩu trước khi vào panel.

Kiểm tra kết nối database: mở `/api/health/db`.

## Nhập avatar và smilie (chạy một lần trên máy)

Ảnh nằm trong bộ source forum (đã giải nén), không có trong database. Script nhập avatar, ảnh hồ sơ, ảnh chữ ký, smilie (gồm các bộ rabbit, onion...) và avatar có sẵn. Cần bật TCP Proxy của MySQL trong lúc chạy:

```powershell
cd server
npm install
$env:DATABASE_URL = "mysql://root:<password>@<host>:<port>/railway"
node tools/import-assets.js "E:\FC Westlife\4rum VW\forum\forum"
```

Panel tự tạo thêm bảng `panel_post_search`, `panel_meta` (tìm kiếm) và dùng bảng `panel_asset` (ảnh); bảng gốc của vBulletin không bị sửa.
