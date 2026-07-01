import Fastify from 'fastify';
import { logger } from './lib/logger.js';
import { ready } from './db/db.js';
import { session } from './session/session.js';
import v1Routes from './routes/v1.js';
import adminRoutes from './routes/admin.js';
import docsRoutes from './routes/docs.js';
import systemRoutes from './routes/system.js';

/** Dựng Fastify app (dùng chung cho standalone `src/index.js` và serverless `api/index.js`). */
export async function buildApp() {
  // Khởi tạo DB + migrate sớm, nhưng KHÔNG để lỗi DB làm sập cả app:
  // /health và các route không cần DB vẫn chạy; route cần DB sẽ báo lỗi riêng.
  // (query() vẫn tự init lazy ở lần gọi đầu nếu ở đây fail.)
  try { await ready(); } catch (e) { logger.error({ err: String(e.message || e) }, 'DB init lỗi khi boot — sẽ thử lại lúc query'); }

  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 256 * 1024 });

  // Header bảo mật cơ bản (chống sniffing/clickjacking/rò referrer) — không cần thư viện ngoài.
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('x-frame-options', 'DENY');
    reply.header('referrer-policy', 'no-referrer');
  });

  app.get('/health', async () => ({ status: 'ok', session: session.status() }));

  await app.register(v1Routes); // client API (X-API-Key)
  await app.register(adminRoutes); // admin API (ADMIN_TOKEN)
  await app.register(docsRoutes); // /docs, /openapi.json, /dashboard
  await app.register(systemRoutes); // /cron/sweep

  return app;
}
