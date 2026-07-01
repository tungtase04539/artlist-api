# Hướng dẫn thực chiến: Bắt request Seedance (Phase 1)

> Đây là bước **quan trọng nhất** và **chỉ bạn làm được** (cần chính session đăng nhập).
> Làm xong bước này, mình dựng nốt lớp client là chạy end-to-end.
>
> Mục tiêu: lấy ra **3 request** — `SUBMIT` (tạo), `STATUS` (poll tiến độ), `RESULT` (URL video)
> — cùng cơ chế **auth** (cookie/token/CSRF) và **tên field** trong payload.

---

## Phần 1 — Chuẩn bị (2 phút)

1. Dùng **Chrome** hoặc **Edge** (DevTools mạnh nhất; Firefox cũng được).
2. Đăng nhập artlist.io, mở đúng trang tạo video **Seedance 2**.
3. Chuẩn bị sẵn một **prompt có từ khoá độc nhất** để dễ tìm sau này, ví dụ:
   `zxqw a red panda skateboarding` (từ `zxqw` gần như không trùng gì → tí nữa search cực nhanh).

---

## Phần 2 — Mở & cấu hình tab Network (1 phút)

1. Nhấn **F12** (hoặc chuột phải → *Inspect*) → sang tab **Network**.
2. Bật các tuỳ chọn quan trọng:
   - ☑ **Preserve log** (giữ log khi trang điều hướng — nếu tắt, log mất khi chuyển trang).
   - ☑ **Disable cache** (luôn thấy request thật, không bị cache).
3. Trên thanh filter, bấm **Fetch/XHR** để **ẩn** ảnh/CSS/font — chỉ còn request API.
4. Bấm 🚫 (Clear) để xoá sạch log **ngay trước khi** bấm Generate.
5. **Để DevTools mở suốt** quá trình (một số app chỉ ghi khi DevTools mở).

---

## Phần 3 — Ghi lại luồng (bấm Generate)

1. Nhập prompt (có từ khoá độc nhất) → bấm **Generate**.
2. Đợi tới khi video render xong (giữ nguyên DevTools, đừng reload).
3. Bạn cần tìm **3 loại request** dưới đây:

| # | Loại | Dấu hiệu nhận biết |
|---|---|---|
| 1 | **SUBMIT** | Xuất hiện **ngay khi bấm Generate**. Thường `POST`. Payload chứa prompt/params. |
| 2 | **STATUS/POLL** | **Lặp lại nhiều lần** cách nhau vài giây. URL thường có `job`, `task`, `status`, `poll`, `generation`. |
| 3 | **RESULT** | Request **cuối** trả về URL video (`.mp4`) hoặc link tải. Đôi khi gộp chung vào STATUS. |

### ⭐ Mẹo pro tìm nhanh (đừng dò bằng mắt)
- **Tìm SUBMIT:** bấm vào danh sách Network rồi **Ctrl+F** (mở ô *Search* của Network) → gõ từ khoá độc nhất trong prompt (`zxqw`). DevTools sẽ chỉ đúng request **mang prompt đi** = chính là SUBMIT.
- **Tìm RESULT:** copy vài ký tự của URL video (hoặc đuôi `.mp4`) → Ctrl+F search → ra request chứa link.
- **Nhận diện POLL:** cột **Name** có 1 endpoint **lặp lại đều đặn** với cùng một id → đó là poll. Bấm vào xem `status` đổi dần `pending → processing → done`.
- Xem cột **Type** (`fetch`/`xhr`), **Status** (200), **Initiator** (biết code nào gọi).

---

## Phần 4 — Đọc chi tiết 1 request

Bấm vào 1 request → panel bên phải có các tab:

| Tab | Xem gì |
|---|---|
| **Headers** | `Request URL`, `Request Method`, và **Request Headers** (cookie, authorization, x-csrf-token, các `x-*` lạ) |
| **Payload** | Body gửi đi — **tên field**: prompt, model, duration, aspectRatio, resolution... (bấm *view source* để thấy JSON gốc) |
| **Response** / **Preview** | JSON trả về — tìm **jobId** (ở SUBMIT) và **videoUrl/status/progress** (ở STATUS/RESULT) |
| **Cookies** | Cookie gửi kèm request đó |

---

## Phần 5 — Copy as cURL

Với **mỗi** trong 3 request:
- Chuột phải vào request → **Copy** → **Copy as cURL** → chọn **(bash)** (không phải cmd/PowerShell).
- Dán tạm ra một file text.

> 💾 **Backup toàn bộ (tuỳ chọn):** chuột phải trong Network → *Save all as HAR with content*.
> ⚠️ File HAR **chứa cookie/token thật** — coi như secret, đừng gửi/commit bản chưa che.

---

## Phần 6 — Xác định cơ chế Auth (rất quan trọng)

