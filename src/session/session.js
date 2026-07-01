import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Quản lý session gửi sang artlist: cookie/token/CSRF, và trạng thái còn hợp lệ hay không.
 * Khi gặp 401/403, đánh dấu invalid để API báo user cập nhật cookie thay vì thử vô ích.
 */
class Session {
  constructor() {
    /** @type {boolean} */
    this.valid = true;
    /** @type {string | null} */
    this.invalidReason = null;
  }

  /** Header xác thực gắn vào mọi request sang artlist. */
  authHeaders() {
    /** @type {Record<string,string>} */
    const headers = {};
    if (config.ARTLIST_COOKIE) headers['cookie'] = config.ARTLIST_COOKIE;
    if (config.ARTLIST_AUTH_TOKEN) headers['authorization'] = `Bearer ${config.ARTLIST_AUTH_TOKEN}`;
    if (config.ARTLIST_CSRF_TOKEN) headers['x-csrf-token'] = config.ARTLIST_CSRF_TOKEN;
    return headers;
  }

  /** Header giả trình duyệt cơ bản (bổ sung/điều chỉnh theo cURL bắt được). */
  browserHeaders() {
    return {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'content-type': 'application/json',
      'origin': config.ARTLIST_BASE_URL || '',
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    };
  }

  markInvalid(reason) {
    if (this.valid) logger.error({ reason }, '🔒 Session không còn hợp lệ — cần cập nhật cookie/token');
    this.valid = false;
    this.invalidReason = reason;
  }

  assertValid() {
    if (!this.valid) {
      throw new Error(`Session hết hạn: ${this.invalidReason}. Cập nhật ARTLIST_COOKIE trong .env và khởi động lại.`);
    }
  }
}

export const session = new Session();
