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
  await ready(); // khởi tạo DB + migrate

  const app = Fastify({ loggerInstance: logger, trustProxy: true });

  app.get('/health', async () => ({ status: 'ok', session: session.status() }));

  await app.register(v1Routes); // client API (X-API-Key)
  await app.register(adminRoutes); // admin API (ADMIN_TOKEN)
  await app.register(docsRoutes); // /docs, /openapi.json, /dashboard
  await app.register(systemRoutes); // /cron/sweep

  return app;
}
