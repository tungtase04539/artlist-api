import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { uuidv7 } from '../lib/uuid.js';
import * as artlist from '../artlist/client.js';
import * as catalog from '../artlist/catalog.js';
import { Jobs, Credits } from '../db/repos.js';
import * as monitor from '../abuse/monitor.js';

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * Tạo video cho client. KHÔNG poll nền (hợp serverless): job để 'processing',
 * tiến độ được đẩy khi client gọi GET /v1/videos/:id (advanceJob) hoặc Cron sweep.
 */
export async function createVideo(client, params, ip) {
  const groupId = Number(params.modelGroupId ?? 358);
  const chatSessionId = params.chatSessionId || client.default_chat_session_id;

  if (!(await catalog.isVideoModel(groupId))) throw err('INVALID_MODEL', 'modelGroupId không phải model video hợp lệ (GET /v1/models).');
  if (!chatSessionId) throw err('NO_SESSION', 'Thiếu chatSessionId và client chưa được admin gán session mặc định.');

  const rl = await monitor.allowCreate(client);
  if (!rl.allowed) throw err('RATE_LIMITED', rl.message);

  let quote;
  try {
    quote = await artlist.getCostQuote({ ...params, modelGroupId: groupId });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      await monitor.noteSessionExpired(`HTTP ${e.status}`);
      throw err('SESSION_EXPIRED', 'Dịch vụ tạm gián đoạn (session nguồn hết hạn).');
    }
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
  await Jobs.create({ id: jobId, clientId: client.id, prompt: params.prompt ?? params.settings?.prompt, params, price });
  const deduct = await Credits.change(client.id, -price, 'usage', jobId);
  if (!deduct.ok) {
    await Jobs.update(jobId, { status: 'failed', error: 'Không đủ credits (race)' });
    throw err('INSUFFICIENT_CREDITS', 'Không đủ credits.', { price });
  }
  await monitor.noteCreate(client, ip, { modelGroupId: groupId, price });

  try {
    const { providerJobId } = await artlist.createGeneration({ ...params, ...quote, chatSessionId, modelGroupId: groupId });
    return await Jobs.update(jobId, { provider_job_id: providerJobId, status: 'processing' });
  } catch (e) {
    await Credits.change(client.id, price, 'refund', jobId);
    await Jobs.update(jobId, { status: 'failed', refunded: true, error: String(e.message || e) });
    if (e.status === 401 || e.status === 403) await monitor.noteSessionExpired(`HTTP ${e.status}`);
    throw err('CREATE_FAILED', 'Tạo video thất bại (đã hoàn credits).', { cause: String(e.message || e) });
  }
}

/**
 * Đẩy 1 job đang chạy: hỏi artlist status 1 lần → cập nhật done/failed (hoàn credits nếu lỗi).
 * Idempotent — gọi từ GET /v1/videos/:id và từ Cron sweep.
 */
export async function advanceJob(job) {
  if (!job || !['pending', 'processing'].includes(job.status) || !job.provider_job_id) return job;

  // Quá hạn → hoàn tiền, đánh dấu failed.
  if (Date.now() - Number(job.created_at) > config.POLL_TIMEOUT_MS) {
    return refund(job, 'timeout');
  }
  try {
    const s = await artlist.status(job.provider_job_id);
    if (s.status === 'done' || s.videoUrl) {
      return await Jobs.update(job.id, { status: 'done', video_url: s.videoUrl, thumbnail_url: s.thumbnailUrl });
    }
    if (s.status === 'failed') return refund(job, s.error || 'artlist failed');
    return await Jobs.update(job.id, { status: 'processing' }); // touch updated_at
  } catch (e) {
    if (e.status === 401 || e.status === 403) await monitor.noteSessionExpired(`HTTP ${e.status}`);
    logger.warn({ jobId: job.id, err: String(e) }, 'advanceJob lỗi');
    return job;
  }
}

async function refund(job, error) {
  if (!job.refunded) await Credits.change(job.client_id, job.price, 'refund', job.id);
  return Jobs.update(job.id, { status: 'failed', refunded: true, error });
}

/** Cron: đẩy các job đã "im" quá interval (client ngừng poll). Trả số job đã xử lý. */
export async function sweepStaleJobs(olderThanMs = 15_000) {
  const jobs = await Jobs.listProcessing(olderThanMs);
  for (const j of jobs) await advanceJob(j);
  return jobs.length;
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
