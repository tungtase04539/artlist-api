import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { uuidv7 } from '../lib/uuid.js';
import * as artlist from '../artlist/client.js';
import * as catalog from '../artlist/catalog.js';
import * as upload from './upload.js';
import { Jobs, Credits, Clients } from '../db/repos.js';
import * as monitor from '../abuse/monitor.js';
import { session } from '../session/session.js';

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}
const isAuthErr = (e) => e?.status === 401 || e?.status === 403;

/** Session artlist cho client: request → mặc định client → tự tạo (chatSession.createChatSession). */
async function ensureClientSession(client, provided) {
  if (provided) return provided;
  if (client.default_chat_session_id) return client.default_chat_session_id;
  const id = await artlist.createChatSession(`client-${String(client.id).slice(0, 8)}`);
  await Clients.setDefaultSession(client.id, id);
  logger.info({ clientId: client.id, chatSessionId: id }, 'Tự tạo chat session cho client');
  return id;
}

const asArr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/** 1 file đã upload → object artifact (đính kèm file thật vào generation). */
function toArtifact(m, inputSettingKey) {
  const metadata = { fileUrl: m.fileUrl, mimeType: m.mimeType, inputSettingKey, fileType: 'deviceUpload', fileName: m.fileName, byteSize: m.byteSize };
  if (m.width) metadata.width = m.width;
  if (m.height) metadata.height = m.height;
  return { fileKey: m.fileKey, metadata };
}

const MEDIA_KINDS = [
  { field: 'images', kind: 'image', key: 'image_urls', tag: '@img', maxCfg: 'MAX_IMAGES' },
  { field: 'videos', kind: 'video', key: 'video_urls', tag: '@video' },
  { field: 'audios', kind: 'audio', key: 'audio_urls', tag: '@audio' },
];

/**
 * Upload media đầu vào → { prompt, tagReferences, urlStrings, urlObjects, artifacts }.
 * ✅ Xác nhận từ request THẬT:
 *   - prompt chứa `@img1..@imgN` (tag theo loại), tagReferences map tag→file (orderForType).
 *   - urlStrings (cho QUOTE settings.<kind>_urls), urlObjects (cho CREATE inputs.<kind>_urls = [{fileUrl}]).
 *   - artifacts inputSettingKey = '<kind>_urls', fileUrl = GET-url đọc được.
 */
export async function resolveMedia(params) {
  if (!asArr(params.images).length && params.image) params = { ...params, images: [params.image] };
  let prompt = params.prompt ?? params.settings?.prompt ?? '';
  const tagReferences = [];
  const urlStrings = {};
  const urlObjects = {};
  const artifacts = [];
  try {
    for (const K of MEDIA_KINDS) {
      const urls = asArr(params[K.field]);
      if (!urls.length) continue;
      const max = K.maxCfg ? config[K.maxCfg] : null;
      if (max && urls.length > max) throw new Error(`Tối đa ${max} ${K.kind}`);
      const ups = await Promise.all(urls.map((u) => upload.uploadMedia(u, K.kind)));
      urlStrings[K.key] = ups.map((m) => m.fileUrl);
      urlObjects[K.key] = ups.map((m) => ({ fileUrl: m.fileUrl }));
      ups.forEach((m, i) => {
        artifacts.push(toArtifact(m, K.key));
        const tagId = `${K.tag}${i + 1}`;
        tagReferences.push({ tagId, type: K.tag, orderForType: i + 1 });
        if (!prompt.includes(tagId)) prompt = prompt ? `${tagId} ${prompt}` : tagId;
      });
    }
  } catch (e) {
    e.mediaError = true;
    throw e;
  }
  return { prompt, tagReferences, urlStrings, urlObjects, artifacts };
}

/**
 * Tạo video cho client (không poll nền). Hỗ trợ text-to-video & image-to-video (upload ảnh).
 * chatSessionId tự tạo nếu chưa có. Trừ credits theo giá quote thật; hoàn nếu lỗi.
 */
