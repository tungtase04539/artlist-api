import { config } from '../config.js';
import * as artlist from '../artlist/client.js';
import { fetchWithRetry } from '../lib/http.js';

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' };

/**
 * Tải ảnh từ URL client cung cấp → upload lên artlist (presigned S3) → trả fileUrl để dùng
 * làm settings.image_url cho image-to-video.
 */
export async function uploadImageFromUrl(imageUrl) {
  const resp = await fetchWithRetry(imageUrl, {}, { retries: 2, timeoutMs: 20000 });
  if (!resp.ok) throw new Error(`Không tải được ảnh nguồn: HTTP ${resp.status}`);

  const ct = (resp.headers.get('content-type') || 'image/png').split(';')[0].trim().toLowerCase();
  const ext = EXT[ct];
  if (!ext) throw new Error(`Định dạng ảnh không hỗ trợ: ${ct} (chỉ png/jpg/webp)`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > config.MAX_IMAGE_MB * 1024 * 1024) {
    throw new Error(`Ảnh quá lớn (> ${config.MAX_IMAGE_MB}MB)`);
  }

  const { presignedUrl, fileUrl } = await artlist.getPresignedUpload(`input.${ext}`, ct);
  const put = await fetchWithRetry(presignedUrl, { method: 'PUT', headers: { 'content-type': ct }, body: buf }, { retries: 2, timeoutMs: 30000 });
  if (!put.ok) throw new Error(`Upload ảnh thất bại: HTTP ${put.status}`);
  return fileUrl;
}
