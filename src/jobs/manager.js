import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { uuidv7 } from '../lib/uuid.js';
import * as artlist from '../artlist/client.js';
import { jobStore } from './store.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Tạo job: gọi submit sang artlist rồi khởi động worker poll nền.
 * Trả job ngay lập tức (async) — client sẽ poll GET /api/videos/:id.
 *
 * @param {import('../artlist/types.js').GenerateParams} params
 */
export async function createJob(params) {
  if (jobStore.countActive() >= config.MAX_CONCURRENT_JOBS) {
    const err = new Error('Đang có quá nhiều job chạy đồng thời, thử lại sau.');
    err.code = 'TOO_MANY_JOBS';
    throw err;
  }

  // chatSessionId gom nhiều generation vào 1 "project". Tự sinh UUIDv7 nếu caller không truyền.
  const p = { ...params, chatSessionId: params.chatSessionId || uuidv7() };

  const now = Date.now();
  const job = jobStore.create(p, now);

  try {
    const { providerJobId } = await artlist.submit(p);
    jobStore.update(job.id, { providerJobId, status: 'processing' }, Date.now());
    // Khởi động poll nền, không await để trả response ngay.
    void pollUntilDone(job.id, providerJobId);
  } catch (err) {
    jobStore.update(job.id, { status: 'failed', error: String(err.message || err) }, Date.now());
    logger.error({ jobId: job.id, err: String(err) }, 'submit thất bại');
  }

  return jobStore.get(job.id);
}

/**
 * Vòng lặp poll trạng thái tới khi done/failed hoặc quá timeout.
 * @param {string} jobId
 * @param {string} providerJobId
 */
async function pollUntilDone(jobId, providerJobId) {
  const deadline = Date.now() + config.POLL_TIMEOUT_MS;

  while (Date.now() < deadline) {
    await sleep(config.POLL_INTERVAL_MS);
    try {
      const s = await artlist.status(providerJobId);

      if (s.status === 'done' || s.videoUrl) {
        jobStore.update(jobId, { status: 'done', progress: 100, videoUrl: s.videoUrl }, Date.now());
        logger.info({ jobId }, '✅ video xong');
        return;
      }
      if (s.status === 'failed') {
        jobStore.update(jobId, { status: 'failed', error: s.error || 'artlist báo failed' }, Date.now());
        return;
      }
      jobStore.update(jobId, { status: 'processing', progress: s.progress }, Date.now());
    } catch (err) {
      // Lỗi tạm thời trong lúc poll: log và thử tiếp cho tới deadline.
      logger.warn({ jobId, err: String(err) }, 'lỗi khi poll, sẽ thử lại');
    }
  }

  jobStore.update(jobId, { status: 'failed', error: 'Quá thời gian chờ (timeout)' }, Date.now());
  logger.error({ jobId }, '⏱️ job timeout');
}
