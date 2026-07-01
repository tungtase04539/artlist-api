import { config } from '../config.js';

/**
 * Khai báo TẬP TRUNG các endpoint & shape request của artlist (API kiểu tRPC).
 * Tên procedure & shape đã xác nhận từ request thật + đọc bundle JS công khai của artlist.
 *
 * Luồng tạo video Seedance:
 *   1) QUOTE  — modelRouter.getCostQuote (GET)  → { cost, digitalSignature, timestamp }
 *   2) CREATE — userGenerationRouter.createUserGeneration (POST, đính kèm chữ ký ở 1)
 *   3) STATUS — userGenerationRouter.getUserGeneration (GET by id), poll tới khi có fileUrl
 *
 * tRPC:
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
 * (1) QUOTE — xin chữ ký cost quote (query GET `modelRouter.getCostQuote`).
 * ✅ Input xác nhận từ bundle: { modelGroupId, input: <settings snake_case> }.
 * @param {import('./types.js').GenerateParams} params
 */
export function quoteRequest(params) {
  return {
    url: trpcQueryUrl('modelRouter.getCostQuote', {
      modelGroupId: params.modelId ?? 2524,
      input: buildSettings(params),
    }),
    method: 'GET',
  };
}

/**
 * Chuẩn hoá response QUOTE → { price, timestamp, costQuoteDigitalSignature }.
 * ✅ Field xác nhận: cost / digitalSignature / timestamp.
 * @returns {import('./types.js').QuoteResult}
 */
export function normalizeQuote(raw) {
  const q = raw?.result?.data?.json ?? {};
  return {
    price: q.cost ?? q.price,
    timestamp: q.timestamp,
    costQuoteDigitalSignature: q.digitalSignature ?? q.costQuoteDigitalSignature,
  };
}

/**
 * (2) CREATE — userGenerationRouter.createUserGeneration (POST).
 * ✅ Body xác nhận từ request thật. Cần price/timestamp/chữ ký từ QUOTE.
 * @param {import('./types.js').GenerateParams & import('./types.js').QuoteResult} params
 */
export function submitRequest(params) {
  return {
    url: `${base()}/api/trpc/userGenerationRouter.createUserGeneration`,
    method: 'POST',
    body: {
      json: {
        chatSessionId: params.chatSessionId,
        inputs: buildInputs(params),
        modelGroupId: params.modelId ?? 2524, // 2524 = Seedance
        feature: params.image ? 'image-to-video' : 'text-to-video',
        price: params.price, // từ QUOTE
        settings: buildSettings(params),
        artifacts: params.artifacts ?? [],
        costQuoteDigitalSignature: params.costQuoteDigitalSignature, // từ QUOTE (bắt buộc)
        timestamp: params.timestamp, // từ QUOTE (phải khớp chữ ký)
        generationMethod: params.generationMethod ?? 'credits',
        isCopyCmsFileEnabled: false,
      },
    },
  };
}

/**
 * (3) STATUS — userGenerationRouter.getUserGeneration (GET by id). ✅ xác nhận.
 * @param {string} providerJobId
 */
export function statusRequest(providerJobId) {
  return {
    url: trpcQueryUrl('userGenerationRouter.getUserGeneration', { id: providerJobId }),
    method: 'GET',
  };
}

/** RESULT gộp vào STATUS (khi done sẽ có fileUrl). */
export function resultRequest(providerJobId) {
  return statusRequest(providerJobId);
}

/**
 * Chuẩn hoá response STATUS/CREATE → shape nội bộ.
 * Generation object: { id, status, settings, outputs?[], fileUrl?, fileKey?, ... }.
 */
export function normalizeStatus(raw) {
  const node = raw?.result?.data?.json;
  const gen = Array.isArray(node) ? node[0] : node;
  if (!gen) return {};
  const out = Array.isArray(gen.outputs) ? gen.outputs[0] : gen.output;
  return {
    providerJobId: gen.id,
    status: mapStatus(gen.status),
    progress: gen.progress,
    // 'fileUrl' là field phổ biến nhất trong bundle (116 chỗ); có thể nằm ở generation hoặc outputs[0].
    videoUrl:
      gen.fileUrl ?? gen.videoUrl ?? gen.url ??
      out?.fileUrl ?? out?.url ?? out?.videoUrl,
    // Nếu chỉ có fileKey (chưa có URL ký sẵn), sẽ cần bước resolve signed URL — xem TODO client.
    fileKey: gen.fileKey ?? out?.fileKey,
    error: gen.error ?? gen.failureReason ?? gen.errorMessage,
    raw: gen,
  };
}

/** inputs gửi lên (text-to-video: chỉ prompt; image-to-video: thêm ảnh). */
function buildInputs(params) {
  const inputs = { prompt: params.prompt };
  if (params.image) inputs.image = params.image; // TODO: xác nhận field ảnh cho image-to-video
  return inputs;
}

/** settings snake_case (xác nhận từ request thật + chữ ký JWT). */
function buildSettings(params) {
  return {
    prompt: params.prompt,
    resolution: params.resolution ?? '720p',
    duration: params.duration ?? 4,
    generate_audio: params.generateAudio ?? true,
    aspect_ratio: params.aspectRatio ?? '16:9',
  };
}

/** Map trạng thái artlist → nội bộ. ⚠️ TODO: xác nhận giá trị "done" thật (mới thấy 'processing'). */
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
