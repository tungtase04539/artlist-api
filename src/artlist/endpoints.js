import { config } from '../config.js';

/**
 * Khai báo TẬP TRUNG các endpoint & shape request của artlist (API kiểu tRPC).
 *
 * Luồng tạo video Seedance (suy ra từ request thật):
 *   1) QUOTE  — xin cost quote → nhận { price, timestamp, costQuoteDigitalSignature (JWT ký server) }
 *   2) CREATE — userGenerationRouter.createUserGeneration (POST), đính kèm chữ ký ở (1)
 *   3) STATUS — userGenerationRouter.getUserGeneration (GET by id), poll tới khi có videoUrl
 *
 * tRPC convention:
 *   - Query (GET):     /api/trpc/<router>.<proc>?input=<urlencoded {"json":{...}}>
 *   - Mutation (POST): /api/trpc/<router>.<proc>   body = {"json":{...}}
 *   - Response:        { result: { data: { json: <value> } } }
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
 * (1) QUOTE — xin chữ ký cost quote cho đúng bộ inputs.
 * ⚠️ TODO: CHƯA BẮT ĐƯỢC request này. Cần xác nhận: tên procedure, GET hay POST, shape input.
 *          Placeholder dưới đây là SUY LUẬN — sẽ sửa khi có cURL quote thật.
 * @param {import('./types.js').GenerateParams} params
 */
export function quoteRequest(params) {
  const input = {
    inputs: buildInputs(params),
    modelGroupId: params.modelId ?? 2524,
    feature: params.image ? 'image-to-video' : 'text-to-video',
    settings: buildSettings(params),
  };
  return {
    // TODO: tên thật có thể là getCostQuote / calculateCost / getPrice ...
    url: trpcQueryUrl('userGenerationRouter.getCostQuote', input),
    method: 'GET',
  };
}

/**
 * Chuẩn hoá response QUOTE → { price, timestamp, costQuoteDigitalSignature }.
 * ⚠️ TODO: map đúng field khi có response thật.
 * @returns {import('./types.js').QuoteResult}
 */
export function normalizeQuote(raw) {
  const q = raw?.result?.data?.json ?? {};
  return {
    price: q.price ?? q.cost,
    timestamp: q.timestamp,
    costQuoteDigitalSignature: q.costQuoteDigitalSignature ?? q.signature,
  };
}

/**
 * (2) CREATE — tạo generation (mutation POST `userGenerationRouter.createUserGeneration`).
 * ✅ Shape body xác nhận từ request thật. Cần price/timestamp/costQuoteDigitalSignature từ QUOTE.
 * @param {import('./types.js').GenerateParams & import('./types.js').QuoteResult} params
 */
export function submitRequest(params) {
  return {
    url: `${base()}/api/trpc/userGenerationRouter.createUserGeneration`,
    method: 'POST',
    body: {
      json: {
        chatSessionId: params.chatSessionId, // ⚠️ bắt buộc — xem ghi chú types.js
        inputs: buildInputs(params),
        modelGroupId: params.modelId ?? 2524, // 2524 = Seedance
        feature: params.image ? 'image-to-video' : 'text-to-video',
        price: params.price, // từ QUOTE
        settings: buildSettings(params),
        artifacts: params.artifacts ?? [],
        costQuoteDigitalSignature: params.costQuoteDigitalSignature, // từ QUOTE (BẮT BUỘC)
        timestamp: params.timestamp, // từ QUOTE (phải khớp chữ ký)
        generationMethod: params.generationMethod ?? 'credits',
        isCopyCmsFileEnabled: false,
      },
    },
  };
}

/**
 * (3) STATUS — lấy generation theo id (query GET `userGenerationRouter.getUserGeneration`).
 * ✅ Đã xác nhận từ request thật.
 * @param {string} providerJobId
 */
export function statusRequest(providerJobId) {
  return {
    url: trpcQueryUrl('userGenerationRouter.getUserGeneration', { id: providerJobId }),
    method: 'GET',
  };
}

/** RESULT gộp vào STATUS (khi done sẽ có URL video). */
export function resultRequest(providerJobId) {
  return statusRequest(providerJobId);
}

/**
 * Chuẩn hoá response tRPC của STATUS/CREATE → shape nội bộ.
 * STATUS thật: { result: { data: { json: [ { id, status, settings, ... } ] } } }
 * CREATE:      { result: { data: { json:   { id, status, ... } } } }  (giả định)
 */
export function normalizeStatus(raw) {
  const node = raw?.result?.data?.json;
  const gen = Array.isArray(node) ? node[0] : node;
  if (!gen) return {};
  return {
    providerJobId: gen.id,
    status: mapStatus(gen.status),
    progress: gen.progress,
    // ⚠️ TODO: xác nhận tên field URL video khi status = done (chưa thấy response done).
    videoUrl:
      gen.videoUrl ?? gen.url ?? gen.outputUrl ?? gen.result?.url ?? gen.media?.[0]?.url,
    error: gen.error ?? gen.failureReason ?? gen.errorMessage,
    raw: gen,
  };
}

/** inputs gửi lên (text-to-video chỉ có prompt; image-to-video thêm ảnh). */
function buildInputs(params) {
  const inputs = { prompt: params.prompt };
  if (params.image) inputs.image = params.image; // TODO: xác nhận field ảnh thật
  return inputs;
}

/** settings dùng snake_case (xác nhận từ request thật). */
function buildSettings(params) {
  return {
    prompt: params.prompt,
    resolution: params.resolution ?? '720p',
    duration: params.duration ?? 4,
    generate_audio: params.generateAudio ?? true,
    aspect_ratio: params.aspectRatio ?? '16:9',
  };
}

/** Map trạng thái artlist → nội bộ. ⚠️ TODO: bổ sung giá trị "done" thật (mới thấy 'processing'). */
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
      return s ?? 'processing';
  }
}
