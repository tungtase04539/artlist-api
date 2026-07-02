import Fastify from 'fastify';
import { logger } from './lib/logger.js';
import { ready } from './db/db.js';
import { session } from './session/session.js';
import { logEvent } from './lib/events.js';
import v1Routes from './routes/v1.js';
import adminRoutes from './routes/admin.js';
import docsRoutes from './routes/docs.js';
import systemRoutes from './routes/system.js';

// Không log HTTP cho các path tĩnh/ồn (health, docs, dashboard...) — tránh nhiễu.
const SKIP_HTTP_LOG = new Set(['/health', '/openapi.json', '/docs', '/dashboard', '/guide', '/app', '/favicon.ico']);

/** Dựng Fastify app (dùng chung cho standalone `src/index.js` và serverless `api/index.js`). */
export async function buildApp() {
  // Khởi tạo DB + migrate sớm, nhưng KHÔNG để lỗi DB làm sập cả app:
  // /health và các route không cần DB vẫn chạy; route cần DB sẽ báo lỗi riêng.
  // (query() vẫn tự init lazy ở lần gọi đầu nếu ở đây fail.)
  try { await ready(); } catch (e) { logger.error({ err: String(e.message || e) }, 'DB init lỗi khi boot — sẽ thử lại lúc query'); }

  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 256 * 1024 });

  // Header bảo mật cơ bản + bắt code lỗi cho response 4xx/5xx (để log soi được nguyên nhân).
  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
    if (reply.statusCode >= 400 && typeof payload === 'string' && payload[0] === '{') {
      try { const b = JSON.parse(payload); req.errMeta = { code: b.code, error: String(b.error || '').slice(0, 160) }; } catch { /* noop */ }
    }
  });

  // ── Ghi log mọi HTTP (trừ path tĩnh) với latency + status ──
  app.addHook('onRequest', async (req) => { req.startTime = Date.now(); });
  app.addHook('onResponse', async (req, reply) => {
    const path = String(req.url).split('?')[0];
    if (SKIP_HTTP_LOG.has(path)) return;
    const status = reply.statusCode;
    await logEvent({
      level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
      category: 'http', event: `${req.method} ${path}`,
      clientId: req.client?.id ?? null, requestId: req.id, method: req.method, path,
      statusCode: status, durationMs: Date.now() - (req.startTime || Date.now()), ip: req.realIp ?? req.ip,
      ...(req.errMeta ? { message: req.errMeta.error, meta: { code: req.errMeta.code } } : {}),
    });
  });

  // Lỗi chưa bắt → ghi log rồi trả lỗi gọn (không lộ nội bộ).
  app.setErrorHandler(async (err, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    await logEvent({
      level: 'error', category: 'error', event: 'unhandled',
      clientId: req.client?.id ?? null, requestId: req.id, method: req.method, path: String(req.url).split('?')[0],
      statusCode: status, ip: req.realIp ?? req.ip, message: String(err.message), meta: { code: err.code },
    });
    reply.code(status).send({ error: status < 500 ? err.message : 'Lỗi máy chủ', code: err.code || 'ERROR' });
  });

  app.get('/health', async () => ({ status: 'ok', session: session.status() }));

  await app.register(v1Routes); // client API (X-API-Key)
  await app.register(adminRoutes); // admin API (ADMIN_TOKEN)
  await app.register(docsRoutes); // /docs, /openapi.json, /dashboard
  await app.register(systemRoutes); // /cron/sweep

  return app;
}
