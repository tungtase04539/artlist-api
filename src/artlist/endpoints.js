import { config } from '../config.js';

/**
 * Endpoint & shape request artlist (tRPC). Đã VERIFY LIVE (text-to-video & image/multi-to-video).
 *
 * Media đầu vào (image/video/audio) — xác nhận từ request thật:
 *   - Upload: getPresignedUrl (PUT) → PUT S3 → getPresignedUrlFromKey (GET-url đọc được).
 *   - QUOTE settings: có `<kind>_urls: [url-string]` (để resolve model + ký giá).
 *   - CREATE inputs:  `{ prompt, tagReferences, <kind>_urls: [{fileUrl}] }`.
 *   - CREATE settings: có `tagReferences` (KHÔNG có *_urls).
 *   - artifacts: `[{ fileKey, metadata:{ fileUrl, mimeType, inputSettingKey:'<kind>_urls', fileType:'deviceUpload', fileName, byteSize, width?, height? } }]`.
 *   - meta.referentialEqualities: `{ 'inputs.tagReferences': ['settings.tagReferences'] }` khi có tag.
 */

const base = () => {
  if (!config.ARTLIST_BASE_URL) throw new Error('Chưa cấu hình ARTLIST_BASE_URL (vd https://toolkit.artlist.io).');
  return config.ARTLIST_BASE_URL.replace(/\/$/, '');
};

