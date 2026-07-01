import { config } from '../config.js';
import * as artlist from '../artlist/client.js';
import { fetchWithRetry } from '../lib/http.js';

/** content-type -> đuôi file, theo loại media. */
const TYPES = {
  image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' },
  video: { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' },
  audio: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac' },
};
const capMb = (kind) => ({ image: config.MAX_IMAGE_MB, video: config.MAX_VIDEO_MB, audio: config.MAX_AUDIO_MB }[kind]);

/**
 * Tải media từ URL client → upload lên artlist (presigned S3) → trả fileUrl.
 * @param {string} url @param {'image'|'video'|'audio'} kind
 */
export async function uploadMedia(url, kind) {
  const resp = await fetchWithRetry(url, {}, { retries: 2, timeoutMs: kind === 'image' ? 20000 : 60000 });
  if (!resp.ok) throw new Error(`Không tải được ${kind} nguồn: HTTP ${resp.status}`);

  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[kind][ct];
  if (!ext) throw new Error(`Định dạng ${kind} không hỗ trợ: ${ct || '?'}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > capMb(kind) * 1024 * 1024) throw new Error(`${kind} quá lớn (> ${capMb(kind)}MB)`);

  const { presignedUrl, fileUrl } = await artlist.getPresignedUpload(`input.${ext}`, ct);
  const put = await fetchWithRetry(presignedUrl, { method: 'PUT', headers: { 'content-type': ct }, body: buf }, { retries: 2, timeoutMs: 60000 });
  if (!put.ok) throw new Error(`Upload ${kind} thất bại: HTTP ${put.status}`);
  return fileUrl;
}

/** Tương thích cũ: upload 1 ảnh. */
export const uploadImageFromUrl = (url) => uploadMedia(url, 'image');
