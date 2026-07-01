# Artlist Video API (multi-tenant)

Dịch vụ API tạo video AI (video-only) bọc artlist.io, dạng **admin ↔ client**:
**admin** (bạn) cung cấp "nguyên liệu" artlist (cookie/credits), cấp **API key** + **hạn mức credits**
cho từng **client** (bên thứ ba); có **catalog đủ model + thông số**, **docs**, và **giám sát/cảnh báo lạm dụng**.

> ⚠️ **Rủi ro**: cung cấp truy cập artlist cho bên thứ ba qua API tự chế **vi phạm ToS nặng** →
> có thể **khóa tài khoản** (mất credits) và tranh chấp với artlist. Cookie gắn IP+UA, hết hạn nhanh →
> cần cơ chế làm mới session. Tự cân nhắc trước khi vận hành thương mại.

## Kiến trúc
```
Client (bên thứ ba) ──X-API-Key──▶ /v1/*   (models, tạo/tra video)
Admin (bạn)         ──ADMIN_TOKEN─▶ /admin/* + /dashboard (clients, keys, credits, alerts, session)
                                     │
                       credits ◀─ quote thật ─ artlist.io (tRPC, cookie admin)
SQLite: clients · api_keys · credit_ledger · jobs · usage_events · alerts
```

## Cài & chạy (local)
```bash
npm install
cp .env.example .env      # ADMIN_TOKEN (bắt buộc) + ARTLIST_COOKIE + ARTLIST_USER_AGENT
npm run dev               # DB: để trống DATABASE_URL => PGlite in-process (không cần cài Postgres)
```
- Docs (Swagger): `http://localhost:3000/docs`
- Dashboard admin: `http://localhost:3000/dashboard` (nhập ADMIN_TOKEN)
- Health: `GET /health`

**DB**: prod dùng **Postgres/Supabase** qua `DATABASE_URL`; local để trống → **PGlite** (Postgres in-process, cùng schema).

## Deploy: Vercel + Supabase
1. Tạo project **Supabase** → lấy connection string (dùng **pooler** `:6543`) đặt vào `DATABASE_URL`.
2. Deploy repo lên **Vercel** (đã có `vercel.json`: mọi path → `api/index.js`; **Cron** gọi `/cron/sweep` mỗi phút).
3. Env trên Vercel: `ADMIN_TOKEN`, `DATABASE_URL`, `ARTLIST_COOKIE`, `ARTLIST_USER_AGENT`, `CRON_SECRET` (Vercel tự gửi Bearer cho cron).
4. ⚠️ IP serverless **xoay** → `cf_clearance` dễ bị Cloudflare challenge. Nên định tuyến call artlist qua **1 egress IP cố định** (proxy) khớp trình duyệt tạo cookie.
- Không poll nền: `GET /v1/videos/:id` tự đẩy trạng thái; **Cron** `/cron/sweep` dọn job treo + hoàn credits.

## Quy trình Admin
Tất cả `/admin/*` cần header `x-admin-token: <ADMIN_TOKEN>`.
```bash
# 1) Tạo client (kèm credits) → nhận apiKey (chỉ hiện 1 lần)
curl -X POST localhost:3000/admin/clients -H "x-admin-token: $T" -H 'content-type: application/json' \
  -d '{"name":"Khach A","credits":50000,"ratePerMin":6,"ratePerDay":200}'

# 2) Nạp thêm credits
curl -X POST localhost:3000/admin/clients/<id>/credits -H "x-admin-token: $T" -d '{"amount":100000}'

# 3) Cấp thêm / thu hồi key
curl -X POST localhost:3000/admin/clients/<id>/keys   -H "x-admin-token: $T"
curl -X POST localhost:3000/admin/keys/<keyId>/revoke -H "x-admin-token: $T"

# 4) Khoá / mở client
curl -X POST localhost:3000/admin/clients/<id>/status -H "x-admin-token: $T" -d '{"status":"suspended"}'

# 5) Gán session artlist mặc định cho client (client khỏi phải truyền chatSessionId)
curl -X POST localhost:3000/admin/clients/<id>/session -H "x-admin-token: $T" -d '{"chatSessionId":"<id-tu-URL-artlist>"}'

# 6) Cập nhật cookie artlist LÚC CHẠY (khi hết hạn, không cần restart)
curl -X POST localhost:3000/admin/session -H "x-admin-token: $T" -d '{"cookie":"<cookie>","userAgent":"<UA>"}'

# 6) Xem thống kê / cảnh báo / usage
curl localhost:3000/admin/stats  -H "x-admin-token: $T"
curl localhost:3000/admin/alerts -H "x-admin-token: $T"
```

