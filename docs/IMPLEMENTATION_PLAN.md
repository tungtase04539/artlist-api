# Kế hoạch triển khai: Artlist Seedance 2 — Unofficial API

> Mục tiêu: Xây một REST API cá nhân bọc (wrap) tính năng tạo video **Seedance 2**
> trên artlist.io, bằng cách tái tạo (replay) các HTTP request mà trình duyệt gửi
> khi đăng nhập bằng cookie/token của chính bạn.

---

## 0. Giả định & Lưu ý quan trọng

- Bạn **có tài khoản artlist.io hợp lệ** (tốt nhất là bản trả phí có quyền dùng Seedance).
- API này dùng cho **mục đích cá nhân / tự động hoá công việc của chính bạn**.

### ⚠️ Rủi ro cần chấp nhận trước khi làm
| Rủi ro | Mức độ | Cách giảm thiểu |
|---|---|---|
| Vi phạm ToS của artlist → **khóa tài khoản** | Cao | Dùng cá nhân, giới hạn tần suất, không bán lại |
| Cookie/token **hết hạn** thường xuyên | Cao | Cơ chế phát hiện 401/403 + quy trình cập nhật session |
| Endpoint **đổi bất ngờ** → API hỏng | Trung bình | Tách client thành 1 lớp riêng, dễ sửa; có test bằng fixture |
| **Bot protection** (Cloudflare, TLS fingerprint) chặn | Trung bình–Cao | Dùng thư viện giả lập browser fingerprint nếu cần |
| Lộ **secret** (cookie) khi commit | Cao | `.env` + `.gitignore`, không hard-code |

---

## 1. Kiến trúc tổng quan

```
┌─────────────┐    HTTP     ┌──────────────────────────────────────┐
│  Client của │ ─────────▶ │            YOUR API SERVER            │
│   bạn (curl,│            │  ┌────────────┐   ┌────────────────┐  │
│   app, n8n) │ ◀───────── │  │ API Routes │──▶│  Job Manager   │  │
└─────────────┘            │  └────────────┘   └───────┬────────┘  │
                           │  ┌────────────┐           │           │
                           │  │  Session/  │◀──────────┤           │
                           │  │  Auth store│           ▼           │
                           │  └────────────┘   ┌────────────────┐  │
                           │                   │ Artlist Client │  │
                           │                   │ (replay layer) │  │
                           └───────────────────────────┬─────────┘
                                                        │ cookie/token
                                                        ▼
                                              ┌──────────────────┐
                                              │   artlist.io      │
                                              │  (private API)    │
                                              └──────────────────┘
```

**Luồng tạo video là bất đồng bộ (async):**
```
POST submit  ──▶ nhận jobId
GET  status  ──▶ poll lặp lại: pending → processing → done/failed
GET  result  ──▶ lấy URL video cuối cùng
```

---

## 2. Tech stack đề xuất

| Thành phần | Lựa chọn đề xuất | Lý do |
|---|---|---|
| Ngôn ngữ/Runtime | **Node.js 20+** | "Copy as cURL" → `fetch` dịch rất tự nhiên |
| Web framework | **Fastify** (hoặc Express) | Nhẹ, nhanh, schema validation sẵn |
| HTTP client | `undici` / `axios` | Kiểm soát header, cookie tốt |
| Chống bot (nếu cần) | `curl-impersonate` / `got-scraping` | Giả TLS/JA3 fingerprint của browser |
| Lưu job | Map in-memory → **SQLite** (better-sqlite3) | Bắt đầu đơn giản, nâng cấp sau |
| Config | `dotenv` + `zod` validate | An toàn secret, validate env |
| Test | `vitest` + fixture ghi lại response thật | Test không cần gọi thật |

> Có thể thay bằng **Python + FastAPI** nếu bạn quen Python hơn — kiến trúc giữ nguyên.

---

## 3. Cấu trúc thư mục dự kiến

