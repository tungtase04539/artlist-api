import { z } from 'zod';
import { adminAuth } from '../auth/adminAuth.js';
import { config } from '../config.js';
import { session } from '../session/session.js';
import { Clients, ApiKeys, Credits, Jobs, MusicJobs, Usage, Alerts, Events } from '../db/repos.js';
import { sweepStaleJobs, checkSessionHealth } from '../videos/service.js';
import * as suno from '../suno/client.js';
import { pushAlert } from '../lib/notify.js';
import * as catalog from '../artlist/catalog.js';
import { signSession, safeEqualStr } from '../lib/token.js';
import { loginStatus, recordFail, recordSuccess, clearAll } from '../auth/loginGuard.js';
import { realIp } from '../lib/ip.js';
import { logEvent } from '../lib/events.js';

const clientSchema = z.object({
  name: z.string().min(1),
  credits: z.number().int().min(0).default(0),
  ratePerMin: z.number().int().positive().optional(),
  ratePerDay: z.number().int().positive().optional(),
  notes: z.string().optional(),
  defaultChatSessionId: z.string().optional(),
});

/** Admin API — bảo vệ bằng ADMIN_TOKEN (hoặc session token sau khi đăng nhập). */
export default async function adminRoutes(app) {
  app.addHook('preHandler', adminAuth);

  // Đăng nhập bằng tài khoản/mật khẩu → cấp session token (12h). Miễn adminAuth (xem adminAuth.js).
  const SESSION_TTL_MS = 12 * 3600 * 1000;
  app.post('/admin/login', async (req, reply) => {
    const ip = realIp(req);
    const s = z.object({ username: z.string().min(1), password: z.string().min(1) }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần username, password' });
    if (!config.ADMIN_USERNAME || !config.ADMIN_PASSWORD) {
      return reply.code(503).send({ error: 'Chưa bật đăng nhập (đặt ADMIN_USERNAME & ADMIN_PASSWORD).' });
    }
    // Chống brute-force: IP bị khoá thì chặn ngay.
    const lock = await loginStatus(ip);
    if (lock.locked) {
      reply.header('retry-after', lock.retryAfterSec);
      return reply.code(429).send({ error: `Sai quá nhiều lần — thử lại sau ${Math.ceil(lock.retryAfterSec / 60)} phút.` });
    }
    const ok = safeEqualStr(s.data.username, config.ADMIN_USERNAME) & safeEqualStr(s.data.password, config.ADMIN_PASSWORD);
    if (!ok) {
      const st = await recordFail(ip);
      logEvent({ level: 'warn', category: 'abuse', event: 'login_fail', ip, meta: { ipFails: st.ipFails, globalFails: st.globalFails, locked: st.locked } }).catch(() => {});
      if (st.locked) {
        pushAlert({ severity: 'critical', kind: 'login_bruteforce', message: `Khoá đăng nhập admin (IP ${ip}, tổng sai ${st.globalFails})`, meta: { ip, globalFails: st.globalFails } }).catch(() => {});
        reply.header('retry-after', config.LOGIN_LOCK_MIN * 60);
        return reply.code(429).send({ error: `Sai quá nhiều lần — tạm khoá ${config.LOGIN_LOCK_MIN} phút.` });
      }
      const remaining = Math.max(0, config.LOGIN_MAX_FAILS - st.ipFails);
      return reply.code(401).send({ error: `Sai tài khoản hoặc mật khẩu.${remaining > 0 ? ` Còn ${remaining} lần từ IP này.` : ''}` });
    }
    await recordSuccess(ip);
    return { token: signSession({ u: s.data.username }, config.ADMIN_TOKEN, SESSION_TTL_MS), expiresInSec: SESSION_TTL_MS / 1000 };
  });

  // Mở khoá đăng nhập (khi bị brute-force lock nhầm) — cần ADMIN_TOKEN/session.
  app.post('/admin/login/unlock', async () => ({ cleared: await clearAll() }));

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

  // Bật/tắt bỏ qua trần giá client gửi (maxCredits/expectedCredits) — cho tích hợp relay/NewAPI.
  app.post('/admin/clients/:id/pricing', async (req, reply) => {
    const s = z.object({ ignoreCaps: z.boolean() }).safeParse(req.body);
    if (!s.success) return reply.code(400).send({ error: 'Cần ignoreCaps (true|false)' });
    if (!(await Clients.get(req.params.id))) return reply.code(404).send({ error: 'Không tìm thấy client' });
    return { client: await Clients.setIgnorePriceCaps(req.params.id, s.data.ignoreCaps) };
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

  // ── Event log (đọc lại để soi bất thường) ──
  // Lọc: ?level=error&category=http|artlist|job|credit|session|abuse|error&clientId=&event=&since=&until=&statusMin=&limit=
  app.get('/admin/logs', async (req) => ({
    events: await Events.list({
      level: req.query?.level, category: req.query?.category, clientId: req.query?.clientId, event: req.query?.event,
      since: req.query?.since, until: req.query?.until, statusMin: req.query?.statusMin, limit: req.query?.limit,
    }),
  }));
  // Tổng hợp bất thường trong N giờ gần nhất (mặc định 1h): đếm theo level/category, HTTP status,
  // lỗi upstream artlist, danh sách lỗi gần đây, request chậm nhất.
  app.get('/admin/logs/summary', async (req) => Events.summary(Math.max(1, Number(req.query?.hours) || 1) * 3_600_000));

  // ── Billing (dễ tính tiền: khách dùng model gì, bao nhiêu video, hết bao nhiêu credits) ──
  // ?since=&until= (ms). Mặc định 30 ngày gần nhất.
  const period = (q) => {
    const until = Number(q?.until) || Date.now();
    const since = Number(q?.since) || until - 30 * 86_400_000;
    return { since, until };
  };
  async function modelNames() {
    try { return new Map((await catalog.listVideoModels()).map((m) => [m.modelGroupId, m.slug || m.name])); }
    catch { return new Map(); }
  }

  // Tổng hợp mọi client — bảng hoá đơn nhanh (video + nhạc).
  app.get('/admin/billing', async (req) => {
    const { since, until } = period(req.query);
    const [rows, mrows, clients] = await Promise.all([Jobs.billingAll(since, until), MusicJobs.billingAll(since, until), Clients.list()]);
    const byId = new Map(rows.map((r) => [r.client_id, r]));
    const mById = new Map(mrows.map((r) => [r.client_id, r]));
    return {
      period: { since, until },
      clients: clients.map((c) => {
        const r = byId.get(c.id) || {};
        const m = mById.get(c.id) || {};
        return {
          clientId: c.id, name: c.name, status: c.status, balance: c.credits,
          videosDone: r.videos_done || 0, videosFailed: r.videos_failed || 0,
          songsDone: m.songs_done || 0, songsFailed: m.songs_failed || 0,
          creditsUsed: (r.credits_used || 0) + (m.credits_used || 0),
        };
      }),
      totals: {
        creditsUsed: rows.reduce((s, r) => s + (r.credits_used || 0), 0) + mrows.reduce((s, r) => s + (r.credits_used || 0), 0),
        videosDone: rows.reduce((s, r) => s + (r.videos_done || 0), 0),
        songsDone: mrows.reduce((s, r) => s + (r.songs_done || 0), 0),
      },
    };
  });

  // Số dư credits còn lại ở NGUỒN AI33 (theo dõi vốn nhập). Cần bật AI33_API_KEY.
  app.get('/admin/music/credits', async (req, reply) => {
    if (!suno.isEnabled()) return reply.code(503).send({ error: 'Chưa bật AI33_API_KEY' });
    try { return { provider: 'ai33', credits: await suno.providerCredits() }; }
    catch (e) { return reply.code(502).send({ error: 'Không lấy được số dư nguồn', detail: String(e.message || e) }); }
  });

  // Chi tiết 1 client: tổng + phân tích theo model + job gần đây.
  app.get('/admin/clients/:id/billing', async (req, reply) => {
    const c = await Clients.get(req.params.id);
    if (!c) return reply.code(404).send({ error: 'Không tìm thấy client' });
    const { since, until } = period(req.query);
    const [jobs, names, musicJobs] = await Promise.all([Jobs.forBilling(c.id, since, until), modelNames(), MusicJobs.listByClient(c.id, 200)]);
    const midOf = (j) => { try { return JSON.parse(j.params_json || '{}').modelGroupId ?? null; } catch { return null; } };
    const byModel = new Map();
    let videosDone = 0, creditsUsed = 0, videosFailed = 0, creditsRefunded = 0;
    for (const j of jobs) {
      const mid = midOf(j);
      if (j.status === 'done') {
        videosDone++; creditsUsed += j.price;
        const k = mid ?? 'unknown';
        const e = byModel.get(k) || { modelGroupId: mid, model: names.get(mid) || String(mid), count: 0, credits: 0 };
        e.count++; e.credits += j.price; byModel.set(k, e);
      } else if (j.status === 'failed') { videosFailed++; if (j.refunded) creditsRefunded += j.price; }
    }
    // Nhạc: gộp trong cùng khoảng.
    const mInRange = musicJobs.filter((j) => Number(j.created_at) >= since && Number(j.created_at) <= until);
    let songsDone = 0, musicCreditsUsed = 0, songsFailed = 0;
    for (const j of mInRange) {
      if (j.status === 'done') { songsDone++; musicCreditsUsed += j.price; }
      else if (j.status === 'failed') songsFailed++;
    }
    return {
      clientId: c.id, name: c.name, balance: c.credits, ignorePriceCaps: !!c.ignore_price_caps,
      period: { since, until },
      summary: { videosDone, creditsUsed, videosFailed, creditsRefunded, songsDone, musicCreditsUsed, songsFailed, totalCredits: creditsUsed + musicCreditsUsed },
      byModel: [...byModel.values()].sort((a, b) => b.credits - a.credits),
      recentJobs: jobs.slice(0, 50).map((j) => ({ jobId: j.id, status: j.status, credits: j.price, model: names.get(midOf(j)) || '', createdAt: Number(j.created_at) })),
      recentMusic: mInRange.slice(0, 50).map((j) => ({ jobId: j.id, status: j.status, credits: j.price, mode: j.mode, title: j.title || '', createdAt: Number(j.created_at) })),
    };
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
