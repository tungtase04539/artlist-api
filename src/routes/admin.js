import { z } from 'zod';
import { adminAuth } from '../auth/adminAuth.js';
import { config } from '../config.js';
import { session } from '../session/session.js';
import { Clients, ApiKeys, Credits, Jobs, Usage, Alerts } from '../db/repos.js';
import { sweepStaleJobs, checkSessionHealth } from '../videos/service.js';
import { pushAlert } from '../lib/notify.js';

const clientSchema = z.object({
  name: z.string().min(1),
  credits: z.number().int().min(0).default(0),
  ratePerMin: z.number().int().positive().optional(),
  ratePerDay: z.number().int().positive().optional(),
  notes: z.string().optional(),
  defaultChatSessionId: z.string().optional(),
});

/** Admin API — bảo vệ bằng ADMIN_TOKEN. */
export default async function adminRoutes(app) {
  app.addHook('preHandler', adminAuth);

  // ── Clients ──
  app.post('/admin/clients', async (req, reply) => {
    const p = clientSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: p.error.issues });
    const c = await Clients.create({
      name: p.data.name,
      credits: p.data.credits,
      ratePerMin: p.data.ratePerMin ?? config.DEFAULT_RATE_PER_MIN,
      ratePerDay: p.data.ratePerDay ?? config.DEFAULT_RATE_PER_DAY,
      notes: p.data.notes ?? null,
      defaultChatSessionId: p.data.defaultChatSessionId ?? null,
    });
    const key = await ApiKeys.create(c.id);
    return reply.code(201).send({ client: c, apiKey: key.raw, note: 'Lưu apiKey ngay — chỉ hiện 1 lần.' });
  });

  app.get('/admin/clients', async () => ({ clients: await Clients.list() }));

  app.get('/admin/clients/:id', async (req, reply) => {
    const c = await Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const [keys, recentJobs, ledger] = await Promise.all([
      ApiKeys.listByClient(c.id),
      Jobs.listByClient(c.id, 20),
      Credits.ledger(c.id, 20),
    ]);
    return { client: c, keys, recentJobs, ledger };
  });

  app.post('/admin/clients/:id/status', async (req, reply) => {
    const status = req.body?.status;
    if (!['active', 'suspended'].includes(status)) return reply.code(400).send({ error: "status phải là 'active' | 'suspended'" });
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: await Clients.setStatus(req.params.id, status) };
  });

  app.post('/admin/clients/:id/limits', async (req, reply) => {
    const s = z.object({ ratePerMin: z.number().int().positive(), ratePerDay: z.number().int().positive() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần ratePerMin, ratePerDay' });
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: await Clients.setLimits(req.params.id, s.data.ratePerMin, s.data.ratePerDay) };
  });

  // Gán session artlist mặc định cho client (client khỏi phải truyền chatSessionId).
  app.post('/admin/clients/:id/session', async (req, reply) => {
    const s = z.object({ chatSessionId: z.string().min(1) }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần chatSessionId' });
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: await Clients.setDefaultSession(req.params.id, s.data.chatSessionId) };
  });

  // ── Credits ──
  app.post('/admin/clients/:id/credits', async (req, reply) => {
    const s = z.object({ amount: z.number().int(), reason: z.string().optional() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần amount (số nguyên, + nạp / - trừ)' });
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const r = await Credits.change(req.params.id, s.data.amount, s.data.reason ?? (s.data.amount >= 0 ? 'topup' : 'adjust'));
    if (!r.ok) return reply.code(400).send({ error: 'Số dư không đủ để trừ', balance: r.balance });
    return { clientId: req.params.id, balance: r.balance };
  });

  // ── API keys ──
  app.post('/admin/clients/:id/keys', async (req, reply) => {
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const key = await ApiKeys.create(req.params.id);
    return reply.code(201).send({ apiKey: key.raw, record: key.record, note: 'Chỉ hiện 1 lần.' });
  });
  app.post('/admin/keys/:keyId/revoke', async (req) => {
    await ApiKeys.revoke(req.params.keyId);
    return { revoked: req.params.keyId };
  });

  // ── Usage / Alerts / Stats ──
  app.get('/admin/usage', async (req) => ({ events: await Usage.recent(Number(req.query?.limit) || 200) }));
  app.get('/admin/alerts', async (req) => ({ alerts: await Alerts.list(Number(req.query?.limit) || 200) }));
  app.post('/admin/alerts/:id/resolve', async (req) => {
    await Alerts.resolve(Number(req.params.id));
    return { resolved: Number(req.params.id) };
  });

  app.get('/admin/stats', async () => {
    const clients = await Clients.list();
    return {
      clients: clients.length,
      activeClients: clients.filter((c) => c.status === 'active').length,
      creditsOutstanding: clients.reduce((s, c) => s + c.credits, 0),
      jobsProcessing: (await Jobs.listProcessing()).length,
      unresolvedAlerts: await Alerts.countUnresolved(),
      session: session.status(),
    };
  });

  // Đẩy thủ công các job đang chạy (ngoài Cron).
  app.post('/admin/sweep', async () => ({ swept: await sweepStaleJobs(0) }));

  // Gửi thử cảnh báo (kiểm tra Telegram/webhook đã cấu hình đúng chưa).
  app.post('/admin/notify/test', async () => {
    const configured = Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) || Boolean(config.ALERT_WEBHOOK_URL);
    await pushAlert({ severity: 'info', kind: 'test', message: 'Test cảnh báo từ Artlist API — nếu bạn thấy tin này, kênh đã hoạt động ✅' });
    return { sent: true, configured, channels: { telegram: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID), webhook: Boolean(config.ALERT_WEBHOOK_URL) } };
  });

  // ── Session artlist (cập nhật cookie lúc chạy) ──
  app.get('/admin/session', async () => { await session.ensureFresh(); return { session: session.status() }; });
  app.post('/admin/session/check', async () => ({ health: await checkSessionHealth(), session: session.status() }));
  app.post('/admin/session', async (req, reply) => {
    const s = z.object({ cookie: z.string().min(20), userAgent: z.string().optional(), csrf: z.string().optional() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần cookie (chuỗi cookie đầy đủ)' });
    session.setCredentials(s.data);
    await session.persist(); // lưu DB để mọi instance serverless dùng chung
    return { ok: true, session: session.status() };
  });
}
