import { config } from '../config.js';
import { sweepStaleJobs, checkSessionHealth } from '../videos/service.js';
import { Settings, Events } from '../db/repos.js';

const WARM_THROTTLE_MS = 4 * 60 * 1000; // tối đa 1 lần ping artlist thật mỗi 4 phút

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

  /**
   * Giữ session "ấm": làm mới cookie (auto-refresh qua Set-Cookie) + đẩy job treo.
   * KHÔNG cần auth (để pinger ngoài gọi dễ) nhưng CÓ throttle qua DB: dù bị gọi dồn,
   * chỉ thực sự ping artlist tối đa 1 lần / 4 phút → an toàn, không đập upstream.
   */
  app.all('/cron/warm', async () => {
    const now = Date.now();
    const last = Number(await Settings.get('last_warm_at')) || 0;
    if (now - last < WARM_THROTTLE_MS) return { ok: true, skipped: true, nextInSec: Math.ceil((WARM_THROTTLE_MS - (now - last)) / 1000) };
    await Settings.set('last_warm_at', String(now)); // đặt trước để thu hẹp cửa sổ race giữa các instance
    const [health, swept] = await Promise.all([checkSessionHealth(), sweepStaleJobs(15000)]);
    const prunedLogs = await Events.prune(config.LOG_RETENTION_DAYS * 86_400_000).catch(() => 0); // dọn log cũ
    return { ok: health.ok === true, warmed: true, swept, prunedLogs };
  });
}