Trả lời 4 câu hỏi này (xem trong tab **Headers** của request SUBMIT):

- [ ] Có header **`cookie:`** không? → auth qua cookie. (Xem đầy đủ ở tab **Application → Cookies → domain artlist**.)
- [ ] Có header **`authorization: Bearer ...`** không? → có bearer token (JWT).
- [ ] Có header lạ **`x-csrf-token`, `x-xsrf-token`, `x-app-token`, `x-device-id`, `x-signature`** không?
- [ ] Có cookie **Cloudflare** (`cf_clearance`, `__cf_bm`) không? → có tầng chống bot.

> Nếu thấy `x-signature` / `x-sign` / giá trị hash lạ đổi theo từng request → xem mục **Tình huống khó**.

---

## Phần 7 — Che secret TRƯỚC KHI gửi cho mình

Trong cURL sẽ có cookie/token **thật**. **Thay** chúng bằng placeholder trước khi paste. Mình chỉ cần **cấu trúc** (URL, tên header, shape body), **không cần** giá trị thật.

```bash
# Thay thủ công, hoặc chạy sed để che tự động:
sed -E "s/(cookie: )[^']*/\1REDACTED/I; s/(authorization: Bearer )[^']*/\1REDACTED/I; s/(x-csrf-token: )[^']*/\1REDACTED/I" curl_da_luu.txt
```

Cần che: `cookie`, `authorization`, mọi `x-*token/signature`, và các giá trị id nhạy cảm nếu có.

---

## Phần 8 — Mẫu điền (paste lại cho tôi theo mẫu này)

````
### 1. SUBMIT
```bash
<cURL submit đã che secret>
```
Response: { "jobId": "...", "status": "..." }

### 2. STATUS
```bash
<cURL status đã che secret>
```
Response (lúc đang chạy): { "status": "processing", "progress": 40 }
Response (khi xong):      { "status": "done", "videoUrl": "https://....mp4" }

### 3. RESULT  (bỏ qua nếu STATUS đã trả videoUrl)
```bash
<cURL result đã che secret>
```
Response: { "videoUrl": "https://....mp4" }

### Ghi chú auth
- Auth qua: [ ] cookie   [ ] bearer token   [ ] cả hai
- Header đặc biệt khác: __________ (vd x-csrf-token, x-signature)
- Có cookie Cloudflare (cf_clearance/__cf_bm): [ ] có  [ ] không
- Tên field trong payload: prompt=____ model=____ duration=____ aspectRatio=____
````

---

## Phần 9 — Tình huống khó (nếu không thấy request như mong đợi)

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Bấm Generate mà **không có POST** nào rõ ràng | Dùng **GraphQL** | Mọi POST đổ về 1 endpoint `/graphql`. Phân biệt bằng field `operationName` trong Payload. Lấy request có operationName kiểu `CreateGeneration`. |
| Status không phải request lặp, mà **1 request treo mãi (pending)** | Dùng **SSE / EventStream** | Bấm request đó → tab **EventStream** để xem các event tiến độ stream về. |
| Có mục **WS** trong Network, tiến độ đẩy realtime | Dùng **WebSocket** | Lọc **WS** → bấm connection → tab **Messages** xem frame gửi/nhận. Chụp lại vài message submit/progress cho mình. |
| Có `x-signature`/hash đổi mỗi request | Request **bị ký** ở client (JS) | Khó hơn: cần tìm hàm ký trong JS. Cứ gửi mình cURL + header đó, mình sẽ đánh giá độ khả thi. |
| Trước SUBMIT có 1 request **multipart/upload** | Ảnh cho image-to-video được **upload trước** | Bắt thêm request upload đó (trả về image id dùng cho SUBMIT). |
| Bị chặn/redirect lạ, có challenge | **Cloudflare/bot protection** | Ghi lại cookie `cf_clearance`; có thể cần giả TLS fingerprint (mình xử lý ở lớp client). |

### Công cụ nâng cao (khi web quá phức tạp hoặc muốn bắt cả app mobile)
- **mitmproxy** (miễn phí), **Charles** hoặc **Fiddler**: proxy trung gian bắt toàn bộ HTTPS, dễ lọc/replay hơn DevTools cho luồng phức tạp.

---

## Phần 10 — Checklist trước khi quay lại

- [ ] Có cURL **SUBMIT** (đã che secret) + response mẫu
- [ ] Có cURL **STATUS** + thấy `status`/`progress`/`videoUrl` đổi
- [ ] Có cURL **RESULT** (hoặc xác nhận STATUS đã đủ)
- [ ] Đã trả lời 4 câu hỏi auth ở Phần 6
- [ ] Đã ghi tên field payload (prompt/model/duration/...)

Đủ các mục trên → paste vào chat, mình điền `src/artlist/endpoints.js` + `.env` và test end-to-end.
