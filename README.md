# V-Westlife – kho lưu trữ diễn đàn

Panel chỉ đọc cho database vBulletin 4 của diễn đàn V-Westlife (bản sao lưu 11/12/2012).
Node (Express) + React (Vite), deploy trên Railway bằng `Dockerfile`.

## Biến môi trường

- `DATABASE_URL` (bắt buộc): đặt bằng `${{MySQL.MYSQL_URL}}` để dùng mạng nội bộ của Railway.
- `PANEL_PASSWORD` (tùy chọn): đặt thì trình duyệt sẽ hỏi mật khẩu trước khi vào panel.

Kiểm tra kết nối database: mở `/api/health/db`.