function trpcQueryUrl(procedure, input) {
  return `${base()}/api/trpc/${procedure}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
}

// ── Catalog ──
export function modelGroupsRequest() { return { url: trpcQueryUrl('modelRouter.getModelGroups', {}), method: 'GET' }; }
export function uiConfigRequest(modelGroupId) { return { url: trpcQueryUrl('modelRouter.getUIConfig', { modelGroupId }), method: 'GET' }; }

// ── Session (auto-create) ──
export function createSessionRequest(name, teamId) {
  return { url: `${base()}/api/trpc/chatSession.createChatSession`, method: 'POST', body: { json: { name, teamId } } };
}
export function normalizeSession(raw) { const n = raw?.result?.data?.json; return (n?.data ?? n)?.id; }

// ── Upload ──
export function presignRequest({ fileName, fileType, expiresIn = 259200 }) {
  return { url: `${base()}/api/trpc/uploadRouter.getPresignedUrl`, method: 'POST', body: { json: { fileName, fileType, expiresIn } } };
}
export function normalizePresign(raw) {
  const n = raw?.result?.data?.json; const d = n?.data ?? n ?? {};
  return { presignedUrl: d.presignedUrl, fileKey: d.fileKey, fileUrl: d.fileUrl };
}
/**
 * GET-url ĐỌC ĐƯỢC từ fileKey cho MEDIA ĐẦU VÀO (bucket uploads) — để model đọc ảnh/video/audio.
 * ⚠️ CHỈ dùng cho input. Video KẾT QUẢ nằm ở bucket artifacts khác: dùng thẳng `videoUrl`
 *    trong response (đã ký CloudFront sẵn), KHÔNG ký lại bằng endpoint này (sai bucket → 403).
 */
export function presignFromKeyRequest(fileKey, expiresIn = 259200) {
  return { url: `${base()}/api/trpc/uploadRouter.getPresignedUrlFromKey`, method: 'POST', body: { json: { fileKey, expiresIn } } };
}
export function normalizeReadUrl(raw) { const n = raw?.result?.data?.json; return (n?.data ?? n)?.presignedUrl; }

// ── QUOTE ──
export function quoteRequest(params) {
  return { url: trpcQueryUrl('modelRouter.getCostQuote', { modelGroupId: params.modelGroupId ?? 358, input: quoteSettings(params) }), method: 'GET' };
}
export function normalizeQuote(raw) {
  const n = raw?.result?.data?.json; const q = n?.data ?? n ?? {};
  return { price: q.cost ?? q.price, timestamp: q.timestamp, costQuoteDigitalSignature: q.digitalSignature ?? q.costQuoteDigitalSignature, resolvedModelId: q.modelId, modelFeature: q.modelFeature };
}

// ── CREATE ──
export function submitRequest(params) {
  const inputs = buildInputs(params);
  const json = {
    chatSessionId: params.chatSessionId,
    inputs,
    modelGroupId: params.resolvedModelId ?? params.modelId ?? 2524,
    feature: params.modelFeature ?? params.feature ?? 'text-to-video',
    price: params.price,
    settings: createSettings(params),
    artifacts: params.artifacts ?? [],
    costQuoteDigitalSignature: params.costQuoteDigitalSignature,
    timestamp: params.timestamp,
    generationMethod: params.generationMethod ?? 'credits',
    isCopyCmsFileEnabled: false,
  };
  const body = { json };
  if (inputs.tagReferences?.length) body.meta = { referentialEqualities: { 'inputs.tagReferences': ['settings.tagReferences'] } };
  return { url: `${base()}/api/trpc/userGenerationRouter.createUserGeneration`, method: 'POST', body };
}

// ── STATUS ──
export function statusRequest(id) { return { url: trpcQueryUrl('userGenerationRouter.getUserGeneration', { id }), method: 'GET' }; }
export function resultRequest(id) { return statusRequest(id); }
export function normalizeStatus(raw) {
  let node = raw?.result?.data?.json;
  if (node && !Array.isArray(node) && node.id === undefined && node.data !== undefined) node = node.data;
  const gen = Array.isArray(node) ? node[0] : node;
  if (!gen) return {};
  const out = Array.isArray(gen.outputs) ? gen.outputs[0] : gen.output;
  const asset = gen.assetFileInfo ?? out?.assetFileInfo;
  return {
    providerJobId: gen.id,
    status: mapStatus(gen.status),
    progress: gen.progress,
    // videoUrl ĐÃ ký CloudFront sẵn (Expires+Key-Pair-Id+Signature) → giữ NGUYÊN VĂN, mở được mọi nơi.
    videoUrl: gen.videoUrl ?? gen.fileUrl ?? gen.url ?? out?.fileUrl ?? out?.url ?? out?.videoUrl ?? asset?.fileUrl,
    thumbnailUrl: gen.thumbnailUrl ?? out?.thumbnailUrl ?? asset?.thumbnailUrl,
    fileKey: gen.fileKey ?? out?.fileKey ?? asset?.fileKey,
    thumbnailKey: gen.thumbnailKey ?? gen.thumbnailFileKey ?? out?.thumbnailKey ?? out?.thumbnailFileKey ?? asset?.thumbnailFileKey,
    error: gen.error ?? gen.failureReason ?? gen.errorMessage,
    raw: gen,
  };
}

// ── helpers ──
const prompt = (p) => p.prompt ?? p.settings?.prompt;
function basicSettings(p) {
  const s = p.settings || {};
  return {
    resolution: s.resolution ?? p.resolution ?? '720p',
    duration: s.duration ?? p.duration ?? 4,
    generate_audio: s.generate_audio ?? p.generateAudio ?? true,
    aspect_ratio: s.aspect_ratio ?? p.aspectRatio ?? '16:9',
  };
}
/** Settings cho QUOTE: basic + *_urls (string) để resolve model. */
function quoteSettings(p) {
  return { ...basicSettings(p), ...(p.media?.urlStrings || {}), prompt: prompt(p) };
}
/** Settings cho CREATE: basic + tagReferences (KHÔNG *_urls). */
function createSettings(p) {
  const s = { ...basicSettings(p), prompt: prompt(p) };
  if (p.media?.tagReferences?.length) s.tagReferences = p.media.tagReferences;
  return s;
}
/** inputs cho CREATE: prompt + tagReferences + *_urls (object {fileUrl}). */
function buildInputs(p) {
  const inputs = { prompt: prompt(p) };
  if (p.media?.tagReferences?.length) inputs.tagReferences = p.media.tagReferences;
  Object.assign(inputs, p.media?.urlObjects || {});
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
