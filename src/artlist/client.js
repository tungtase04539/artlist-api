import { fetchWithRetry, HttpError } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { session } from '../session/session.js';
import { submitRequest, statusRequest, resultRequest, normalizeStatus } from './endpoints.js';

/**
 * Lớp replay lõi: gọi sang artlist bằng session của bạn.
 * Mọi HTTP đi qua đây để tập trung xử lý auth/lỗi.
 */

/** Gọi 1 request tới artlist, kèm auth header + xử lý lỗi chung. */
async function call({ url, method, body }) {
  session.assertValid();

  const res = await fetchWithRetry(url, {
    method,
    headers: { ...session.browserHeaders(), ...session.authHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    session.markInvalid(`HTTP ${res.status}`);
    throw new HttpError('Session hết hạn hoặc bị chặn', res.status, text);
  }
  if (!res.ok) {
    throw new HttpError(`Artlist trả về HTTP ${res.status}`, res.status, text);
  }

  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text };
  }
}

/**
 * Gửi yêu cầu tạo video → trả providerJobId.
 * @param {import('./types.js').GenerateParams} params
 * @returns {Promise<{ providerJobId: string, raw: any }>}
 */
export async function submit(params) {
  const raw = await call(submitRequest(params));
  const norm = normalizeStatus(raw);
  if (!norm.providerJobId) {
    logger.error({ raw }, 'Không tìm thấy providerJobId trong response submit — kiểm tra normalizeStatus()');
    throw new Error('Response submit không có jobId (cần sửa endpoints.js theo response thật).');
  }
  return { providerJobId: norm.providerJobId, raw };
}

/**
 * Hỏi trạng thái 1 job.
 * @param {string} providerJobId
 */
export async function status(providerJobId) {
  const raw = await call(statusRequest(providerJobId));
  return normalizeStatus(raw);
}

/**
 * Lấy URL kết quả (nếu artlist tách riêng khỏi status).
 * @param {string} providerJobId
 */
export async function result(providerJobId) {
  const raw = await call(resultRequest(providerJobId));
  return normalizeStatus(raw);
}
