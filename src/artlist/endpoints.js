import { config } from '../config.js';

/**
 * Khai báo TẬP TRUNG các endpoint & shape request của artlist.
 * ⚠️ TODO (Phase 1): điền chính xác từ 3 cURL bạn bắt được (submit/status/result).
 * Gom hết ở đây để khi artlist đổi API, chỉ sửa 1 file này.
 */

const base = () => {
  if (!config.ARTLIST_BASE_URL) {
    throw new Error('Chưa cấu hình ARTLIST_BASE_URL — điền vào .env sau khi bắt request.');
  }
  return config.ARTLIST_BASE_URL.replace(/\/$/, '');
};

/**
 * SUBMIT — gửi yêu cầu tạo video, trả về (path + method + body).
 * TODO: thay path, method, và ánh xạ field body cho khớp request thật.
 * @param {import('./types.js').GenerateParams} params
 */
export function submitRequest(params) {
  return {
    url: `${base()}/api/v1/seedance/generate`, // TODO: đổi path thật
    method: 'POST',
    body: {
      // TODO: đổi tên field cho khớp payload thật của artlist
      prompt: params.prompt,
      image: params.image,
      model: params.model ?? 'seedance-2',
      duration: params.duration,
      aspectRatio: params.aspectRatio,
      resolution: params.resolution,
    },
  };
}

/**
 * STATUS — hỏi tiến độ theo providerJobId.
 * TODO: đổi path/query cho khớp request poll thật.
 * @param {string} providerJobId
 */
export function statusRequest(providerJobId) {
  return {
    url: `${base()}/api/v1/seedance/status/${encodeURIComponent(providerJobId)}`, // TODO
    method: 'GET',
  };
}

/**
 * RESULT — lấy URL video cuối (nếu tách riêng khỏi status; nhiều API gộp chung).
 * TODO: nếu status đã trả URL thì có thể bỏ hàm này.
 * @param {string} providerJobId
 */
export function resultRequest(providerJobId) {
  return {
    url: `${base()}/api/v1/seedance/result/${encodeURIComponent(providerJobId)}`, // TODO
    method: 'GET',
  };
}

/**
 * Chuẩn hoá response của artlist về shape nội bộ. TODO: map theo JSON thật.
 * @param {any} raw
 * @returns {{ providerJobId?: string, status?: string, progress?: number, videoUrl?: string, error?: string }}
 */
export function normalizeStatus(raw) {
  // TODO: ánh xạ đúng field. Ví dụ giả định:
  return {
    providerJobId: raw?.id ?? raw?.jobId,
    status: raw?.status,            // 'pending' | 'processing' | 'done' | 'failed' (map nếu tên khác)
    progress: raw?.progress,
    videoUrl: raw?.videoUrl ?? raw?.output?.url,
    error: raw?.error ?? raw?.message,
  };
}
