import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { Usage, Alerts, Clients } from '../db/repos.js';

/**
 * Giám sát sử dụng + phát hiện lạm dụng/cheat. Ghi usage_events, dựng alerts (dedup qua DB),
 * chặn khi vượt rate limit. Kênh: dashboard + log.
 *
 * Dấu hiệu: rate_abuse · quota_abuse · error_spike · key_sharing · price_mismatch · session_expired
 */

const GENERAL_REQ_CAP_PER_MIN = 120;
const MIN = 60_000;
const HOUR = 3_600_000;
const ALERT_DEDUP_MS = 5 * MIN;

async function raise({ clientId = null, severity, kind, message, meta = null }) {
  if (await Alerts.existsRecent(clientId, kind, ALERT_DEDUP_MS)) return;
  await Alerts.add({ clientId, severity, kind, message, meta });
  logger[severity === 'critical' ? 'error' : 'warn']({ clientId, kind, meta }, `🚨 ALERT: ${message}`);
}
export const raiseAlert = raise;

/** Đầu mỗi request client: ghi event + chặn nếu spam. Trả {allowed, code, message}. */
export async function recordRequest(client, apiKeyId, ip, path) {
  await Usage.record({ clientId: client.id, apiKeyId, type: 'request', path, ip });

  const perMin = await Usage.countRecent(client.id, MIN, ['request']);
  if (perMin > GENERAL_REQ_CAP_PER_MIN) {
    await Usage.record({ clientId: client.id, apiKeyId, type: 'rate_block', path, ip });
    await raise({ clientId: client.id, severity: 'warning', kind: 'rate_abuse', message: `Client spam ${perMin} req/phút (trần ${GENERAL_REQ_CAP_PER_MIN})`, meta: { perMin, ip } });
    return { allowed: false, code: 429, message: 'Quá nhiều request, thử lại sau.' };
  }
  await analyze(client, ip);
  return { allowed: true };
}

/** Rate limit TẠO VIDEO. Trả {allowed, message}. */
export async function allowCreate(client) {
  const perMin = await Usage.countRecent(client.id, MIN, ['create']);
  if (perMin >= client.rate_per_min) {
    await raise({ clientId: client.id, severity: 'info', kind: 'rate_abuse', message: `Vượt rate tạo video: ${perMin}/phút (giới hạn ${client.rate_per_min})`, meta: { perMin } });
    return { allowed: false, message: `Vượt giới hạn ${client.rate_per_min} video/phút.` };
  }
  const perDay = await Usage.countRecent(client.id, 24 * HOUR, ['create']);
  if (perDay >= client.rate_per_day) {
    await raise({ clientId: client.id, severity: 'info', kind: 'rate_abuse', message: `Vượt rate tạo video: ${perDay}/ngày (giới hạn ${client.rate_per_day})`, meta: { perDay } });
    return { allowed: false, message: `Vượt giới hạn ${client.rate_per_day} video/ngày.` };
  }
  return { allowed: true };
}

export async function noteCreate(client, ip, meta = null) {
  await Usage.record({ clientId: client.id, type: 'create', ip, meta });
}

export async function noteQuotaBlock(client, { needed, balance, ip = null } = {}) {
  await Usage.record({ clientId: client.id, type: 'quota_block', ip, meta: { needed, balance } });
  const recent = await Usage.countRecent(client.id, 10 * MIN, ['quota_block']);
  if (recent >= 5) {
    await raise({ clientId: client.id, severity: 'warning', kind: 'quota_abuse', message: `Client liên tục cố tạo khi hết credits (${recent} lần/10') — nghi khai thác`, meta: { needed, balance } });
  }
}

export async function notePriceMismatch(client, { claimed, actual, ip = null } = {}) {
  await Usage.record({ clientId: client.id, type: 'error', ip, meta: { claimed, actual, reason: 'price_mismatch' } });
  await raise({ clientId: client.id, severity: 'critical', kind: 'price_mismatch', message: `Giá gửi (${claimed}) khác giá quote thật (${actual}) — cố cheat giá`, meta: { claimed, actual } });
  if (config.ABUSE_AUTO_SUSPEND) {
    await Clients.setStatus(client.id, 'suspended');
    await raise({ clientId: client.id, severity: 'critical', kind: 'auto_suspend', message: 'Đã TỰ KHOÁ client do cố cheat giá', meta: { claimed, actual } });
  }
}

export async function noteSessionExpired(reason) {
  await raise({ severity: 'critical', kind: 'session_expired', message: `Session artlist hết hạn/bị chặn (${reason}) — cần cập nhật cookie`, meta: { reason } });
}

async function analyze(client, ip) {
  const { total, rate } = await Usage.errorRate(client.id, 10 * MIN);
  if (total >= config.ABUSE_MIN_EVENTS && rate >= config.ABUSE_ERROR_RATE) {
    await raise({ clientId: client.id, severity: 'warning', kind: 'error_spike', message: `Tỉ lệ lỗi cao ${(rate * 100).toFixed(0)}% (${total} req/10') — nghi dò endpoint/tham số`, meta: { rate, total } });
  }
  const ips = await Usage.distinctIps(client.id, HOUR);
  if (ips >= config.ABUSE_MULTI_IP) {
    await raise({ clientId: client.id, severity: 'warning', kind: 'key_sharing', message: `Key dùng từ ${ips} IP khác nhau trong 1h — nghi rò/chia sẻ key`, meta: { ips, lastIp: ip } });
  }
}
