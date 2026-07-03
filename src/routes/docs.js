/** Phục vụ OpenAPI JSON, Swagger UI (/docs) và dashboard admin (/dashboard). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const openapi = {
  openapi: '3.0.3',
  info: {
    title: 'Artlist Video API',
    version: '1.0.0',
    description:
      'API tạo video AI (video-only). Xác thực bằng header `X-API-Key`. Luồng: POST /v1/videos → poll GET /v1/videos/{id} tới khi status=done.',
  },
  servers: [{ url: '/' }],
  components: {
    securitySchemes: { ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key' } },
  },
  security: [{ ApiKeyAuth: [] }],
  paths: {
    '/v1/me': { get: { summary: 'Thông tin tài khoản + số dư credits', responses: { 200: { description: 'OK' } } } },
    '/v1/models': { get: { summary: 'Danh sách model video + credits + features', responses: { 200: { description: 'OK' } } } },
    '/v1/models/{id}': {
      get: {
        summary: 'Chi tiết model + đầy đủ thông số (settings, options, default)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Tên/slug (vd seedance-2.0) hoặc modelGroupId (vd 358)' }],
        responses: { 200: { description: 'OK' }, 404: { description: 'Không tìm thấy' } },
      },
    },
    '/v1/videos': {
      get: { summary: 'Danh sách job của bạn', responses: { 200: { description: 'OK' } } },
      post: {
        summary: 'Tạo video (async). Trả jobId + status=processing, rồi poll GET /v1/videos/{id} tới done.',
        description:
          'Cần `prompt` (trực tiếp hoặc trong `settings.prompt`). Media đầu vào là URL công khai (http/https, không phải IP nội bộ) — server tự tải & upload. '
          + '`chatSessionId` KHÔNG bắt buộc: bỏ trống thì hệ thống tự tạo/tái dùng session. Giá tính bằng credits theo model + settings.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string', description: 'Tên/slug model (khuyến nghị), vd "seedance-2.0" | "Seedance 2.0". Bỏ trống mặc định seedance-2.0.' },
                  modelGroupId: { type: 'integer', description: 'ID số của model (thay cho `model`). 358=Seedance 2.0, 416=Seedance 2.0 Mini.' },
                  prompt: { type: 'string', description: 'Mô tả video. Có thể chèn tag ảnh @img1..@imgN. (Hoặc đặt trong settings.prompt.)' },
                  settings: {
                    type: 'object', description: 'Thông số khớp GET /v1/models/{id}.',
                    properties: {
                      resolution: { type: 'string', example: '720p' }, duration: { type: 'integer', example: 4 },
                      aspect_ratio: { type: 'string', example: '16:9' }, generate_audio: { type: 'boolean', example: true },
                    },
                  },
                  image: { type: 'string', format: 'uri', description: '1 ảnh (image-to-video).' },
                  images: { type: 'array', items: { type: 'string', format: 'uri' }, maxItems: 9, description: 'Tối đa 9 ảnh (multi-to-video).' },
                  videos: { type: 'array', items: { type: 'string', format: 'uri' }, description: 'Video đầu vào.' },
                  audios: { type: 'array', items: { type: 'string', format: 'uri' }, description: 'Audio đầu vào.' },
                  endFrame: { type: 'string', format: 'uri', description: 'Khung hình cuối.' },
                  duration: { type: 'integer', description: 'Rút gọn của settings.duration.' },
                  resolution: { type: 'string', description: 'Rút gọn của settings.resolution.' },
                  aspectRatio: { type: 'string', description: 'Rút gọn của settings.aspect_ratio.' },
                  generateAudio: { type: 'boolean', description: 'Rút gọn của settings.generate_audio.' },
                  chatSessionId: { type: 'string', description: 'Tuỳ chọn — bỏ trống để tự tạo.' },
                  maxCredits: { type: 'integer', description: 'Trần giá — từ chối nếu quote vượt.' },
                  expectedCredits: { type: 'integer', description: 'Giá dự tính — lệch giá thật sẽ bị từ chối (chống nhầm/cheat).' },
                },
              },
              examples: {
                'text-to-video': { value: { model: 'seedance-2.0', prompt: 'a red panda skateboarding, cinematic', settings: { resolution: '720p', duration: 4, aspect_ratio: '16:9', generate_audio: true }, maxCredits: 2000 } },
                'image-to-video': { value: { model: 'seedance-2.0', prompt: 'gentle zoom, cinematic', image: 'https://example.com/photo.jpg', maxCredits: 2000 } },
                'multi-to-video': { value: { model: 'seedance-2.0', prompt: 'smooth morphing sequence', images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'], maxCredits: 2000 } },
              },
            },
          },
        },
        responses: { 202: { description: 'Đã nhận (status=processing)' }, 400: { description: 'Sai tham số / MEDIA_ERROR' }, 401: { description: 'Thiếu/sai X-API-Key' }, 402: { description: 'Không đủ credits' }, 429: { description: 'Vượt rate limit' }, 503: { description: 'Nguồn tạm gián đoạn' } },
      },
    },
    '/v1/videos/{id}': {
      get: {
        summary: 'Trạng thái job (done → videoUrl)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 404: { description: 'Không tìm thấy' } },
      },
    },
    '/v1/music/price': { get: { summary: 'Giá 1 lần tạo nhạc (credits, cố định)', responses: { 200: { description: 'OK' }, 503: { description: 'Tính năng tắt' } } } },
    '/v1/music': {
      get: { summary: 'Danh sách nhạc của bạn', responses: { 200: { description: 'OK' } } },
      post: {
        summary: 'Tạo nhạc Suno (async). Trả jobId + status=processing, rồi poll GET /v1/music/{id} tới done.',
        description:
          'Hai chế độ: `mode=simple` (mô tả ngắn → bài hát) hoặc `mode=custom` (tự viết lời + phong cách). '
          + 'Mỗi lần tạo trả về ~2 phiên bản (audioUrls). Giá cố định theo credits (xem GET /v1/music/price).',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  mode: { type: 'string', enum: ['simple', 'custom'], default: 'simple', description: 'simple = mô tả ngắn; custom = tự viết lời/phong cách.' },
                  prompt: { type: 'string', maxLength: 500, description: '[simple] Mô tả bài hát.' },
                  instrumental: { type: 'boolean', description: '[simple] Chỉ nhạc, không lời.' },
                  title: { type: 'string', maxLength: 80, description: '[custom] Tiêu đề.' },
                  lyrics: { type: 'string', maxLength: 5000, description: '[custom] Lời bài hát (cần lyrics hoặc tags).' },
                  tags: { type: 'string', maxLength: 1000, description: '[custom] Phong cách, vd "indie pop, cinematic".' },
                  vocalGender: { type: 'string', enum: ['f', 'm'], description: '[custom] Giọng nữ/nam.' },
                  maxCredits: { type: 'integer', description: 'Trần giá — từ chối nếu vượt.' },
                  expectedCredits: { type: 'integer', description: 'Giá dự tính — lệch giá thật sẽ bị từ chối.' },
                },
              },
              examples: {
                simple: { value: { mode: 'simple', prompt: 'a warm indie pop song about chasing dreams at sunrise', instrumental: false } },
                custom: { value: { mode: 'custom', title: 'Sunrise Lines', lyrics: '[Verse 1]\nI walk the line between two lives', tags: 'indie pop, emotional, cinematic drums', vocalGender: 'f' } },
              },
            },
          },
        },
        responses: { 202: { description: 'Đã nhận (status=processing)' }, 400: { description: 'Sai tham số' }, 401: { description: 'Thiếu/sai X-API-Key' }, 402: { description: 'Không đủ credits' }, 429: { description: 'Vượt rate limit' }, 503: { description: 'Tính năng tắt' } },
      },
    },
    '/v1/music/{id}': {
      get: {
        summary: 'Trạng thái nhạc (done → audioUrl + audioUrls[])',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 404: { description: 'Không tìm thấy' } },
      },
    },
  },
};

export default async function docsRoutes(app) {
  app.get('/openapi.json', async () => openapi);

  app.get('/docs', async (req, reply) => {
    reply.type('text/html').send(`<!doctype html><html><head><meta charset="utf-8"><title>API Docs</title>
<link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
<script>window.onload=()=>SwaggerUIBundle({url:'/openapi.json',dom_id:'#ui'})</script></body></html>`);
  });

  app.get('/dashboard', async (req, reply) => {
    reply.type('text/html').send(readFileSync(join(__dir, '../dashboard/index.html'), 'utf8'));
  });

  // 中文使用指南（给客户）— Chinese usage guide for clients.
  app.get('/guide', async (req, reply) => {
    reply.type('text/html').send(readFileSync(join(__dir, '../dashboard/guide-zh.html'), 'utf8'));
  });

  // Client console (中文) — khách tự nhập API key, xem credits, tạo & xem video.
  app.get('/app', async (req, reply) => {
    reply.type('text/html').send(readFileSync(join(__dir, '../dashboard/client.html'), 'utf8'));
  });

  // 价格表 (中文) — bảng giá Seedance 2.0 cho khách.
  app.get('/pricing', async (req, reply) => {
    reply.type('text/html').send(readFileSync(join(__dir, '../dashboard/pricing-zh.html'), 'utf8'));
  });

  // Suno console (中文) — khách nhập API key, tạo nhạc, xem tài liệu API. Đặt ở '/' và '/suno'.
  const sunoPage = (req, reply) => reply.type('text/html').send(readFileSync(join(__dir, '../dashboard/music.html'), 'utf8'));
  app.get('/', sunoPage);
  app.get('/suno', sunoPage);
  // Tương thích link cũ '/music' → '/suno'.
  app.get('/music', async (req, reply) => reply.code(301).header('location', '/suno').send());
}
