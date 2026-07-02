import { config } from '../config.js';
import { verifySession, safeEqualStr } from '../lib/token.js';

/**
 * preHandler bảo vệ /admin/*: chấp nhận (a) ADMIN_TOKEN thô (API/cron) HOẶC
 * (b) session token từ /admin/login (đăng nhập tài khoản/mật khẩu). /admin/login được miễn.
 */
export async function adminAuth(request, reply) {
  if (String(request.url).split('?')[0] === '/admin/login') return; // login không cần auth
  const bearer = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : null;
  const tok = request.headers['x-admin-token'] || bearer;
  if (tok && (safeEqualStr(String(tok), config.ADMIN_TOKEN) || verifySession(String(tok), config.ADMIN_TOKEN))) return;
  return reply.code(401).send({ error: 'Chưa đăng nhập hoặc phiên hết hạn' });
}
