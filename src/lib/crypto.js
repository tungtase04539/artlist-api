import { randomBytes, createHash } from 'node:crypto';

/** sha256 hex của 1 chuỗi. */
export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

/**
 * Sinh API key cho client. Trả về key thô (chỉ hiện 1 lần), hash để lưu DB, và prefix để hiển thị.
 * Định dạng: alk_<40 hex>
 */
export function generateApiKey() {
  const key = 'alk_' + randomBytes(24).toString('hex');
  return { key, hash: sha256(key), prefix: key.slice(0, 12) };
}
