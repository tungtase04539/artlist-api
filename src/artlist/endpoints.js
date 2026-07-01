import { config } from '../config.js';

/**
 * Khai báo TẬP TRUNG endpoint & shape request artlist (tRPC). Đã verify LIVE.
 *
 * Luồng tạo video (tổng quát cho MỌI model video):
 *   1) QUOTE  modelRouter.getCostQuote  { modelGroupId, input: settings }
 *             → server TỰ RESOLVE modelId từ group + settings → { modelId, cost, digitalSignature, timestamp }
 *   2) CREATE userGenerationRouter.createUserGeneration
 *             → body.modelGroupId = modelId ĐÃ RESOLVE (quirk đặt tên của artlist)
 *   3) STATUS userGenerationRouter.getUserGeneration (poll)
 *
 * Catalog:
 *   modelRouter.getModelGroups          → toàn bộ danh mục + group + credits + features
 *   modelRouter.getUIConfig{modelGroupId}→ đủ thông số (settings) + options + default của group
 */

const base = () => {
  if (!config.ARTLIST_BASE_URL) {
    throw new Error('Chưa cấu hình ARTLIST_BASE_URL — điền vào .env (vd https://toolkit.artlist.io).');
  }
  return config.ARTLIST_BASE_URL.replace(/\/$/, '');
};

function trpcQueryUrl(procedure, input) {
  const encoded = encodeURIComponent(JSON.stringify({ json: input }));
  return `${base()}/api/trpc/${procedure}?input=${encoded}`;
}

// ─────────────────────────── Catalog ───────────────────────────
export function modelGroupsRequest() {
  return { url: trpcQueryUrl('modelRouter.getModelGroups', {}), method: 'GET' };
}
export function uiConfigRequest(modelGroupId) {
  return { url: trpcQueryUrl('modelRouter.getUIConfig', { modelGroupId }), method: 'GET' };
}

// ─────────────────────────── QUOTE ───────────────────────────
/** @param {import('./types.js').GenerateParams} params */
export function quoteRequest(params) {
  return {
    url: trpcQueryUrl('modelRouter.getCostQuote', {
      modelGroupId: params.modelGroupId ?? 358, // ID GROUP (vd Seedance 2.0 = 358)
      input: buildSettings(params), // server tự resolve modelId từ group + settings
    }),
    method: 'GET',
  };
}

/** @returns {import('./types.js').QuoteResult} */
export function normalizeQuote(raw) {
  const node = raw?.result?.data?.json;
  const q = node?.data ?? node ?? {}; // modelRouter bọc trong { success, data }
  return {
    price: q.cost ?? q.price,
    timestamp: q.timestamp,
    costQuoteDigitalSignature: q.digitalSignature ?? q.costQuoteDigitalSignature,
    resolvedModelId: q.modelId, // modelId server resolve từ group + settings
    modelFeature: q.modelFeature,
  };
}

// ─────────────────────────── CREATE ───────────────────────────
/** @param {import('./types.js').GenerateParams & import('./types.js').QuoteResult} params */
export function submitRequest(params) {
  return {
    url: `${base()}/api/trpc/userGenerationRouter.createUserGeneration`,
    method: 'POST',
    body: {
      json: {
        chatSessionId: params.chatSessionId, // ⚠️ session artlist có sẵn (bắt buộc)
        inputs: buildInputs(params),
        // ⚠️ create nhận MODEL ID (đã resolve từ quote) ở field tên "modelGroupId".
        modelGroupId: params.resolvedModelId ?? params.modelId ?? 2524,
        feature: params.feature ?? (params.image ? 'image-to-video' : 'text-to-video'),
        price: params.price, // từ QUOTE
        settings: buildSettings(params),
        artifacts: params.artifacts ?? [],
        costQuoteDigitalSignature: params.costQuoteDigitalSignature, // từ QUOTE
        timestamp: params.timestamp, // từ QUOTE
        generationMethod: params.generationMethod ?? 'credits',
        isCopyCmsFileEnabled: false,
      },
    },
  };
}

// ─────────────────────────── STATUS ───────────────────────────
export function statusRequest(providerJobId) {
  return { url: trpcQueryUrl('userGenerationRouter.getUserGeneration', { id: providerJobId }), method: 'GET' };
}
export function resultRequest(providerJobId) {
  return statusRequest(providerJobId);
}

export function normalizeStatus(raw) {
  let node = raw?.result?.data?.json;
  if (node && !Array.isArray(node) && node.id === undefined && node.data !== undefined) node = node.data;
  const gen = Array.isArray(node) ? node[0] : node;
  if (!gen) return {};
  const out = Array.isArray(gen.outputs) ? gen.outputs[0] : gen.output;
  return {
    providerJobId: gen.id,
    status: mapStatus(gen.status),
    progress: gen.progress,
    videoUrl: gen.videoUrl ?? gen.fileUrl ?? gen.url ?? out?.fileUrl ?? out?.url ?? out?.videoUrl,
    thumbnailUrl: gen.thumbnailUrl ?? out?.thumbnailUrl,
    fileKey: gen.fileKey ?? out?.fileKey,
    error: gen.error ?? gen.failureReason ?? gen.errorMessage,
    raw: gen,
  };
}

// ─────────────────────────── helpers ───────────────────────────
/** settings gửi lên. Ưu tiên params.settings (khớp getUIConfig từng model); có default cho Seedance. */
function buildSettings(params) {
  if (params.settings && typeof params.settings === 'object') {
    return { prompt: params.prompt ?? params.settings.prompt, ...params.settings };
  }
  return {
    prompt: params.prompt,
    resolution: params.resolution ?? '720p',
    duration: params.duration ?? 4,
    generate_audio: params.generateAudio ?? true,
    aspect_ratio: params.aspectRatio ?? '16:9',
  };
}

function buildInputs(params) {
  const inputs = { prompt: params.prompt ?? params.settings?.prompt };
  if (params.image) inputs.image = params.image;
  return inputs;
}

function mapStatus(s) {
  switch (s) {
    case 'completed': case 'succeeded': case 'success': case 'done': case 'ready': return 'done';
    case 'failed': case 'error': case 'canceled': return 'failed';
    case 'processing': case 'pending': case 'queued': case 'in_progress': return 'processing';
    default: return s ?? 'processing';
  }
}
