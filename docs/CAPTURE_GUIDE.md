# Hướng dẫn bắt request Seedance (Phase 1)

> Đây là bước **quan trọng nhất** và **chỉ bạn làm được**, vì nó cần chính phiên
> đăng nhập (session) của bạn. Làm xong bước này, phần còn lại mình dựng code được.

## A. Chuẩn bị
1. Đăng nhập artlist.io bằng trình duyệt (Chrome/Edge/Firefox).
2. Vào đúng trang tạo video **Seedance 2**.
3. Mở **DevTools**: `F12` (hoặc chuột phải → *Inspect*).
4. Sang tab **Network**.
5. Bật ☑ **Preserve log** (giữ log khi trang chuyển) và ☑ **Disable cache**.
6. Ở ô filter, chọn **Fetch/XHR** để lọc bớt ảnh/CSS.
7. Bấm 🚫 (clear) để xoá log cũ cho sạch.

## B. Ghi lại luồng
1. Nhập prompt, chọn tham số, bấm **Generate**.
2. Quan sát các request mới xuất hiện. Bạn cần **3 loại**:

| # | Loại | Dấu hiệu nhận biết |
|---|---|---|
| 1 | **Submit** | Xuất hiện ngay khi bấm Generate, thường `POST`, body chứa prompt/params |
| 2 | **Status / Poll** | Lặp lại nhiều lần mỗi vài giây, URL thường có `job`, `task`, `status`, `poll` |
| 3 | **Result** | Request cuối trả về URL video (`.mp4`) hoặc link download |

3. Với **mỗi** request: chuột phải → **Copy** → **Copy as cURL** (bash).

## C. Thông tin cần ghi chú thêm
- [ ] **Base URL / domain** của API (vd `api.artlist.io`, `create.artlist.io`...).
- [ ] Auth nằm ở đâu:
  - Cookie? (xem tab **Application → Cookies**)
  - Header `Authorization: Bearer ...`?
  - Header lạ như `x-csrf-token`, `x-app-token`, `x-device-id`?
- [ ] Có cookie **Cloudflare** không: `cf_clearance`, `__cf_bm`.
- [ ] Trong body submit: tên field cho **prompt, model, duration, aspectRatio, resolution**.
- [ ] Trong response submit: field nào là **jobId** (để dùng cho poll).

## D. ⚠️ Trước khi gửi cURL cho mình — CHE SECRET
Trong cURL sẽ có cookie/token thật. **Thay thế** chúng trước khi paste:

```bash
# Ví dụ: thay giá trị thật bằng placeholder
-H 'cookie: session=REDACTED; auth_token=REDACTED'
-H 'authorization: Bearer REDACTED'
```

> Mình chỉ cần **cấu trúc** request (URL, tên header, shape của body), **không cần**
> giá trị cookie thật. Đừng bao giờ dán token thật vào chat hay commit lên git.

## E. Mẫu điền thông tin (paste lại cho mình theo mẫu này)

````
### 1. SUBMIT
```bash
<dán cURL submit đã che secret>
```
Response mẫu (đã che): { "jobId": "...", ... }

### 2. STATUS
```bash
<dán cURL status đã che secret>
```
Response mẫu: { "status": "processing", "progress": ... }

### 3. RESULT
```bash
<dán cURL result đã che secret>
```
Response mẫu: { "videoUrl": "https://....mp4" }

### Ghi chú
- Auth qua: [cookie / bearer / cả hai]
- Có Cloudflare: [có / không]
````
