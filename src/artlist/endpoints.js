import { config } from '../config.js';

/**
 * Khai báo TẬP TRUNG các endpoint & shape request của artlist (API kiểu tRPC).
 * Gom hết ở đây để khi artlist đổi API, chỉ sửa 1 file này.
 *
 * tRPC convention (đã xác nhận từ request thật):
 *  - Query (GET):     /api/trpc/<router>.<proc>?input=<urlencoded {"json":{...}}>
 *  - Mutation (POST): /api/trpc/<router>.<proc>   body = {"json":{...}}
 *  - Response:        { result: { data: { json: <value> } } }
 */

const base = () => {
  if (!config.ARTLIST_BASE_URL) {
    throw new Error('Chưa cấu hình ARTLIST_BASE_URL — điền vào .env (vd https://toolkit.artlist.io).');
  }
  return config.ARTLIST_BASE_URL.replace(/\/$/, '');
};

/** Dựng URL query tRPC: ?input={"json":{...}} (URL-encoded). */
function trpcQueryUrl(procedure, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  return `${base()}/api/trpc/${procedure}?input=${encoded}`;
}

/**
 * SUBMIT — tạo generation (mutation POST `userGenerationRouter.create`).
 * ⚠️ TODO: shape `body.json` dưới đây là SUY LUẬN từ response status thật.
 *          Xác nhận lại tên procedure & field khi bắt được cURL `create`.
 * @param {import('./types.js').GenerateParams} params
 */
export function submitRequest(params) {
  return {
    url: `${base()}/api/trpc/userGenerationRouter.create`, // TODO: xác nhận tên procedure
    method: 'POST',
    body: {
      json: {
        prompt: params.prompt,
        modelId: params.modelId ?? 2524, // 2524 = Seedance (từ response thật)
        feature: params.image ? 'image-to-video' : 'text-to-video',
        // artlist dùng snake_case trong settings (xác nhận từ response):
        settings: {
          prompt: params.prompt,
          duration: params.duration ?? 4,
          resolution: params.resolution ?? '720p',
          aspect_ratio: params.aspectRatio ?? '16:9',
          generate_audio: params.generateAudio ?? true,
        },
        // TODO: nếu image-to-video, bổ sung field ảnh (image id/url) từ cURL create thật.
      },
    },
  };
}

/**
 * STATUS — lấy generation theo id (query GET `userGenerationRouter.getUserGeneration`).
 * ✅ Đã xác nhận từ request thật.
 * @param {string} providerJobId
 */
export function statusRequest(providerJobId) {
  return {
    url: trpcQueryUrl('userGenerationRouter.getUserGeneration', { id: providerJobId }),
    method: 'GET',
  };
}

/**
 * RESULT — artlist gộp kết quả vào STATUS (khi done sẽ có URL video), nên dùng chung.
 * @param {string} providerJobId
 */
export function resultRequest(providerJobId) {
  return statusRequest(providerJobId);
}

/**
 * Chuẩn hoá response tRPC → shape nội bộ.
 * Response thật: { result: { data: { json: [ { id, status, settings, ... } ] } } }
 * @param {any} raw
 */
export function normalizeStatus(raw) {
  const node = raw?.result?.data?.json;
  const gen = Array.isArray(node) ? node[0] : node;
  if (!gen) return {};
  return {
    providerJobId: gen.id,
    status: mapStatus(gen.status),
    progress: gen.progress, // có thể không tồn tại; UI có thể chỉ có status
    // ⚠️ TODO: xác nhận tên field URL video khi status = done.
    // Ứng viên: url / videoUrl / outputUrl / result?.url / media?.[0]?.url
    videoUrl:
      gen.videoUrl ?? gen.url ?? gen.outputUrl ?? gen.result?.url ?? gen.media?.[0]?.url,
    error: gen.error ?? gen.failureReason ?? gen.errorMessage,
    raw: gen,
  };
}

/**
 * Map trạng thái artlist → nội bộ ('processing' | 'done' | 'failed').
 * ⚠️ TODO: bổ sung giá trị "done" thật (hiện mới thấy 'processing').
 */
function mapStatus(s) {
  switch (s) {
    case 'completed':
    case 'succeeded':
    case 'success':
    case 'done':
    case 'ready':
      return 'done';
    case 'failed':
    case 'error':
    case 'canceled':
      return 'failed';
    case 'processing':
    case 'pending':
    case 'queued':
    case 'in_progress':
      return 'processing';
    default:
      return s ?? 'processing'; // giữ nguyên giá trị lạ để dễ debug
  }
}
