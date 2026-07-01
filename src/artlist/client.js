import { fetchWithRetry, HttpError } from '../lib/http.js';
import { logger } from '../lib/logger.js';
import { session } from '../session/session.js';
import {
  quoteRequest,
  submitRequest,
  statusRequest,
  resultRequest,
  normalizeStatus,
  normalizeQuote,
  modelGroupsRequest,
  uiConfigRequest,
  createSessionRequest,
  normalizeSession,
  presignRequest,
  normalizePresign,
} from './endpoints.js';
import { uuidv7 } from '../lib/uuid.js';

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

/** Catalog: toàn bộ danh mục/model (raw tRPC json). */
export async function getModelGroups() {
  return call(modelGroupsRequest());
}

/** Catalog: cấu hình UI (đủ thông số) của 1 model group (raw tRPC json). */
export async function getUIConfig(modelGroupId) {
  return call(uiConfigRequest(modelGroupId));
}

/** Tạo chat session artlist mới → trả sessionId. */
export async function createChatSession(name = 'api') {
  const id = normalizeSession(await call(createSessionRequest(name, uuidv7())));
  if (!id) throw new Error('Không tạo được chat session artlist');
  return id;
}

/** Xin presigned URL để upload ảnh → { presignedUrl, fileKey, fileUrl }. */
export async function getPresignedUpload(fileName, fileType) {
  return normalizePresign(await call(presignRequest({ fileName, fileType })));
}

/**
 * (1) Lấy cost quote — BẮT BUỘC trước khi create.
 * Trả về chữ ký JWT do server ký; KHÔNG thể tự chế, phải xin cho đúng bộ inputs.
 * @param {import('./types.js').GenerateParams} params
 * @returns {Promise<import('./types.js').QuoteResult>}
 */
export async function getCostQuote(params) {
  const raw = await call(quoteRequest(params));
  const q = normalizeQuote(raw);
  if (!q.costQuoteDigitalSignature) {
    logger.error({ raw }, 'Quote thiếu costQuoteDigitalSignature — cập nhật endpoints.quoteRequest/normalizeQuote theo request thật');
    throw new Error('Chưa lấy được cost quote (cần bắt request QUOTE và điền endpoints.js).');
  }
  return q;
}

/**
 * (2) Tạo video: quote → create. Trả providerJobId.
 * @param {import('./types.js').GenerateParams} params
 * @returns {Promise<{ providerJobId: string, raw: any }>}
 */
export async function submit(params) {
  const quote = await getCostQuote(params);
  return createGeneration({ ...params, ...quote });
}

/**
 * (2b) Create cấp thấp — params ĐÃ gồm field quote (price, timestamp, costQuoteDigitalSignature, resolvedModelId).
 * Dùng khi caller đã quote riêng (vd để tính tiền trước khi create).
 * @returns {Promise<{ providerJobId: string, raw: any }>}
 */
export async function createGeneration(params) {
  const raw = await call(submitRequest(params));
  const norm = normalizeStatus(raw);
  if (!norm.providerJobId) {
    logger.error({ raw }, 'Response create không có id — kiểm tra normalizeStatus()');
    throw new Error('Response createUserGeneration không có id (kiểm tra normalizeStatus).');
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
