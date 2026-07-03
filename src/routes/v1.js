import { z } from 'zod';
import { clientAuth } from '../auth/clientAuth.js';
import * as catalog from '../artlist/catalog.js';
import * as service from '../videos/service.js';
import * as music from '../music/service.js';
import * as suno from '../suno/client.js';
import * as artlist from '../artlist/client.js';
import { Jobs, MusicJobs, Credits } from '../db/repos.js';
import { session } from '../session/session.js';
import { logEvent } from '../lib/events.js';

const createSchema = z
  .object({
    model: z.string().min(1).optional(), // tên/slug model (vd "Seedance 2.0" | "seedance-2.0") — thay cho số
    modelGroupId: z.number().int().positive().optional(),
    prompt: z.string().min(1).optional(),
    settings: z.record(z.any()).optional(),
    chatSessionId: z.string().min(1).optional(), // bỏ trống => tự tạo / dùng session mặc định của client
    image: z.string().url().optional(), // 1 ảnh (image_url)
    images: z.array(z.string().url()).max(9).optional(), // nhiều ảnh (image_urls, tối đa 9)
    videos: z.array(z.string().url()).optional(), // video đầu vào (video_urls)
    audios: z.array(z.string().url()).optional(), // audio đầu vào (audio_urls)
    endFrame: z.string().url().optional(), // khung cuối (end_frame)
    feature: z.string().optional(),
    duration: z.number().int().positive().optional(),
    resolution: z.string().optional(),
    aspectRatio: z.string().optional(),
    generateAudio: z.boolean().optional(),
    expectedCredits: z.number().int().optional(),
    maxCredits: z.number().int().positive().optional(),
  })
  .refine((d) => d.prompt || d.settings?.prompt, { message: 'Cần prompt (trực tiếp hoặc trong settings)' });

// Tạo nhạc Suno (qua AI33). mode=simple cần prompt; mode=custom cần lyrics hoặc tags.
const musicSchema = z
  .object({
    mode: z.enum(['simple', 'custom']).default('simple'),
    prompt: z.string().min(1).max(500).optional(), // simple: mô tả ngắn bài hát
    instrumental: z.boolean().optional(), // simple: chỉ nhạc, không lời
    title: z.string().max(80).optional(), // custom: tiêu đề
    lyrics: z.string().max(5000).optional(), // custom: lời bài hát
    tags: z.string().max(1000).optional(), // custom: phong cách (vd "indie pop, cinematic")
    vocalGender: z.enum(['f', 'm']).optional(), // custom: giọng nữ/nam
    maxCredits: z.number().int().positive().optional(),
    expectedCredits: z.number().int().optional(),
  })
  .refine((d) => (d.mode === 'custom' ? Boolean(d.lyrics || d.tags) : Boolean(d.prompt)), {
    message: 'simple cần prompt; custom cần lyrics hoặc tags',
  });