export async function createVideo(client, params, ip) {
  const groupId = Number(params.modelGroupId ?? 358);
  if (!(await catalog.isVideoModel(groupId))) throw err('INVALID_MODEL', 'modelGroupId không phải model video hợp lệ (GET /v1/models).');

  if ((await Jobs.countActiveByClient(client.id)) >= config.MAX_CONCURRENT_PER_CLIENT) {
    throw err('RATE_LIMITED', `Đang có quá nhiều job chạy đồng thời (tối đa ${config.MAX_CONCURRENT_PER_CLIENT}).`);
  }
  const rl = await monitor.allowCreate(client);
  if (!rl.allowed) throw err('RATE_LIMITED', rl.message);

  // Session (tự tạo nếu cần) + upload media (đa ảnh/video/audio → settings).
  let chatSessionId, genParams;
  try {
    chatSessionId = await ensureClientSession(client, params.chatSessionId);
    const media = await resolveMedia(params);
    genParams = { ...params, prompt: media.prompt, media, artifacts: media.artifacts };
  } catch (e) {
    if (isAuthErr(e)) { await monitor.noteSessionExpired(`HTTP ${e.status}`); throw err('SESSION_EXPIRED', 'Dịch vụ tạm gián đoạn (session nguồn hết hạn).'); }
    if (e.mediaError) throw err('MEDIA_ERROR', e.message);
    throw e;
  }

  // Quote (server resolve model + giá + chữ ký).
  let quote;
  try {
    quote = await artlist.getCostQuote({ ...genParams, modelGroupId: groupId });
  } catch (e) {
    if (isAuthErr(e)) { await monitor.noteSessionExpired(`HTTP ${e.status}`); throw err('SESSION_EXPIRED', 'Dịch vụ tạm gián đoạn (session nguồn hết hạn).'); }
    throw e;
  }
  const price = quote.price;
  if (!price || !quote.costQuoteDigitalSignature) throw err('QUOTE_FAILED', 'Không lấy được báo giá cho tham số này.');

  if (params.expectedCredits != null && Number(params.expectedCredits) !== price) {
    await monitor.notePriceMismatch(client, { claimed: params.expectedCredits, actual: price, ip });
    throw err('PRICE_MISMATCH', `Giá không khớp: thực tế ${price} credits.`, { price });
  }
  if (params.maxCredits != null && price > Number(params.maxCredits)) {
    throw err('PRICE_TOO_HIGH', `Giá ${price} vượt maxCredits (${params.maxCredits}).`, { price });
  }

  const balance = await Credits.balance(client.id);
  if (balance < price) {
    await monitor.noteQuotaBlock(client, { needed: price, balance, ip });
    throw err('INSUFFICIENT_CREDITS', `Không đủ credits (cần ${price}, còn ${balance}).`, { price, balance });
  }

  const jobId = uuidv7();
  await Jobs.create({ id: jobId, clientId: client.id, prompt: genParams.prompt ?? genParams.settings?.prompt, params: genParams, price });
  const deduct = await Credits.change(client.id, -price, 'usage', jobId);
  if (!deduct.ok) {
    await Jobs.update(jobId, { status: 'failed', error: 'Không đủ credits (race)' });
    throw err('INSUFFICIENT_CREDITS', 'Không đủ credits.', { price });
  }
  await monitor.noteCreate(client, ip, { modelGroupId: groupId, price });

  try {
    const { providerJobId } = await artlist.createGeneration({ ...genParams, ...quote, chatSessionId, modelGroupId: groupId });
    return await Jobs.update(jobId, { provider_job_id: providerJobId, status: 'processing' });
  } catch (e) {
    await Credits.change(client.id, price, 'refund', jobId);
    await Jobs.update(jobId, { status: 'failed', refunded: true, error: String(e.message || e) });
    if (isAuthErr(e)) await monitor.noteSessionExpired(`HTTP ${e.status}`);
    throw err('CREATE_FAILED', 'Tạo video thất bại (đã hoàn credits).', { cause: String(e.message || e) });
  }
}

/** Đẩy 1 job đang chạy: hỏi artlist status 1 lần → done/failed (hoàn credits nếu lỗi). Idempotent. */
export async function advanceJob(job) {
  if (!job || !['pending', 'processing'].includes(job.status) || !job.provider_job_id) return job;
  if (Date.now() - Number(job.created_at) > config.POLL_TIMEOUT_MS) return refund(job, 'timeout');
  try {
    const s = await artlist.status(job.provider_job_id);
    if (s.status === 'done' || s.videoUrl) return await Jobs.update(job.id, { status: 'done', video_url: s.videoUrl, thumbnail_url: s.thumbnailUrl });
    if (s.status === 'failed') return refund(job, s.error || 'artlist failed');
    return await Jobs.update(job.id, { status: 'processing' });
  } catch (e) {
    if (isAuthErr(e)) await monitor.noteSessionExpired(`HTTP ${e.status}`);
    logger.warn({ jobId: job.id, err: String(e) }, 'advanceJob lỗi');
    return job;
  }
}

async function refund(job, error) {
  if (!job.refunded) await Credits.change(job.client_id, job.price, 'refund', job.id);
  return Jobs.update(job.id, { status: 'failed', refunded: true, error });
}

/** Cron: đẩy các job đã "im" quá interval. */
export async function sweepStaleJobs(olderThanMs = 15_000) {
  const jobs = await Jobs.listProcessing(olderThanMs);
  for (const j of jobs) await advanceJob(j);
  return jobs.length;
}

/** Kiểm tra sức khoẻ session artlist (auto-detect hết hạn → cảnh báo). */
export async function checkSessionHealth() {
  if (!session.isReady()) return { ok: false, reason: 'no_credentials' };
  try {
    await artlist.getModelGroups();
    session.valid = true;
    session.invalidReason = null;
    return { ok: true };
  } catch (e) {
    if (isAuthErr(e)) {
      session.markInvalid(`HTTP ${e.status}`);
      await monitor.noteSessionExpired(`healthcheck HTTP ${e.status}`);
      return { ok: false, status: e.status };
    }
    return { ok: false, error: String(e.message) };
  }
}

export function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    videoUrl: job.video_url,
    thumbnailUrl: job.thumbnail_url,
    credits: job.price,
    error: job.error,
    createdAt: Number(job.created_at),
    updatedAt: Number(job.updated_at),
  };
}
