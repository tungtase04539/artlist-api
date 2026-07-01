import { logger } from './logger.js';
import { Events } from '../db/repos.js';

const LVL = new Set(['debug', 'info', 'warn', 'error']);

/**
 * Ghi 1 sự kiện có cấu trúc: ra stdout (pino, xem nhanh trên Vercel) + bền hoá DB (event_log,
 * để đọc lại & soi bất thường). Best-effort: lỗi ghi log KHÔNG bao giờ làm hỏng luồng chính.
 *
 * @param {{level?,category,event,clientId?,jobId?,requestId?,method?,path?,statusCode?,durationMs?,ip?,message?,meta?}} e
 */
export async function logEvent(e) {
  const level = LVL.has(e.level) ? e.level : 'info';
  try {
    logger[level](
      { cat: e.category, ev: e.event, clientId: e.clientId, jobId: e.jobId, status: e.statusCode, ms: e.durationMs, ...(e.meta ? { meta: e.meta } : {}) },
      `[${e.category}] ${e.event}${e.message ? ': ' + e.message : ''}`,
    );
  } catch { /* noop */ }
  try {
    await Events.add({ ...e, level });
  } catch (err) {
    try { logger.warn({ err: String(err.message || err) }, 'event_log ghi lỗi (bỏ qua)'); } catch { /* noop */ }
  }
}
