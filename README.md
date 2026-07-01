# Artlist Seedance 2 — Unofficial API

REST API cá nhân bọc tính năng tạo video **Seedance 2** trên artlist.io, bằng cách
replay các HTTP request đã xác thực bằng cookie/token của chính bạn.

> ⚠️ **Dùng cho mục đích cá nhân.** Việc truy cập tự động có thể vi phạm ToS của
> artlist và dẫn tới **khóa tài khoản**. Tự cân nhắc rủi ro. Không commit cookie/token.

## Tài liệu
- [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md) — kế hoạch triển khai 7 giai đoạn.
- [`docs/CAPTURE_GUIDE.md`](docs/CAPTURE_GUIDE.md) — cách bắt request từ trình duyệt (**làm trước tiên**).

## Trạng thái hiện tại — ✅ ĐÃ CHẠY THẬT (tạo video end-to-end thành công)
Đã tạo 1 video Seedance thật (video/mp4 1280×720, có audio, ~2MB). Toàn bộ pipeline verify LIVE:
- QUOTE:  `GET  /api/trpc/modelRouter.getCostQuote` — input `{ modelGroupId: 358, input: { modelId: 2524, ...settings } }` → `{ cost, digitalSignature, timestamp }`
- CREATE: `POST /api/trpc/userGenerationRouter.createUserGeneration` → `{ success, data: { id } }`
- STATUS: `GET  /api/trpc/userGenerationRouter.getUserGeneration` — poll tới `status:"completed"` + `videoUrl`
- ⚠️ `chatSessionId` **PHẢI có sẵn** (session artlist). uuid tự sinh → 404. Lấy từ URL `toolkit.artlist.io/{id}`.
- Seedance 2.0: **modelGroupId=358**, **modelId=2524** (720p T2V, hỗ trợ audio). Giá ~1200 credits/video.

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
  -d '{"prompt":"a cat surfing, cinematic","duration":4,"resolution":"720p","aspectRatio":"16:9","chatSessionId":"<id-tu-URL-artlist>"}'
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

## Việc còn lại (tuỳ chọn — core đã chạy thật)
1. Truyền `chatSessionId` có sẵn khi gọi `POST /api/videos` (copy từ URL project trên artlist).
2. (Tự động hoá) Tìm endpoint tạo chatSession để API tự tạo project mới — nằm ở chunk JS chưa phân tích.
3. (Tuỳ chọn) image-to-video: xác nhận field ảnh trong `inputs`/`artifacts` + `uploadRouter.getPresignedUrl`.
