import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { uuidv7 } from '../lib/uuid.js';
import * as artlist from '../artlist/client.js';
import * as catalog from '../artlist/catalog.js';
import { Jobs, Credits } from '../db/repos.js';
import * as monitor from '../abuse/monitor.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Tạo lỗi có mã để route map ra HTTP status. */
function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/**
 * Tạo video cho client: kiểm tra model/rate/credits → quote → trừ credits → create → poll nền.
 * Trừ credits theo GIÁ QUOTE THẬT; hoàn credits nếu create/poll thất bại.
 */
export async function createVideo(client, params, ip) {
  const groupId = Number(params.modelGroupId ?? 358);

  if (!(await catalog.isVideoModel(groupId))) {
    throw err('INVALID_MODEL', 'modelGroupId không phải model video hợp lệ (xem GET /v1/models).');
  }
  if (!params.chatSessionId) {
    throw err('NO_SESSION', 'Thiếu chatSessionId (session artlist có sẵn). Xem docs.');
  }

  // Rate limit tạo video.
  const rl = monitor.allowCreate(client);
  if (!rl.allowed) throw err('RATE_LIMITED', rl.message);

  // Quote: server resolve model + giá + chữ ký.
  let quote;
  try {
    quote = await artlist.getCostQuote({ ...params, modelGroupId: groupId });
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      monitor.noteSessionExpired(`HTTP ${e.status}`);
      throw err('SESSION_EXPIRED', 'Dịch vụ tạm gián đoạn (session nguồn hết hạn).');
    }
    throw e;
  }
  const price = quote.price;
  if (!price || !quote.costQuoteDigitalSignature) {
    throw err('QUOTE_FAILED', 'Không lấy được báo giá cho tham số này.');
  }

  // Chống cheat giá + trần giá client đặt.
  if (params.expectedCredits != null && Number(params.expectedCredits) !== price) {
    monitor.notePriceMismatch(client, { claimed: params.expectedCredits, actual: price, ip });
    throw err('PRICE_MISMATCH', `Giá không khớp: thực tế ${price} credits.`, { price });
  }
  if (params.maxCredits != null && price > Number(params.maxCredits)) {
    throw err('PRICE_TOO_HIGH', `Giá ${price} vượt maxCredits (${params.maxCredits}).`, { price });
  }

  // Đủ credits?
  const balance = Credits.balance(client.id);
  if (balance < price) {
    monitor.noteQuotaBlock(client, { needed: price, balance, ip });
    throw err('INSUFFICIENT_CREDITS', `Không đủ credits (cần ${price}, còn ${balance}).`, { price, balance });
  }

  // Tạo job + reserve (trừ) credits nguyên tử.
  const jobId = uuidv7();
  Jobs.create({ id: jobId, clientId: client.id, prompt: params.prompt ?? params.settings?.prompt, params, price });
  const deduct = Credits.change(client.id, -price, 'usage', jobId);
  if (!deduct.ok) {
    Jobs.update(jobId, { status: 'failed', error: 'Không đủ credits (race)' });
    throw err('INSUFFICIENT_CREDITS', 'Không đủ credits.', { price });
  }
  monitor.noteCreate(client, ip, { modelGroupId: groupId, price });

  // Create trên artlist. Lỗi → hoàn credits.
  try {
    const { providerJobId } = await artlist.createGeneration({ ...params, ...quote, modelGroupId: groupId });
    Jobs.update(jobId, { provider_job_id: providerJobId, status: 'processing' });
    void pollUntilDone(jobId, providerJobId, client.id, price);
  } catch (e) {
    Credits.change(client.id, price, 'refund', jobId);
    Jobs.update(jobId, { status: 'failed', refunded: 1, error: String(e.message || e) });
    if (e.status === 401 || e.status === 403) monitor.noteSessionExpired(`HTTP ${e.status}`);
    throw err('CREATE_FAILED', 'Tạo video thất bại (đã hoàn credits).', { cause: String(e.message || e) });
  }
  return Jobs.get(jobId);
}

async function pollUntilDone(jobId, providerJobId, clientId, price) {
  const deadline = Date.now() + config.POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(config.POLL_INTERVAL_MS);
    try {
      const s = await artlist.status(providerJobId);
      if (s.status === 'done' || s.videoUrl) {
        Jobs.update(jobId, { status: 'done', video_url: s.videoUrl, thumbnail_url: s.thumbnailUrl });
        logger.info({ jobId }, '✅ video xong');
        return;
      }
      if (s.status === 'failed') return refund(jobId, clientId, price, s.error || 'artlist failed');
      Jobs.update(jobId, { status: 'processing' });
    } catch (e) {
      logger.warn({ jobId, err: String(e) }, 'poll lỗi, thử lại');
    }
  }
  refund(jobId, clientId, price, 'timeout');
}

function refund(jobId, clientId, price, error) {
  const job = Jobs.get(jobId);
  if (job && !job.refunded) Credits.change(clientId, price, 'refund', jobId);
  Jobs.update(jobId, { status: 'failed', refunded: 1, error });
  logger.warn({ jobId, error }, '↩️ job thất bại — đã hoàn credits');
}

/** Khi khởi động lại: gắn lại poller cho job còn 'processing'. */
export function recoverPollers() {
  const jobs = Jobs.listProcessing().filter((j) => j.provider_job_id);
  for (const j of jobs) void pollUntilDone(j.id, j.provider_job_id, j.client_id, j.price);
  if (jobs.length) logger.info({ count: jobs.length }, 'Khôi phục poll job đang chạy');
}

/** Chuẩn hoá job ra ngoài cho client. */
export function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.id,
    status: job.status,
    videoUrl: job.video_url,
    thumbnailUrl: job.thumbnail_url,
    credits: job.price,
    error: job.error,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
  };
}