## Client API (`/v1/*`, header `X-API-Key`)
```bash
# Danh sách model video (40 model: Seedance, Veo, Kling, Sora, Hailuo, Wan, LTX...)
curl localhost:3000/v1/models -H "x-api-key: $K"

# Thông số đầy đủ 1 model (options + default)
curl localhost:3000/v1/models/358 -H "x-api-key: $K"

# Tạo video (async) — trừ credits theo GIÁ QUOTE THẬT
curl -X POST localhost:3000/v1/videos -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "modelGroupId": 358,
  "prompt": "a red panda skateboarding, cinematic",
  "chatSessionId": "<session-artlist-co-san>",
  "settings": {"resolution":"720p","duration":4,"aspect_ratio":"16:9","generate_audio":true},
  "maxCredits": 2000
}'
# → 202 {"jobId":"...","status":"processing","credits":1200}

# Poll trạng thái
curl localhost:3000/v1/videos/<jobId> -H "x-api-key: $K"
# → {"status":"done","videoUrl":"https://...mp4","thumbnailUrl":"...","credits":1200}
```
- Giá **thật** tính theo `modelGroupId + settings` (server artlist resolve model + báo giá). `resolution:1080p` → model & giá khác `720p`.
- `maxCredits`: trần giá (từ chối nếu quote vượt). `expectedCredits`: giá bạn dự tính (lệch → từ chối, chống nhầm/cheat).
- `chatSessionId`: **tuỳ chọn** — nếu bỏ trống, API **tự tạo session** (chatSession.createChatSession) và lưu làm mặc định cho client (các job sau tái dùng). Admin cũng có thể gán sẵn qua `POST /admin/clients/:id/session`.
- **Image-to-video**: gửi `image` = URL ảnh (png/jpg/webp, ≤ `MAX_IMAGE_MB`). API tải ảnh → upload lên artlist (presigned S3) → set `image_url` + `feature=image-to-video` tự động.
- **Chống cheat**: gửi `expectedCredits` lệch giá thật → **tự khoá client** (`ABUSE_AUTO_SUSPEND`). Concurrency tối đa `MAX_CONCURRENT_PER_CLIENT` job/client.
- **Session health**: Cron `/cron/sweep` + `POST /admin/session/check` tự phát hiện cookie hết hạn → cảnh báo `session_expired`.

## Hạn mức & billing
- Mỗi client có **số dư credits** (admin nạp). Tạo video trừ theo **giá quote thật**; **hoàn credits** nếu create/poll thất bại.
- **Rate limit**/client: `ratePerMin`, `ratePerDay` (số video). Trần chống spam request: 120 req/phút/client.

## Chống lạm dụng / cheat (Dashboard + log)
Ghi `usage_events`, dựng `alerts` khi phát hiện:
`rate_abuse` (spam/vượt rate) · `quota_abuse` (liên tục cố tạo khi hết credits) ·
`error_spike` (tỉ lệ lỗi cao — dò endpoint) · `key_sharing` (1 key nhiều IP) ·
`price_mismatch` (cheat giá) · `session_expired` (cookie hết hạn). Xem ở `/dashboard` hoặc `GET /admin/alerts`.

## Vận hành cần lưu ý
- **Session artlist**: `cf_clearance`/`__cf_bm` hết hạn ~30–60'. Khi `GET /admin/session` báo không hợp lệ →
  lấy cookie mới và `POST /admin/session`. Nên chạy nơi **IP cố định khớp trình duyệt** đã tạo cookie.
- Không commit `.env`/cookie. SQLite ở `data/` (đã gitignore).

## Test
```bash
npm test          # unit test (offline): parse artlist + billing/credits (SQLite in-memory)
npm run test:quote  # smoke QUOTE read-only (cần .env cookie) — kiểm tra session còn sống
```

## Cấu trúc
```
api/index.js            # entry serverless Vercel (mọi path → Fastify)
src/
├── app.js              # buildApp() dùng chung standalone & serverless
├── index.js            # standalone (VPS/local) + interval sweep
├── config.js           # env (ADMIN_TOKEN, DATABASE_URL, artlist, rate limits, ngưỡng abuse)
├── db/                 # Postgres (pg/Supabase) hoặc PGlite (local) + repos
├── auth/               # clientAuth (X-API-Key) · adminAuth (ADMIN_TOKEN)
├── artlist/            # client + endpoints (tRPC) + catalog (models/params) + session
├── videos/service.js   # quote → trừ credits → create; advanceJob (poll on-demand) + sweep
├── abuse/monitor.js    # rate limit + phát hiện cheat + alerts (dedup qua DB)
├── routes/             # v1 (client) · admin · docs · system (/cron/sweep)
└── dashboard/          # trang admin tĩnh
vercel.json             # rewrites + cron /cron/sweep
```
Chi tiết reverse-engineering artlist: xem `docs/`.
