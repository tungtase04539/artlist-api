import { logger } from './logger.js';

/** Lỗi có gắn HTTP status để tầng trên xử lý (session hết hạn, rate limit...). */
export class HttpError extends Error {
  /** @param {string} message @param {number} status @param {string} [body] */
  constructor(message, status, body) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch có retry + exponential backoff cho lỗi tạm thời (429, 5xx, network).
 * KHÔNG retry với 4xx khác (401/403/400) — đó là lỗi cần xử lý ngay, không phải tạm thời.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {{ retries?: number, baseDelayMs?: number, timeoutMs?: number }} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchWithRetry(url, options = {}, opts = {}) {
  const { retries = 3, baseDelayMs = 1000, timeoutMs = 30000 } = opts;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timer);

      // Retry cho rate-limit / lỗi server tạm thời.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : baseDelayMs * 2 ** attempt;
        attempt += 1;
        logger.warn({ url, status: res.status, attempt, delay }, 'retry sau lỗi tạm thời');
        await sleep(delay);
        continue;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      // Lỗi mạng / timeout → retry.
      if (attempt < retries) {
        const delay = baseDelayMs * 2 ** attempt;
        attempt += 1;
        logger.warn({ url, err: String(err), attempt, delay }, 'retry sau lỗi mạng');
        await sleep(delay);
        continue;
      }
      throw new HttpError(`Network error: ${String(err)}`, 0);
    }
  }
}
