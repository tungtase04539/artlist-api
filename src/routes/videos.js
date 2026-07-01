import { z } from 'zod';
import { createJob } from '../jobs/manager.js';
import { jobStore } from '../jobs/store.js';
import { isArtlistConfigured } from '../config.js';

const generateSchema = z.object({
  prompt: z.string().min(1),
  image: z.string().url().optional(),
  modelId: z.number().int().positive().optional(),
  duration: z.number().int().positive().optional(),
  aspectRatio: z.string().optional(),
  resolution: z.string().optional(),
  generateAudio: z.boolean().optional(),
});

/**
 * Đăng ký route tạo/tra cứu video. Fastify plugin.
 * @param {import('fastify').FastifyInstance} app
 */
export default async function videoRoutes(app) {
  // POST /api/videos — tạo video (async, trả jobId)
  app.post('/api/videos', async (request, reply) => {
    if (!isArtlistConfigured()) {
      return reply.code(503).send({
        error: 'Chưa cấu hình artlist (ARTLIST_BASE_URL + cookie/token). Xem docs/CAPTURE_GUIDE.md.',
      });
    }

    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Tham số không hợp lệ', issues: parsed.error.issues });
    }

    try {
      const job = await createJob(parsed.data);
      return reply.code(202).send(publicJob(job));
    } catch (err) {
      if (err.code === 'TOO_MANY_JOBS') return reply.code(429).send({ error: err.message });
      request.log.error({ err: String(err) }, 'tạo job lỗi');
      return reply.code(500).send({ error: 'Không tạo được job' });
    }
  });

  // GET /api/videos/:id — trạng thái
  app.get('/api/videos/:id', async (request, reply) => {
    const job = jobStore.get(request.params.id);
    if (!job) return reply.code(404).send({ error: 'Không tìm thấy job' });
    return reply.send(publicJob(job));
  });

  // GET /api/videos — liệt kê
  app.get('/api/videos', async () => jobStore.list().map(publicJob));
}

/** Chỉ trả field an toàn ra ngoài (ẩn providerJobId nội bộ nếu muốn). */
function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