```
artlist-api/
├── docs/
│   ├── IMPLEMENTATION_PLAN.md      # tài liệu này
│   └── CAPTURE_GUIDE.md            # hướng dẫn bắt request (Phase 1)
├── src/
│   ├── index.ts                    # bootstrap server
│   ├── config.ts                   # đọc & validate .env
│   ├── artlist/
│   │   ├── client.ts               # lớp replay: submit/status/result
│   │   ├── endpoints.ts            # URL + shape request (dễ sửa khi họ đổi)
│   │   └── types.ts                # kiểu dữ liệu request/response
│   ├── session/
│   │   └── session.ts              # quản lý cookie/token, phát hiện hết hạn
│   ├── jobs/
│   │   ├── manager.ts              # tạo job, worker poll, cập nhật trạng thái
│   │   └── store.ts                # lưu job (memory/SQLite)
│   ├── routes/
│   │   └── videos.ts               # POST /videos, GET /videos/:id ...
│   └── lib/
│       ├── http.ts                 # retry, backoff, xử lý 429/5xx
│       └── logger.ts
├── test/
│   └── fixtures/                   # response thật đã ghi lại (đã ẩn secret)
├── .env.example                    # KHÔNG chứa secret thật
├── .gitignore                      # .env, session.json, *.local
├── package.json
└── README.md
```

---

## 4. Hợp đồng API (API contract) dự kiến

### `POST /api/videos` — tạo video
```jsonc
// Request
{
  "prompt": "a cat surfing on a wave, cinematic",
  "image": "https://... (tuỳ chọn, cho image-to-video)",
  "model": "seedance-2",
  "duration": 5,            // giây
  "aspectRatio": "16:9",
  "resolution": "1080p"
}
// Response 202
{ "jobId": "abc123", "status": "pending" }
```

### `GET /api/videos/:jobId` — kiểm tra trạng thái
```jsonc
{ "jobId": "abc123", "status": "processing", "progress": 42 }
// khi xong:
{ "jobId": "abc123", "status": "done", "videoUrl": "https://...", "thumbnailUrl": "https://..." }
```

### `GET /api/videos/:jobId/download` — proxy tải file (tuỳ chọn)
### `GET /health` — kiểm tra server & tình trạng session

> Mọi endpoint của **BẠN** nên yêu cầu `X-API-Key` để không ai ngoài bạn gọi được.

---

## 5. Lộ trình theo giai đoạn (phased roadmap)

### 🔴 Phase 1 — Recon & Capture *(việc BẮT BUỘC bạn làm, mình không làm thay được)*
> Đây là bước phụ thuộc quan trọng nhất — cần chính session đăng nhập của bạn.

**Checklist bắt request:**
- [ ] Mở artlist.io, đăng nhập, vào tính năng tạo video Seedance.
- [ ] Mở **DevTools → Network**, bật **Preserve log**, xoá log cũ.
- [ ] Bấm **Generate** tạo 1 video thật.
- [ ] Tìm & lưu **3 request quan trọng** (chuột phải → *Copy as cURL*):
  1. **Submit** — request gửi khi bấm Generate (thường `POST`).
  2. **Status/Poll** — request lặp lại để hỏi tiến độ.
  3. **Result** — request trả về URL video cuối.
- [ ] Ghi lại cơ chế **auth**: cookie? `Authorization` header? CSRF token nằm ở đâu?
- [ ] Ghi lại có **cookie Cloudflare** không (`cf_clearance`, `__cf_bm`).

**Đầu ra:** dán 3 cURL đó (đã **che cookie/token thật**) cho mình → mình phân tích luồng.

---

### 🟠 Phase 2 — Scaffold dự án
- [ ] `package.json`, TypeScript, Fastify, cấu trúc thư mục ở mục 3.
- [ ] `config.ts` đọc `.env` (base URL, API key, đường dẫn session).
- [ ] `.env.example`, `.gitignore` (chặn `.env`, `session.json`).
- [ ] `logger.ts`, `http.ts` (retry + exponential backoff cho 429/5xx).
- [ ] Server chạy được với `GET /health`.

**Đầu ra:** repo có skeleton chạy được `npm run dev`.

---

### 🟡 Phase 3 — Session & Auth
- [ ] `session.ts`: nạp cookie/token từ `.env`/`session.json`.
- [ ] Hàm gắn cookie/token + header cần thiết vào mọi request.
- [ ] Phát hiện **session hết hạn** (401/403) → trả lỗi rõ ràng "cần cập nhật session".
- [ ] (Nếu có CSRF) fetch trang để lấy token trước khi submit.

