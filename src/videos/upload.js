import { config } from '../config.js';
import * as artlist from '../artlist/client.js';
import { fetchWithRetry } from '../lib/http.js';

const TYPES = {
  image: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' },
  video: { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' },
  audio: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/aac': 'aac' },
};
const capMb = (kind) => ({ image: config.MAX_IMAGE_MB, video: config.MAX_VIDEO_MB, audio: config.MAX_AUDIO_MB }[kind]);

/** Kích thước ảnh từ buffer (PNG/JPEG) — {} nếu không đọc được. */
function imageSize(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }; // PNG
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG
    let o = 2;
    while (o + 9 < buf.length) {
      if (buf[o] !== 0xff) { o++; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: buf.readUInt16BE(o + 5), width: buf.readUInt16BE(o + 7) };
      }
      o += 2 + buf.readUInt16BE(o + 2);
    }
  }
  return {};
}

/**
 * Tải media từ URL client → upload artlist (PUT S3) → lấy GET-url đọc được (bắt buộc).
 * @returns {{fileKey, fileUrl, mimeType, byteSize, fileName, width?, height?}}
 */
export async function uploadMedia(url, kind) {
  const resp = await fetchWithRetry(url, {}, { retries: 2, timeoutMs: kind === 'image' ? 20000 : 60000 });
  if (!resp.ok) throw new Error(`Không tải được ${kind} nguồn: HTTP ${resp.status}`);

  const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = TYPES[kind][ct];
  if (!ext) throw new Error(`Định dạng ${kind} không hỗ trợ: ${ct || '?'}`);

  const buf = Buffer.from(await resp.arrayBuffer());
  if (buf.length > capMb(kind) * 1024 * 1024) throw new Error(`${kind} quá lớn (> ${capMb(kind)}MB)`);

  const fileName = `input.${ext}`;
  const { presignedUrl, fileKey } = await artlist.getPresignedUpload(fileName, ct);
  const put = await fetchWithRetry(presignedUrl, { method: 'PUT', headers: { 'content-type': ct }, body: buf }, { retries: 2, timeoutMs: 60000 });
  if (!put.ok) throw new Error(`Upload ${kind} thất bại: HTTP ${put.status}`);

  const fileUrl = await artlist.getReadableUrl(fileKey); // GET-url đọc được
  const dims = kind === 'image' ? imageSize(buf) : {};
  return { fileKey, fileUrl, mimeType: ct, byteSize: buf.length, fileName, ...dims };
}

export const uploadImageFromUrl = async (url) => (await uploadMedia(url, 'image')).fileUrl;
