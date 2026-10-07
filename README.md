# Kwihh Project — "Code Your Ideas. Build Your Future."
Nền tảng bán Bot / Tool / Tiện ích / Website với landing 3D, ví số dư, nạp thẻ duyệt tay, admin panel.

## Chạy nhanh (không cần npm install — 0 dependency)
Yêu cầu: **Node.js >= 22.5** (dùng `node:sqlite`, `node:crypto` có sẵn).
1. `cp .env.example .env` rồi export biến (hoặc đặt trực tiếp): `ADMIN_PASSWORD=... DEMO_PASSWORD=... PORT=3000`
2. `npm run seed`  → tạo DB `data/kwihh.db`, tài khoản `admin` + `demo` (20.000đ), 6 dịch vụ mẫu. Nếu không đặt ADMIN_PASSWORD, mật khẩu admin ngẫu nhiên được in ra **một lần**.
3. `npm start` → http://localhost:3000
4. `npm test` → 30 kiểm tra end-to-end (auth, mua hàng, race condition, nạp thẻ, admin, bảo mật).

## Thêm file sản phẩm
Đặt file vào `files/dichvu/` rồi gán tên file cho dịch vụ trong Admin (vd `botzalopro50k.zip`). Thư mục này **không** được serve; chỉ tải qua `GET /api/orders/:id/download` sau khi kiểm tra quyền sở hữu đơn.

## Bảo mật đã áp dụng
scrypt hash password (salt riêng) · cookie HttpOnly + SameSite=Strict · rate-limit đăng nhập · thông báo lỗi đăng nhập thống nhất · SQL parameterized · escape XSS ở UI + CSP · API chỉ nhận JSON (chặn CSRF form) · middleware phân quyền ở backend · mua hàng/nạp tiền/chỉnh số dư dùng `BEGIN IMMEDIATE` (atomic, chống double-spend) · `CHECK(balance>=0)` · mọi biến động tiền ghi vào `transactions` · thẻ nạp luôn `pending` tới khi admin duyệt, không duyệt 2 lần · chống path traversal.

## Triển khai
Chạy sau reverse proxy HTTPS (Nginx/Caddy) và thêm `Secure` cho cookie; backup `data/kwihh.db`. Muốn dùng API thẻ cào thật: thay thân route `POST /api/recharge` bằng adapter gọi nhà cung cấp (secret nằm ở biến môi trường, không bao giờ ở frontend).