/** Client API — bảo vệ bằng X-API-Key. */
export default async function v1Routes(app) {
  app.addHook('preHandler', clientAuth);

  app.get('/v1/me', async (req) => ({
    clientId: req.client.id,
    name: req.client.name,
    credits: await Credits.balance(req.client.id),
    hasDefaultSession: Boolean(req.client.default_chat_session_id),
    rateLimit: { perMinute: req.client.rate_per_min, perDay: req.client.rate_per_day },
  }));

  app.get('/v1/models', async (req, reply) => {
    if (!session.isReady()) return reply.code(503).send({ error: 'Dịch vụ chưa sẵn sàng (session nguồn).' });
    return { models: await catalog.listVideoModels() };
  });

  // Nhận cả SỐ (358) lẫn TÊN/slug ("seedance-2.0", "Seedance 2.0").
  app.get('/v1/models/:id', async (req, reply) => {
    const id = await catalog.resolveModelId(req.params.id);
    if (!id) return reply.code(404).send({ error: 'Không tìm thấy model video' });
    const [models, params] = await Promise.all([catalog.listVideoModels(), catalog.getModelParams(id)]);
    return { ...models.find((m) => m.modelGroupId === id), params: params.params };
  });

  // Báo giá (free, không tạo video) — để client hiện giá trước khi tạo.
  app.get('/v1/quote', async (req, reply) => {
    if (!session.isReady()) return reply.code(503).send({ error: 'Dịch vụ chưa sẵn sàng.' });
    const q = req.query || {};
    let modelGroupId = 358;
    if (q.model) { modelGroupId = await catalog.resolveModelId(q.model); if (!modelGroupId) return reply.code(400).send({ error: 'model không tồn tại', code: 'INVALID_MODEL' }); }
    else if (q.modelGroupId) modelGroupId = Number(q.modelGroupId);
    try {
      const quote = await artlist.getCostQuote({
        modelGroupId, prompt: 'estimate',
        resolution: q.resolution, duration: q.duration != null ? Number(q.duration) : undefined,
        aspectRatio: q.aspectRatio, generateAudio: q.generateAudio != null ? q.generateAudio === 'true' : undefined,
      });
      return { modelGroupId, credits: quote.price };
    } catch {
      return reply.code(400).send({ error: 'Không báo giá được cho tham số này', code: 'QUOTE_FAILED' });
    }
  });

  app.post('/v1/videos', async (req, reply) => {
    // Ghi lại body request để soi client/relay gửi đúng format chưa (debug tích hợp).
    logEvent({ level: 'debug', category: 'client_req', event: 'create_body', clientId: req.client?.id, ip: req.realIp ?? req.ip, meta: { body: req.body } }).catch(() => {});
    if (!session.isReady()) return reply.code(503).send({ error: 'Dịch vụ chưa sẵn sàng (session nguồn).' });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: parsed.error.issues });
    // Chọn model theo TÊN (khuyến nghị) hoặc SỐ; mặc định Seedance 2.0 (358).
    let modelGroupId = 358;
    if (parsed.data.model != null) {
      modelGroupId = await catalog.resolveModelId(parsed.data.model);
      if (!modelGroupId) return reply.code(400).send({ error: `Không tìm thấy model '${parsed.data.model}' (xem GET /v1/models).`, code: 'INVALID_MODEL' });
    } else if (parsed.data.modelGroupId != null) {
      modelGroupId = parsed.data.modelGroupId;
    }
    try {
      const job = await service.createVideo(req.client, { ...parsed.data, modelGroupId }, req.realIp ?? req.ip);
      return reply.code(202).send(service.publicJob(job));
    } catch (e) {
      req.log.warn({ code: e.code, err: String(e.message) }, 'createVideo lỗi');
      return reply.code(mapError(e.code)).send({ error: e.message, code: e.code ?? 'ERROR' });
    }
  });

  // Poll on-demand: mỗi lần hỏi sẽ đẩy trạng thái từ artlist (serverless-friendly).
  app.get('/v1/videos/:id', async (req, reply) => {
    let job = await Jobs.get(req.params.id);
    if (!job || job.client_id !== req.client.id) return reply.code(404).send({ error: 'Không tìm thấy job' });
    if (['pending', 'processing'].includes(job.status)) job = await service.advanceJob(job);
    return service.publicJob(job); // job done: video_url đã là link CloudFront ký sẵn (hạn ~10 năm)
  });

  app.get('/v1/videos', async (req) => (await Jobs.listByClient(req.client.id, 100)).map(service.publicJob));

  // ─────────────────────────── Nhạc (Suno qua AI33) ───────────────────────────
  // Giá cố định theo credits (GET /v1/music/price). Luồng: POST /v1/music → poll GET /v1/music/{id}.
  app.get('/v1/music/price', async (req, reply) => {
    if (!suno.isEnabled()) return reply.code(503).send({ error: 'Tính năng tạo nhạc chưa được bật.' });
    return { credits: music.musicPrice() };
  });

  app.post('/v1/music', async (req, reply) => {
    logEvent({ level: 'debug', category: 'client_req', event: 'music_body', clientId: req.client?.id, ip: req.realIp ?? req.ip, meta: { body: req.body } }).catch(() => {});
    if (!suno.isEnabled()) return reply.code(503).send({ error: 'Tính năng tạo nhạc chưa được bật.' });
    const parsed = musicSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: parsed.error.issues });
    try {
      const job = await music.createMusic(req.client, parsed.data, req.realIp ?? req.ip);
      return reply.code(202).send(music.publicMusicJob(job));
    } catch (e) {
      req.log.warn({ code: e.code, err: String(e.message) }, 'createMusic lỗi');
      return reply.code(mapError(e.code)).send({ error: e.message, code: e.code ?? 'ERROR' });
    }
  });

  // Poll on-demand: mỗi lần hỏi sẽ đẩy trạng thái từ AI33 (serverless-friendly).
  app.get('/v1/music/:id', async (req, reply) => {
    let job = await MusicJobs.get(req.params.id);
    if (!job || job.client_id !== req.client.id) return reply.code(404).send({ error: 'Không tìm thấy job' });
    if (['pending', 'processing'].includes(job.status)) job = await music.advanceMusicJob(job);
    return music.publicMusicJob(job);
  });

  app.get('/v1/music', async (req) => (await MusicJobs.listByClient(req.client.id, 100)).map(music.publicMusicJob));
}

function mapError(code) {
  switch (code) {
    case 'INVALID_MODEL':
    case 'NO_SESSION':
    case 'PRICE_MISMATCH':
    case 'PRICE_TOO_HIGH':
    case 'QUOTE_FAILED':
      return 400;
    case 'INSUFFICIENT_CREDITS':
      return 402;
    case 'RATE_LIMITED':
      return 429;
    case 'SESSION_EXPIRED':
    case 'MUSIC_DISABLED':
      return 503;
    default:
      return 500;
  }
}
