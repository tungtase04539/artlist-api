# Artlist Seedance 2 — Unofficial API

REST API cá nhân bọc tính năng tạo video **Seedance 2** trên artlist.io, bằng cách
replay các HTTP request đã xác thực bằng cookie/token của chính bạn.

> ⚠️ **Dùng cho mục đích cá nhân.** Việc truy cập tự động có thể vi phạm ToS của
> artlist và dẫn tới **khóa tài khoản**. Tự cân nhắc rủi ro. Không commit cookie/token.

## Tài liệu
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — kế hoạch triển khai 7 giai đoạn.
- [`docs/CAPTURE_GUIDE.md`](docs/CAPTURE_GUIDE.md) — cách bắt request từ trình duyệt (**làm trước tiên**).

## Trạng thái hiện tại
- ✅ Pipeline thật đã wire & **verify khớp request captured**: QUOTE → CREATE → POLL.
  - QUOTE:  `GET  /api/trpc/modelRouter.getCostQuote` → `{cost, digitalSignature, timestamp}`
  - CREATE: `POST /api/trpc/userGenerationRouter.createUserGeneration` (đính kèm chữ ký)
  - STATUS: `GET  /api/trpc/userGenerationRouter.getUserGeneration` (poll)
  - `chatSessionId` tự sinh **UUIDv7** (client-side, không cần request tạo session).
- ⏳ Cần xác nhận nốt: giá trị `status` khi **done** + field URL video (đã fallback `fileUrl`/`url`/`outputs[].fileUrl`).
- ▶️ **Chạy thử được ngay**: điền `.env` (cookie + user-agent) rồi `npm run dev`.

## Chạy thử
```bash
npm install
cp .env.example .env      # rồi điền API_KEY (bắt buộc)
npm run dev
```
Kiểm tra:
```bash
curl localhost:3000/health
# {"status":"ok","artlistConfigured":false,"sessionValid":true}
```

## Dùng API (sau khi cấu hình artlist)
```bash
# Tạo video
curl -X POST localhost:3000/api/videos \
  -H "X-API-Key: <API_KEY của bạn>" \
  -H "content-type: application/json" \
  -d '{"prompt":"a cat surfing, cinematic","duration":5,"aspectRatio":"16:9"}'
# → 202 {"jobId":"job_...","status":"processing"}

# Poll trạng thái
curl localhost:3000/api/videos/job_xxx -H "X-API-Key: <API_KEY>"
# → {"status":"done","videoUrl":"https://....mp4"}
```

## Cấu trúc
```
src/
├── index.js            # bootstrap Fastify + X-API-Key + /health
├── config.js           # đọc & validate .env (zod)
├── lib/                # logger (redact secret) + http retry/backoff
├── session/            # cookie/token, phát hiện session hết hạn
├── artlist/            # ⭐ lớp replay — điền endpoint thật ở endpoints.js
├── jobs/               # store (Map) + manager (worker poll nền)
└── routes/             # POST/GET /api/videos
```

## Khi cookie hết hạn
`/health` trả `sessionValid:false` (hoặc API trả 401 kèm thông báo). Cập nhật
`ARTLIST_COOKIE` trong `.env` rồi khởi động lại server.

## Việc còn lại để hoàn thiện
1. Điền `.env` (cookie + `ARTLIST_USER_AGENT`) và **chạy thử local** (cùng IP với trình duyệt).
2. Gửi lại 1 response `getUserGeneration` lúc video **done** để chốt field URL + giá trị `status`.
3. (Tuỳ chọn) image-to-video: xác nhận field ảnh trong `inputs`/`artifacts`.
