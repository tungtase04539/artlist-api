import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Settings } from '../db/repos.js';

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const STORE_KEY = 'artlist_session'; // key trong app_settings (cookie jar dùng chung mọi instance)
const LOAD_TTL_MS = 8000; // trong 1 instance, tối đa 8s mới đọc lại store (giảm query)

/** Nạp chuỗi "a=b; c=d" vào jar (Map). */
function parseInto(jar, str) {
  if (!str) return;
  for (const part of String(str).split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    if (name) jar.set(name, part.slice(i + 1).trim());
  }
}

/**
 * Quản lý session artlist. Cookie giữ trong 1 "jar" và TỰ LÀM MỚI từ Set-Cookie của artlist
 * (cf_clearance/__cf_bm/session-token gia hạn theo mỗi request) → không phải cập nhật thủ công
 * liên tục. Admin chỉ cần nạp lại khi login thật hết hạn hoặc Cloudflare challenge cứng.
 */
class Session {
  constructor() {
    this.valid = true;
    this.invalidReason = null;
    this._jar = new Map();
    this._ua = null;
    this._csrf = null;
    this._runtimeSet = false;
    this.updatedAt = null;
    this._loadedAt = 0;
    parseInto(this._jar, config.ARTLIST_COOKIE);
  }

  /** Admin nạp cookie/UA lúc chạy (merge vào jar). Gọi persist() sau để lưu DB. */
  setCredentials({ cookie, userAgent, csrf } = {}) {
    if (cookie) { parseInto(this._jar, cookie); this._runtimeSet = true; }
    if (userAgent) this._ua = userAgent;
    if (csrf) this._csrf = csrf;
    this.valid = true;
    this.invalidReason = null;
    this.updatedAt = Date.now();
    logger.info('🔑 Session artlist đã cập nhật cookie mới');
  }

  /** Tự làm mới cookie từ Set-Cookie của response artlist. Trả về true nếu jar đổi. */
  mergeSetCookie(setCookieList) {
    if (!setCookieList || !setCookieList.length) return false;
    let changed = false;
    for (const sc of setCookieList) {
      const first = String(sc).split(';')[0];
      const i = first.indexOf('=');
      if (i < 1) continue;
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (!name || value === '' || value.toLowerCase() === 'deleted') continue;
      if (this._jar.get(name) !== value) { this._jar.set(name, value); changed = true; }
    }
    if (changed) this.updatedAt = Date.now();
    return changed;
  }

  // ── Bền hoá cookie qua DB (bắt buộc cho serverless: nhiều instance dùng chung 1 jar) ──

  /** Đọc lại jar từ DB nếu cache đã cũ (>LOAD_TTL_MS). An toàn khi DB chưa sẵn sàng. */
  async ensureFresh() {
    if (Date.now() - this._loadedAt < LOAD_TTL_MS) return;
    await this.loadFromStore();
  }

  /** Nạp jar/ua/csrf mới nhất từ app_settings (nếu store mới hơn bản trong RAM). */
  async loadFromStore() {
    this._loadedAt = Date.now();
    try {
      const raw = await Settings.get(STORE_KEY);
      if (!raw) {
        // Store trống + đã có cookie seed từ env → ghi 1 lần để bắt đầu tích luỹ auto-refresh.
        if (this._jar.size > 0) { this.updatedAt = this.updatedAt ?? Date.now(); await this.persist(); }
        return;
      }
      const s = JSON.parse(raw);
      if (s.updatedAt && this.updatedAt && s.updatedAt <= this.updatedAt) return; // bản RAM mới hơn
      if (s.jar && typeof s.jar === 'object') { this._jar = new Map(Object.entries(s.jar)); this._runtimeSet = true; }
      if (s.ua) this._ua = s.ua;
      if (s.csrf) this._csrf = s.csrf;
      this.updatedAt = s.updatedAt ?? this.updatedAt;
      this.valid = true;
      this.invalidReason = null;
    } catch (e) {
      logger.warn({ err: String(e.message || e) }, 'Đọc session store lỗi (bỏ qua)');
    }
  }

  /** Ghi jar/ua/csrf hiện tại xuống app_settings để mọi instance thấy. */
  async persist() {
    try {
      const payload = JSON.stringify({
        jar: Object.fromEntries(this._jar),
        ua: this._ua,
        csrf: this._csrf,
        updatedAt: this.updatedAt ?? Date.now(),
      });
      await Settings.set(STORE_KEY, payload);
      this._loadedAt = Date.now();
    } catch (e) {
      logger.warn({ err: String(e.message || e) }, 'Lưu session store lỗi (bỏ qua)');
    }
  }

  cookie() {
    if (this._jar.size === 0) return config.ARTLIST_COOKIE || null;
    return [...this._jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  userAgent() {
    return this._ua || config.ARTLIST_USER_AGENT || DEFAULT_UA;
  }
  isReady() {
    return Boolean(config.ARTLIST_BASE_URL && (this.cookie() || config.ARTLIST_AUTH_TOKEN));
  }

  authHeaders() {
    const h = {};
    const c = this.cookie();
    if (c) h.cookie = c;
    if (config.ARTLIST_AUTH_TOKEN) h.authorization = `Bearer ${config.ARTLIST_AUTH_TOKEN}`;
    const csrf = this._csrf || config.ARTLIST_CSRF_TOKEN;
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
      usingRuntimeOverride: this._runtimeSet,
      cookieCount: this._jar.size,
      updatedAt: this.updatedAt,
    };
  }
}

export const session = new Session();
