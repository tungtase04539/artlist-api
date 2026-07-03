import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { uuidv7 } from '../lib/uuid.js';
import * as suno from '../suno/client.js';
import { MusicJobs, Credits } from '../db/repos.js';
import * as monitor from '../abuse/monitor.js';
import { logEvent } from '../lib/events.js';

function err(code, message, extra = {}) {
  const e = new Error(message);
  e.code = code;
  Object.assign(e, extra);
  return e;
}

/** Giá bán 1 lần tạo nhạc (credits) — cố định, admin chỉnh qua SUNO_PRICE_CREDITS. */
export function musicPrice() {
  return config.SUNO_PRICE_CREDITS;
}

/**
 * Tạo nhạc cho client (không poll nền — serverless poll on-demand).
 * Trừ credits theo giá cố định; hoàn nếu gọi nguồn lỗi.
 */
export async function createMusic(client, params, ip) {
  if (!suno.isEnabled()) throw err('MUSIC_DISABLED', 'Tính năng tạo nhạc chưa được bật.');

  if ((await MusicJobs.countActiveByClient(client.id)) >= config.MAX_CONCURRENT_PER_CLIENT) {
    throw err('RATE_LIMITED', `Đang có quá nhiều job nhạc chạy đồng thời (tối đa ${config.MAX_CONCURRENT_PER_CLIENT}).`);
  }
  const rl = await monitor.allowCreate(client);
  if (!rl.allowed) throw err('RATE_LIMITED', rl.message);

  const price = musicPrice();

  // Cờ ignore_price_caps: reseller cho khách gọi thoải mái — bỏ qua maxCredits/expectedCredits.
  if (!client.ignore_price_caps) {
    if (params.expectedCredits != null && Number(params.expectedCredits) !== price) {
      await monitor.notePriceMismatch(client, { claimed: params.expectedCredits, actual: price, ip });
      throw err('PRICE_MISMATCH', `Giá không khớp: thực tế ${price} credits.`, { price });
    }
    if (params.maxCredits != null && price > Number(params.maxCredits)) {
      throw err('PRICE_TOO_HIGH', `Giá ${price} vượt maxCredits (${params.maxCredits}).`, { price });
    }
  }

  const balance = await Credits.balance(client.id);
  if (balance < price) {
    await monitor.noteQuotaBlock(client, { needed: price, balance, ip });
    throw err('INSUFFICIENT_CREDITS', `Không đủ credits (cần ${price}, còn ${balance}).`, { price, balance });
  }

  const promptText = params.mode === 'custom' ? (params.title || params.lyrics || params.tags || '') : params.prompt;
  const jobId = uuidv7();
  await MusicJobs.create({ id: jobId, clientId: client.id, mode: params.mode, prompt: promptText, params, price });
  const deduct = await Credits.change(client.id, -price, 'usage', jobId);
  if (!deduct.ok) {
    await MusicJobs.update(jobId, { status: 'failed', error: 'Không đủ credits (race)' });
    throw err('INSUFFICIENT_CREDITS', 'Không đủ credits.', { price });
  }
  await monitor.noteCreate(client, ip, { kind: 'music', mode: params.mode, price });

  try {
    const { taskId } = await suno.createMusic(params);
    logEvent({ level: 'info', category: 'music', event: 'created', clientId: client.id, jobId, meta: { mode: params.mode, price } }).catch(() => {});
    return await MusicJobs.update(jobId, { provider_task_id: taskId, status: 'processing' });
  } catch (e) {
    await Credits.change(client.id, price, 'refund', jobId);
    await MusicJobs.update(jobId, { status: 'failed', refunded: true, error: String(e.message || e) });
    logEvent({ level: 'error', category: 'music', event: 'create_failed', clientId: client.id, jobId, message: String(e.message || e), meta: { price, refunded: true } }).catch(() => {});
    throw err('CREATE_FAILED', 'Tạo nhạc thất bại (đã hoàn credits).', { cause: String(e.message || e) });
  }
}

/** Đẩy 1 job nhạc đang chạy: hỏi AI33 status 1 lần → done/failed (hoàn credits nếu lỗi). Idempotent. */
export async function advanceMusicJob(job) {
  if (!job || !['pending', 'processing'].includes(job.status) || !job.provider_task_id) return job;
  if (Date.now() - Number(job.created_at) > config.SUNO_POLL_TIMEOUT_MS) return refund(job, 'timeout');
  try {
    const s = await suno.getTask(job.provider_task_id);
    if (s.status === 'done') {
      logEvent({ level: 'info', category: 'music', event: 'done', clientId: job.client_id, jobId: job.id, durationMs: Date.now() - Number(job.created_at), meta: { credits: job.price } }).catch(() => {});
      return await MusicJobs.update(job.id, {
        status: 'done', audio_url: s.audioUrl, audio_urls_json: JSON.stringify(s.audioUrls || []),
        image_url: s.imageUrl, title: s.title, duration: s.duration,
      });
    }
    if (s.status === 'failed') return refund(job, s.error || 'AI33 failed');
    const upd = await MusicJobs.update(job.id, { status: 'processing' });
    upd._progress = s.progress; // transient: hiển thị tiến độ + preview (không lưu DB)
    upd._streamUrl = s.streamUrl;
    return upd;
  } catch (e) {
    logger.warn({ jobId: job.id, err: String(e) }, 'advanceMusicJob lỗi');
    return job;
  }
}

async function refund(job, error) {
  if (!job.refunded) await Credits.change(job.client_id, job.price, 'refund', job.id);
  logEvent({ level: 'warn', category: 'music', event: 'failed', clientId: job.client_id, jobId: job.id, message: String(error), meta: { credits: job.price, refunded: true } }).catch(() => {});
  return MusicJobs.update(job.id, { status: 'failed', refunded: true, error });
}

/** Cron: đẩy các job nhạc đã "im" quá interval. */
export async function sweepStaleMusicJobs(olderThanMs = 15_000) {
  const jobs = await MusicJobs.listProcessing(olderThanMs);
  for (const j of jobs) await advanceMusicJob(j);
  return jobs.length;
}

export function publicMusicJob(job) {
  if (!job) return null;
  let audioUrls = [];
  try { audioUrls = job.audio_urls_json ? JSON.parse(job.audio_urls_json) : []; } catch { /* noop */ }
  return {
    jobId: job.id,
    status: job.status,
    mode: job.mode,
    audioUrl: job.audio_url,
    audioUrls,
    imageUrl: job.image_url,
    title: job.title,
    duration: job.duration,
    credits: job.price,
    progress: job._progress ?? (job.status === 'done' ? 100 : null),
    streamUrl: job._streamUrl ?? null,
    error: job.error,
    createdAt: Number(job.created_at),
    updatedAt: Number(job.updated_at),
  };
}
