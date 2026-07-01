import Fastify from 'fastify';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { db } from './db/db.js';
import { session } from './session/session.js';
import v1Routes from './routes/v1.js';
import adminRoutes from './routes/admin.js';
import docsRoutes from './routes/docs.js';
import { recoverPollers } from './videos/service.js';

db(); // khởi tạo SQLite + migrate

const app = Fastify({ loggerInstance: logger, trustProxy: true });

// Public
app.get('/health', async () => ({ status: 'ok', session: session.status() }));

// Client API (X-API-Key) · Admin API (ADMIN_TOKEN) · Docs/Dashboard (public)
await app.register(v1Routes);
await app.register(adminRoutes);
await app.register(docsRoutes);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  recoverPollers();
  logger.info({ port: config.PORT, artlistReady: session.isReady() }, '🚀 Artlist Video API đang chạy');
  logger.info(`   Docs:      http://localhost:${config.PORT}/docs`);
  logger.info(`   Dashboard: http://localhost:${config.PORT}/dashboard`);
  if (!session.isReady()) {
    logger.warn('⚠️ Chưa có session artlist — /v1/* trả 503 tới khi cập nhật cookie (POST /admin/session hoặc .env).');
  }
} catch (err) {
  logger.error({ err: String(err) }, 'Không khởi động được server');
  process.exit(1);
}
