import { config } from '../config.js';
import { sweepStaleJobs, checkSessionHealth } from '../videos/service.js';

/** Vercel Cron: đẩy job đang chạy + hoàn credits job treo + health-check session artlist. */
export default async function systemRoutes(app) {
  app.all('/cron/sweep', async (req, reply) => {
    if (config.CRON_SECRET && req.headers.authorization !== `Bearer ${config.CRON_SECRET}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const [swept, health] = await Promise.all([
      sweepStaleJobs(Number(req.query?.olderThanMs) || 15000),
      checkSessionHealth(),
    ]);
    return { swept, session: health };
  });
}
