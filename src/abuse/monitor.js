import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Usage, Alerts } from '../db/repos.js';

/**
 * Giám sát sử dụng + phát hiện lạm dụng/cheat. Ghi usage_events, dựng cảnh báo (alerts),
 * và chặn khi vượt rate limit. Kênh cảnh báo: dashboard + log (theo cấu hình đã chọn).
 *
 * Các dấu hiệu theo dõi:
 *  - rate_abuse   : spam request vượt trần / vượt rate limit tạo video
 *  - quota_abuse  : liên tục cố tạo khi hết credits
 *  - error_spike  : tỉ lệ lỗi cao (dò endpoint / tham số sai)
 *  - key_sharing  : 1 key dùng từ nhiều IP bất thường (nghi rò key)
 *  - price_mismatch: giá client gửi != giá quote thật (cố cheat giá)
 *  - session_expired: cookie artlist hết hạn (ảnh hưởng toàn dịch vụ)
 */

const GENERAL_REQ_CAP_PER_MIN = 120; // trần chống spam mọi request/client/phút
const MIN = 60_000;
const HOUR = 3_600_000;

// Throttle cảnh báo: không dựng trùng (client+kind) trong 5 phút.
const _lastAlert = new Map();
function raise({ clientId = null, severity, kind, message, meta = null }) {
  const key = `${clientId}:${kind}`;
  const t = Date.now();
  if (t - (_lastAlert.get(key) ?? 0) < 5 * MIN) return;
  _lastAlert.set(key, t);
  Alerts.add({ clientId, severity, kind, message, meta });
  logger[severity === 'critical' ? 'error' : 'warn']({ clientId, kind, meta }, `🚨 ALERT: ${message}`);
}
export const raiseAlert = raise;

/** Gọi đầu mỗi request client. Ghi event + chặn nếu spam. Trả {allowed, code, message}. */
export function recordRequest(client, apiKeyId, ip, path) {
  Usage.record({ clientId: client.id, apiKeyId, type: 'request', path, ip });

  const perMin = Usage.countRecent(client.id, MIN, ['request']);
  if (perMin > GENERAL_REQ_CAP_PER_MIN) {
    Usage.record({ clientId: client.id, apiKeyId, type: 'rate_block', path, ip });
    raise({ clientId: client.id, severity: 'warning', kind: 'rate_abuse',
      message: `Client spam ${perMin} req/phút (trần ${GENERAL_REQ_CAP_PER_MIN})`, meta: { perMin, ip } });
    return { allowed: false, code: 429, message: 'Quá nhiều request, thử lại sau.' };
  }

  // Heuristic chạy nền nhẹ mỗi request.
  analyze(client, ip);
  return { allowed: true };
}

/** Kiểm tra rate limit TẠO VIDEO (hành động tốn credits). Trả {allowed, message}. */
export function allowCreate(client) {
  const perMin = Usage.countRecent(client.id, MIN, ['create']);
  if (perMin >= client.rate_per_min) {
    raise({ clientId: client.id, severity: 'info', kind: 'rate_abuse',
      message: `Vượt rate tạo video: ${perMin}/phút (giới hạn ${client.rate_per_min})`, meta: { perMin } });
    return { allowed: false, message: `Vượt giới hạn ${client.rate_per_min} video/phút.` };
  }
  const perDay = Usage.countRecent(client.id, 24 * HOUR, ['create']);
  if (perDay >= client.rate_per_day) {
    raise({ clientId: client.id, severity: 'info', kind: 'rate_abuse',
      message: `Vượt rate tạo video: ${perDay}/ngày (giới hạn ${client.rate_per_day})`, meta: { perDay } });
    return { allowed: false, message: `Vượt giới hạn ${client.rate_per_day} video/ngày.` };
  }
  return { allowed: true };
}

export function noteCreate(client, ip, meta = null) {
  Usage.record({ clientId: client.id, type: 'create', ip, meta });
}

export function noteError(client, { apiKeyId = null, ip = null, path = null, statusCode = null, meta = null } = {}) {
  Usage.record({ clientId: client?.id ?? null, apiKeyId, type: 'error', path, statusCode, ip, meta });
}

/** Client cố tạo khi không đủ credits. */
export function noteQuotaBlock(client, { needed, balance, ip = null } = {}) {
  Usage.record({ clientId: client.id, type: 'quota_block', ip, meta: { needed, balance } });
  const recent = Usage.countRecent(client.id, 10 * MIN, ['quota_block']);
  if (recent >= 5) {
    raise({ clientId: client.id, severity: 'warning', kind: 'quota_abuse',
      message: `Client liên tục cố tạo khi hết credits (${recent} lần/10') — nghi dò/khai thác`, meta: { needed, balance } });
  }
}

/** Giá client gửi khác giá quote thật (cố cheat). */
export function notePriceMismatch(client, { claimed, actual, ip = null } = {}) {
  Usage.record({ clientId: client.id, type: 'error', ip, meta: { claimed, actual, reason: 'price_mismatch' } });
  raise({ clientId: client.id, severity: 'critical', kind: 'price_mismatch',
    message: `Giá gửi (${claimed}) khác giá quote thật (${actual}) — cố cheat giá`, meta: { claimed, actual } });
}

/** Cookie artlist hết hạn — ảnh hưởng toàn dịch vụ. */
export function noteSessionExpired(reason) {
  raise({ severity: 'critical', kind: 'session_expired',
    message: `Session artlist hết hạn/bị chặn (${reason}) — cần cập nhật cookie`, meta: { reason } });
}

/** Heuristic hậu kiểm: tỉ lệ lỗi cao & rò key (nhiều IP). */
function analyze(client, ip) {
  const { total, rate } = Usage.errorRate(client.id, 10 * MIN);
  if (total >= config.ABUSE_MIN_EVENTS && rate >= config.ABUSE_ERROR_RATE) {
    raise({ clientId: client.id, severity: 'warning', kind: 'error_spike',
      message: `Tỉ lệ lỗi cao ${(rate * 100).toFixed(0)}% (${total} req/10') — nghi dò endpoint/tham số`, meta: { rate, total } });
  }
  const ips = Usage.distinctIps(client.id, HOUR);
  if (ips >= config.ABUSE_MULTI_IP) {
    raise({ clientId: client.id, severity: 'warning', kind: 'key_sharing',
      message: `Key dùng từ ${ips} IP khác nhau trong 1h — nghi rò/chia sẻ key`, meta: { ips, lastIp: ip } });
  }
}
