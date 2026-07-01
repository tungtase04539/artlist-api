import { config } from './config.js';
import { logger } from './lib/logger.js';
import { session } from './session/session.js';
import { buildApp } from './app.js';
import { sweepStaleJobs } from './videos/service.js';

/** Bản standalone (VPS/local). Serverless (Vercel) dùng api/index.js. */
const app = await buildApp();

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info({ port: config.PORT, artlistReady: session.isReady() }, '🚀 Artlist Video API đang chạy');
  logger.info(`   Docs:      http://localhost:${config.PORT}/docs`);
  logger.info(`   Dashboard: http://localhost:${config.PORT}/dashboard`);
  if (!session.isReady()) {
    logger.warn('⚠️ Chưa có session artlist — /v1/* trả 503 tới khi cập nhật cookie (POST /admin/session hoặc .env).');
  }
  // Host chạy dài: quét job treo định kỳ (serverless dùng /cron/sweep thay thế).
  const timer = setInterval(() => sweepStaleJobs(15_000).catch(() => {}), 20_000);
  timer.unref?.();
} catch (err) {
  logger.error({ err: String(err) }, 'Không khởi động được server');
  process.exit(1);
}
