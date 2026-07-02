import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Session token gọn nhẹ (mini-JWT HS256) cho đăng nhập admin bằng tài khoản/mật khẩu.
 * Ký bằng secret server (ADMIN_TOKEN) → trình duyệt chỉ giữ token có hạn, KHÔNG giữ ADMIN_TOKEN.
 */
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function signSession(payload, secret, ttlMs = 12 * 3600 * 1000) {
  const body = b64u(JSON.stringify({ ...payload, exp: Date.now() + ttlMs }));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

/** Trả payload nếu hợp lệ & chưa hết hạn, ngược lại null. */
export function verifySession(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') < 1) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', secret).update(body).digest();
  let given;
  try { given = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { return null; }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/** So sánh chuỗi an toàn thời gian. */
export function safeEqualStr(a, b) {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
