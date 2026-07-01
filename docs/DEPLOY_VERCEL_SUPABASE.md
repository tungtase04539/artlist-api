# Deploy: Vercel + Supabase (serverless, không cần VPS)

Hệ thống chạy như Vercel Functions, DB là Supabase Postgres. Cookie artlist được
**bền hoá trong DB** (bảng `app_settings`) nên mọi instance serverless dùng chung —
tự gia hạn (Set-Cookie) và cập nhật qua `POST /admin/session` đều tồn tại.

---

## 1. Supabase (DB)

1. Tạo project tại https://supabase.com → chờ provisioning.
2. **Project Settings → Database → Connection string → chọn tab "Transaction pooler"**
   (host `...pooler.supabase.com`, **port 6543** — bắt buộc cho serverless).
   Copy URI dạng:
   ```
   postgresql://postgres.<ref>:<PASSWORD>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
3. Không cần tạo bảng tay — app tự chạy migrate ở request đầu tiên.

## 2. Biến môi trường (đặt trong Vercel → Project → Settings → Environment Variables)

| Biến | Bắt buộc | Giá trị |
|---|---|---|
| `ADMIN_TOKEN` | ✅ | Chuỗi mạnh, sinh: `openssl rand -hex 32` |
| `DATABASE_URL` | ✅ | URI Transaction pooler ở bước 1 |
| `CRON_SECRET` | ✅ | `openssl rand -hex 32` (bảo vệ `/cron/sweep`) |
| `ARTLIST_BASE_URL` | ✅ | `https://toolkit.artlist.io` |
| `ARTLIST_USER_AGENT` | ✅ | Đúng User-Agent trình duyệt đã tạo cookie |
| `ARTLIST_COOKIE` | ⬜ | Cookie seed ban đầu (có thể để trống rồi nạp qua API — xem bước 5) |
| `PG_POOL_MAX` | ⬜ | `2` (serverless: mỗi instance 1 pool nhỏ, pooler lo phần còn lại) |

## 3. Deploy

- **Cách A (UI):** Import repo `tungtase04539/artlist-api` vào Vercel, branch
  `claude/seedance-artlist-api-h0q89u` (hoặc merge vào `main`), đặt env ở bước 2, Deploy.
- **Cách B (CLI):**
  ```bash
  npm i -g vercel
  vercel link            # chọn project
  vercel env add ...     # hoặc set ở dashboard
  vercel --prod
  ```

`vercel.json` đã cấu hình: mọi path → `api/index.js`, cron `/cron/sweep` mỗi phút
(Hobby plan giới hạn 1 lần/ngày — không sao, client poll `GET /v1/videos/:id`
cũng tự đẩy job; cron chỉ là lưới an toàn).

## 4. Kiểm tra sau deploy

```bash
BASE=https://<project>.vercel.app
curl $BASE/health                                   # {status:ok,...}
curl -X POST $BASE/admin/session/check -H "authorization: Bearer $ADMIN_TOKEN"
```

## 5. Nạp cookie artlist (nếu chưa set qua env)

```bash
curl -X POST $BASE/admin/session \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"cookie":"<toàn bộ cookie từ trình duyệt>","userAgent":"<UA khớp>"}'
```
→ Cookie được ghi vào DB, mọi instance dùng ngay, không cần redeploy.

## 6. Tạo khách + đưa key

```bash
curl -X POST $BASE/admin/clients \
  -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Khach A","credits":50000,"ratePerMin":6}'
# → { apiKey: "sk_...", ... }  → gửi key + link docs cho khách
```
Khách dùng: `POST /v1/videos` + `GET /v1/videos/:id` với header `x-api-key`.
Docs máy đọc được: `GET $BASE/openapi.json` · Docs người đọc: `GET $BASE/docs`.

---

## Vận hành (điểm cần chú ý ở serverless)

- **Cookie sống bao lâu:** `cf_clearance`/`__cf_bm` hết hạn sau ~30′–vài giờ. App tự
  gia hạn khi còn gọi được; khi chết hẳn → `checkSessionHealth` tạo **alert** và khách
  nhận lỗi `SESSION_EXPIRED`. Lúc đó chỉ cần chạy lại **bước 5** với cookie mới.
- **Theo dõi:** `GET /admin/alerts`, `GET /admin/stats`, `GET /admin/usage`
  (đều cần `authorization: Bearer $ADMIN_TOKEN`).
- **Credits là trần thật:** mọi khách rút chung từ credits của tài khoản artlist của bạn.
- **`ADMIN_TOKEN` = chìa khoá toàn quyền** — giữ kín, chỉ dùng phía bạn, đừng đưa khách.
