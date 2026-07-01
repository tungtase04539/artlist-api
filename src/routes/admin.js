import { z } from 'zod';
import { adminAuth } from '../auth/adminAuth.js';
import { config } from '../config.js';
import { session } from '../session/session.js';
import { Clients, ApiKeys, Credits, Jobs, Usage, Alerts } from '../db/repos.js';

const clientSchema = z.object({
  name: z.string().min(1),
  credits: z.number().int().min(0).default(0),
  ratePerMin: z.number().int().positive().optional(),
  ratePerDay: z.number().int().positive().optional(),
  notes: z.string().optional(),
});

/** Admin API — bảo vệ bằng ADMIN_TOKEN. */
export default async function adminRoutes(app) {
  app.addHook('preHandler', adminAuth);

  // ── Clients ──
  app.post('/admin/clients', async (req, reply) => {
    const p = clientSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: p.error.issues });
    const c = Clients.create({
      name: p.data.name,
      credits: p.data.credits,
      ratePerMin: p.data.ratePerMin ?? config.DEFAULT_RATE_PER_MIN,
      ratePerDay: p.data.ratePerDay ?? config.DEFAULT_RATE_PER_DAY,
      notes: p.data.notes ?? null,
    });
    const key = ApiKeys.create(c.id); // cấp sẵn 1 key
    return reply.code(201).send({ client: c, apiKey: key.raw, note: 'Lưu apiKey ngay — chỉ hiện 1 lần.' });
  });

  app.get('/admin/clients', async () => ({ clients: Clients.list() }));

  app.get('/admin/clients/:id', async (req, reply) => {
    const c = Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return {
      client: c,
      keys: ApiKeys.listByClient(c.id),
      recentJobs: Jobs.listByClient(c.id, 20),
      ledger: Credits.ledger(c.id, 20),
    };
  });

  app.post('/admin/clients/:id/status', async (req, reply) => {
    const status = req.body?.status;
    if (!['active', 'suspended'].includes(status)) return reply.code(400).send({ error: "status phải là 'active' | 'suspended'" });
    const c = Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: Clients.setStatus(c.id, status) };
  });

  app.post('/admin/clients/:id/limits', async (req, reply) => {
    const s = z.object({ ratePerMin: z.number().int().positive(), ratePerDay: z.number().int().positive() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần ratePerMin, ratePerDay' });
    const c = Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: Clients.setLimits(c.id, s.data.ratePerMin, s.data.ratePerDay) };
  });

  // ── Credits ──
  app.post('/admin/clients/:id/credits', async (req, reply) => {
    const s = z.object({ amount: z.number().int(), reason: z.string().optional() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần amount (số nguyên, + nạp / - trừ)' });
    const c = Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const r = Credits.change(c.id, s.data.amount, s.data.reason ?? (s.data.amount >= 0 ? 'topup' : 'adjust'));
    if (!r.ok) return reply.code(400).send({ error: 'Số dư không đủ để trừ', balance: r.balance });
    return { clientId: c.id, balance: r.balance };
  });

  // ── API keys ──
  app.post('/admin/clients/:id/keys', async (req, reply) => {
    const c = Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const key = ApiKeys.create(c.id);
    return reply.code(201).send({ apiKey: key.raw, record: key.record, note: 'Chỉ hiện 1 lần.' });
  });

  app.post('/admin/keys/:keyId/revoke', async (req) => {
    ApiKeys.revoke(req.params.keyId);
    return { revoked: req.params.keyId };
  });

  // ── Usage / Alerts / Stats ──
  app.get('/admin/usage', async (req) => ({ events: Usage.recent(Number(req.query?.limit) || 200) }));

  app.get('/admin/alerts', async (req) => ({ alerts: Alerts.list(Number(req.query?.limit) || 200) }));
  app.post('/admin/alerts/:id/resolve', async (req) => {
    Alerts.resolve(Number(req.params.id));
    return { resolved: Number(req.params.id) };
  });

  app.get('/admin/stats', async () => {
    const clients = Clients.list();
    return {
      clients: clients.length,
      activeClients: clients.filter((c) => c.status === 'active').length,
      creditsOutstanding: clients.reduce((s, c) => s + c.credits, 0),
      jobsProcessing: Jobs.listProcessing().length,
      unresolvedAlerts: Alerts.countUnresolved(),
      session: session.status(),
    };
  });

  // ── Session artlist (cập nhật cookie lúc chạy) ──
  app.get('/admin/session', async () => ({ session: session.status() }));
  app.post('/admin/session', async (req, reply) => {
    const s = z.object({ cookie: z.string().min(20), userAgent: z.string().optional(), csrf: z.string().optional() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần cookie (chuỗi cookie đầy đủ)' });
    session.setCredentials(s.data);
    return { ok: true, session: session.status() };
  });
}
