import { Settings } from '../db/repos.js';
import { config } from '../config.js';

/**
 * Chống brute-force đăng nhập admin — 2 lớp (lưu app_settings/DB → xuyên mọi instance):
 *  1) Per-IP: sai >= LOGIN_MAX_FAILS trong cửa sổ → khoá IP đó.
 *  2) TOÀN CỤC: tổng sai (mọi IP) >= LOGIN_MAX_FAILS_GLOBAL → khoá mọi đăng nhập.
 * Lớp toàn cục bắt được kẻ tấn công XOAY IP (per-IP không chặn nổi). Admin vẫn có thể
 * dùng ADMIN_TOKEN thô (bỏ qua login) hoặc POST /admin/login/unlock để mở khoá ngay.
 */
const IPKEY = (ip) => `login_guard:ip:${ip || 'unknown'}`;
const GKEY = 'login_guard:global';

async function read(k) { try { return JSON.parse((await Settings.get(k)) || '{}'); } catch { return {}; } }

function bump(s, now, windowMs, maxFails, lockMs) {
  if (!s.windowStart || now - s.windowStart > windowMs) s = { fails: 0, windowStart: now, lockedUntil: 0 };
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= maxFails) s.lockedUntil = now + lockMs;
  return s;
}

/** Có đang bị khoá không (IP hoặc toàn cục)? */
export async function loginStatus(ip) {
  const now = Date.now();
  for (const [k, scope] of [[IPKEY(ip), 'ip'], [GKEY, 'global']]) {
    const s = await read(k);
    if (s.lockedUntil && s.lockedUntil > now) return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000), scope };
  }
  return { locked: false };
}

/** Ghi 1 lần SAI → tăng cả đếm IP lẫn toàn cục, khoá nếu vượt ngưỡng. */
export async function recordFail(ip) {
  const now = Date.now();
  const windowMs = config.LOGIN_WINDOW_MIN * 60_000;
  const lockMs = config.LOGIN_LOCK_MIN * 60_000;
  const ipS = bump(await read(IPKEY(ip)), now, windowMs, config.LOGIN_MAX_FAILS, lockMs);
  await Settings.set(IPKEY(ip), JSON.stringify(ipS));
  const gS = bump(await read(GKEY), now, windowMs, config.LOGIN_MAX_FAILS_GLOBAL, lockMs);
  await Settings.set(GKEY, JSON.stringify(gS));
  return { ipFails: ipS.fails, ipLocked: !!ipS.lockedUntil, globalFails: gS.fails, globalLocked: !!gS.lockedUntil, locked: !!(ipS.lockedUntil || gS.lockedUntil) };
}

/** Đăng nhập ĐÚNG → xoá khoá IP + reset toàn cục. */
export async function recordSuccess(ip) {
  const clean = JSON.stringify({ fails: 0, windowStart: Date.now(), lockedUntil: 0 });
  try { await Settings.set(IPKEY(ip), clean); await Settings.set(GKEY, clean); } catch { /* noop */ }
}

/** Mở khoá toàn bộ (admin gọi khi bị khoá nhầm). */
export async function clearAll() {
  try { return await Settings.deleteKeysLike('login_guard:'); } catch { return 0; }
}