**Đầu ra:** gọi thử 1 endpoint artlist bất kỳ và xác thực thành công.

---

### 🟢 Phase 4 — Artlist Client (lớp replay lõi)
- [ ] `endpoints.ts`: khai báo URL + shape của submit/status/result (dịch từ cURL).
- [ ] `client.submit(params)` → trả `jobId`.
- [ ] `client.status(jobId)` → trả trạng thái + progress.
- [ ] `client.result(jobId)` → trả URL video.
- [ ] Xử lý lỗi: 429 (rate limit) → backoff; 401/403 → báo session; 5xx → retry.

**Đầu ra:** chạy 1 script CLI tạo được video thật end-to-end.

---

### 🔵 Phase 5 — Job Manager + API
- [ ] `store.ts`: lưu job (bắt đầu bằng `Map`, sau nâng SQLite).
- [ ] `manager.ts`: worker nền tự **poll** artlist theo backoff (vd 3s→5s→…, timeout N phút).
- [ ] `routes/videos.ts`: nối các endpoint ở mục 4.
- [ ] Middleware `X-API-Key` bảo vệ API của bạn.
- [ ] Giới hạn **đồng thời** (concurrency) + **throttle** outbound để tránh bị ban.

**Đầu ra:** gọi `POST /api/videos` → poll `GET /api/videos/:id` → nhận URL.

---

### 🟣 Phase 6 — Robustness & Ops
- [ ] Rate limit **inbound** (bảo vệ API) + **outbound** (bảo vệ tài khoản).
- [ ] Log có cấu trúc, mã lỗi rõ ràng.
- [ ] Cấu hình timeout/retry hợp lý toàn hệ thống.
- [ ] `README.md`: cách chạy, cách cập nhật cookie khi hết hạn.

---

### ⚪ Phase 7 — Test & Deploy
- [ ] Ghi response thật thành **fixture** (đã ẩn secret) → unit test không cần gọi thật.
- [ ] Dockerfile + `docker-compose` (tuỳ chọn).
- [ ] Cron/quy trình nhắc **làm mới session** định kỳ.

---

## 6. Mô hình dữ liệu Job

```ts
type Job = {
  id: string;                 // jobId của bạn
  providerJobId?: string;     // jobId phía artlist
  status: 'pending' | 'processing' | 'done' | 'failed';
  progress?: number;          // 0..100
  params: GenerateParams;     // prompt, model, duration...
  videoUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
};
```

## 7. Ma trận xử lý lỗi

| HTTP từ artlist | Ý nghĩa | Hành động |
|---|---|---|
| 200/201/202 | OK | Xử lý bình thường |
| 401 / 403 | Session hết hạn / bị chặn | Đánh dấu session invalid, báo user cập nhật cookie |
| 429 | Rate limit | Backoff theo `Retry-After`, giảm concurrency |
| 5xx | Lỗi server | Retry có backoff (tối đa N lần) |
| 200 nhưng body báo lỗi | Lỗi nghiệp vụ | Chuyển job sang `failed` + lưu message |

## 8. Checklist bảo mật
- [ ] **Không bao giờ** commit cookie/token → `.env` trong `.gitignore`.
- [ ] `.env.example` chỉ chứa key rỗng, không giá trị thật.
- [ ] API của bạn bắt buộc `X-API-Key`.
- [ ] Không log full cookie/token.

## 9. Cột mốc (milestones)
1. **M1:** Bắt được 3 request + hiểu luồng auth *(Phase 1 — bạn)*.
2. **M2:** Skeleton chạy `/health` *(Phase 2)*.
3. **M3:** Tạo video thật qua CLI *(Phase 3–4)*.
4. **M4:** API hoàn chỉnh submit→poll→result *(Phase 5)*.
5. **M5:** Đủ robust + test + deploy *(Phase 6–7)*.

## 10. Việc cần bạn cung cấp để bắt đầu code
1. Chọn **ngôn ngữ**: Node.js (mặc định đề xuất) hay Python.
2. **3 cURL** ở Phase 1 (đã che secret) — để mình dựng lớp client chính xác.
