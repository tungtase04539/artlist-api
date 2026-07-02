import { Settings } from '../db/repos.js';
import { config } from '../config.js';

/**
 * Chống brute-force đăng nhập admin. Đếm số lần sai theo IP, lưu ở app_settings (DB) nên
 * hiệu lực xuyên mọi instance serverless. Sai >= LOGIN_MAX_FAILS trong LOGIN_WINDOW_MIN phút
 * → khoá IP LOGIN_LOCK_MIN phút.
 */
const KEY = (ip) => `login_guard:${ip || 'unknown'}`;

async function read(ip) {
  try { return JSON.parse((await Settings.get(KEY(ip))) || '{}'); } catch { return {}; }
}

/** Trạng thái khoá hiện tại của IP. */
export async function loginStatus(ip) {
  const s = await read(ip);
  const now = Date.now();
  if (s.lockedUntil && s.lockedUntil > now) return { locked: true, retryAfterSec: Math.ceil((s.lockedUntil - now) / 1000), fails: s.fails || 0 };
  return { locked: false, fails: s.fails || 0 };
}

/** Ghi 1 lần đăng nhập SAI → tăng đếm, khoá nếu vượt ngưỡng. Trả state mới. */
export async function recordFail(ip) {
  const now = Date.now();
  const windowMs = config.LOGIN_WINDOW_MIN * 60_000;
  let s = await read(ip);
  if (!s.windowStart || now - s.windowStart > windowMs) s = { fails: 0, windowStart: now, lockedUntil: 0 };
  s.fails = (s.fails || 0) + 1;
  if (s.fails >= config.LOGIN_MAX_FAILS) s.lockedUntil = now + config.LOGIN_LOCK_MIN * 60_000;
  await Settings.set(KEY(ip), JSON.stringify(s));
  return s;
}

/** Đăng nhập ĐÚNG → xoá đếm cho IP. */
export async function recordSuccess(ip) {
  try { await Settings.set(KEY(ip), JSON.stringify({ fails: 0, windowStart: Date.now(), lockedUntil: 0 })); } catch { /* noop */ }
}
