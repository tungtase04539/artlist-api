import { config } from '../config.js';
import { sweepStaleJobs } from '../videos/service.js';

/** Endpoint cho Vercel Cron: đẩy các job đang chạy + hoàn credits job treo. */
export default async function systemRoutes(app) {
  app.all('/cron/sweep', async (req, reply) => {
    if (config.CRON_SECRET && req.headers.authorization !== `Bearer ${config.CRON_SECRET}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const swept = await sweepStaleJobs(Number(req.query?.olderThanMs) || 15000);
    return { swept };
  });
}
