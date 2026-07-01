import Fastify from 'fastify';
import { config, isArtlistConfigured } from './config.js';
import { logger } from './lib/logger.js';
import { session } from './session/session.js';
import videoRoutes from './routes/videos.js';

const app = Fastify({ loggerInstance: logger });

// ─── Bảo vệ API CỦA BẠN bằng X-API-Key (trừ /health) ───
app.addHook('onRequest', async (request, reply) => {
  if (request.url === '/health') return;
  const key = request.headers['x-api-key'];
  if (key !== config.API_KEY) {
    return reply.code(401).send({ error: 'Thiếu hoặc sai X-API-Key' });
  }
});

// ─── Healthcheck: trạng thái server + session ───
app.get('/health', async () => ({
  status: 'ok',
  artlistConfigured: isArtlistConfigured(),
  sessionValid: session.valid,
}));

await app.register(videoRoutes);

try {
  await app.listen({ port: config.PORT, host: '0.0.0.0' });
  logger.info(
    { port: config.PORT, artlistConfigured: isArtlistConfigured() },
    '🚀 Artlist API server đang chạy',
  );
  if (!isArtlistConfigured()) {
    logger.warn('⚠️ Chưa cấu hình artlist — /api/videos sẽ trả 503 tới khi điền .env (xem docs/CAPTURE_GUIDE.md)');
  }
} catch (err) {
  logger.error({ err: String(err) }, 'Không khởi động được server');
  process.exit(1);
}
