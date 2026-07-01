import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

/** preHandler bảo vệ /admin/*: cần header `x-admin-token` (hoặc Bearer) == ADMIN_TOKEN. */
export async function adminAuth(request, reply) {
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : null;
  const tok = request.headers['x-admin-token'] || bearer;
  if (!tok || !safeEqual(String(tok), config.ADMIN_TOKEN)) {
    return reply.code(401).send({ error: 'Thiếu hoặc sai admin token' });
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
