import { z } from 'zod';
import { clientAuth } from '../auth/clientAuth.js';
import * as catalog from '../artlist/catalog.js';
import * as service from '../videos/service.js';
import { Jobs, Credits } from '../db/repos.js';
import { session } from '../session/session.js';

const createSchema = z
  .object({
    modelGroupId: z.number().int().positive().default(358),
    prompt: z.string().min(1).optional(),
    settings: z.record(z.any()).optional(),
    chatSessionId: z.string().min(1),
    image: z.string().url().optional(),
    feature: z.string().optional(),
    // shorthand (nếu không dùng `settings`):
    duration: z.number().int().positive().optional(),
    resolution: z.string().optional(),
    aspectRatio: z.string().optional(),
    generateAudio: z.boolean().optional(),
    // bảo vệ giá:
    expectedCredits: z.number().int().optional(),
    maxCredits: z.number().int().positive().optional(),
  })
  .refine((d) => d.prompt || d.settings?.prompt, { message: 'Cần prompt (trực tiếp hoặc trong settings)' });

/** Client API — bảo vệ bằng X-API-Key. */
export default async function v1Routes(app) {
  app.addHook('preHandler', clientAuth);

  // Thông tin tài khoản + số dư.
  app.get('/v1/me', async (req) => ({
    clientId: req.client.id,
    name: req.client.name,
    credits: Credits.balance(req.client.id),
    rateLimit: { perMinute: req.client.rate_per_min, perDay: req.client.rate_per_day },
  }));

  // Danh sách model video + thông số.
  app.get('/v1/models', async (req, reply) => {
    if (!session.isReady()) return reply.code(503).send({ error: 'Dịch vụ chưa sẵn sàng (session nguồn).' });
    return { models: await catalog.listVideoModels() };
  });

  app.get('/v1/models/:id', async (req, reply) => {
    const id = Number(req.params.id);
    if (!(await catalog.isVideoModel(id))) return reply.code(404).send({ error: 'Không tìm thấy model video' });
    const [models, params] = await Promise.all([catalog.listVideoModels(), catalog.getModelParams(id)]);
    return { ...models.find((m) => m.modelGroupId === id), params: params.params };
  });

  // Tạo video (async).
  app.post('/v1/videos', async (req, reply) => {
    if (!session.isReady()) return reply.code(503).send({ error: 'Dịch vụ chưa sẵn sàng (session nguồn).' });
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: parsed.error.issues });
    try {
      const job = await service.createVideo(req.client, parsed.data, req.ip);
      return reply.code(202).send(service.publicJob(job));
    } catch (e) {
      req.log.warn({ code: e.code, err: String(e.message) }, 'createVideo lỗi');
      return reply.code(mapError(e.code)).send({ error: e.message, code: e.code ?? 'ERROR' });
    }
  });

  // Trạng thái job (chỉ job của chính client).
  app.get('/v1/videos/:id', async (req, reply) => {
    const job = Jobs.get(req.params.id);
    if (!job || job.client_id !== req.client.id) return reply.code(404).send({ error: 'Không tìm thấy job' });
    return service.publicJob(job);
  });

  app.get('/v1/videos', async (req) => Jobs.listByClient(req.client.id, 100).map(service.publicJob));
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
      return 503;
    default:
      return 500;
  }
}
