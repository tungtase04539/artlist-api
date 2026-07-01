import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Quản lý session gửi sang artlist. Cookie/UA lấy từ .env HOẶC override lúc chạy
 * (admin cập nhật qua POST /admin/session khi cookie hết hạn — không cần restart).
 */
class Session {
  constructor() {
    this.valid = true;
    this.invalidReason = null;
    this.override = { cookie: null, userAgent: null, csrf: null };
    this.updatedAt = null;
  }

  /** Admin cập nhật cookie/UA lúc chạy. */
  setCredentials({ cookie, userAgent, csrf } = {}) {
    if (cookie) this.override.cookie = cookie;
    if (userAgent) this.override.userAgent = userAgent;
    if (csrf) this.override.csrf = csrf;
    this.valid = true;
    this.invalidReason = null;
    this.updatedAt = Date.now();
    logger.info('🔑 Session artlist đã được cập nhật cookie mới');
  }

  cookie() {
    return this.override.cookie || config.ARTLIST_COOKIE || null;
  }
  userAgent() {
    return this.override.userAgent || config.ARTLIST_USER_AGENT || DEFAULT_UA;
  }
  /** Đủ điều kiện gọi artlist chưa. */
  isReady() {
    return Boolean(config.ARTLIST_BASE_URL && (this.cookie() || config.ARTLIST_AUTH_TOKEN));
  }

  authHeaders() {
    const h = {};
    const c = this.cookie();
    if (c) h.cookie = c;
    if (config.ARTLIST_AUTH_TOKEN) h.authorization = `Bearer ${config.ARTLIST_AUTH_TOKEN}`;
    const csrf = this.override.csrf || config.ARTLIST_CSRF_TOKEN;
    if (csrf) h['x-csrf-token'] = csrf;
    return h;
  }

  browserHeaders() {
    return {
      accept: '*/*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      origin: config.ARTLIST_BASE_URL || '',
      'x-trpc-source': 'nextjs-react',
      'user-agent': this.userAgent(),
    };
  }

  markInvalid(reason) {
    if (this.valid) logger.error({ reason }, '🔒 Session artlist không còn hợp lệ — cần cập nhật cookie');
    this.valid = false;
    this.invalidReason = reason;
  }

  assertValid() {
    if (!this.valid) {
      throw new Error(`Session hết hạn: ${this.invalidReason}. Admin cập nhật cookie qua POST /admin/session.`);
    }
  }

  status() {
    return {
      ready: this.isReady(),
      valid: this.valid,
      invalidReason: this.invalidReason,
      usingRuntimeOverride: Boolean(this.override.cookie),
      updatedAt: this.updatedAt,
    };
  }
}

export const session = new Session();
