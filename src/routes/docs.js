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
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' }, description: 'modelGroupId' }],
        responses: { 200: { description: 'OK' }, 404: { description: 'Không tìm thấy' } },
      },
    },
    '/v1/videos': {
      get: { summary: 'Danh sách job của bạn', responses: { 200: { description: 'OK' } } },
      post: {
        summary: 'Tạo video (async). Trả jobId, poll GET /v1/videos/{id}.',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['chatSessionId'],
                properties: {
                  modelGroupId: { type: 'integer', default: 358, description: 'ID model group (GET /v1/models). 358 = Seedance 2.0.' },
                  prompt: { type: 'string', description: 'Mô tả video (hoặc đặt trong settings.prompt).' },
                  chatSessionId: { type: 'string', description: 'Session artlist có sẵn (admin cấp cho bạn).' },
                  settings: { type: 'object', description: 'Thông số khớp GET /v1/models/{id} (vd resolution, duration, aspect_ratio, generate_audio).' },
                  image: { type: 'string', format: 'uri', description: 'URL ảnh cho image-to-video (nếu model hỗ trợ).' },
                  maxCredits: { type: 'integer', description: 'Trần giá — từ chối nếu quote vượt.' },
                  expectedCredits: { type: 'integer', description: 'Giá bạn dự tính — lệch giá thật sẽ bị từ chối (chống nhầm/cheat).' },
                },
              },
              examples: {
                seedance: {
                  value: {
                    modelGroupId: 358,
                    prompt: 'a red panda skateboarding, cinematic',
                    chatSessionId: '<session-id>',
                    settings: { resolution: '720p', duration: 4, aspect_ratio: '16:9', generate_audio: true },
                  },
                },
              },
            },
          },
        },
        responses: { 202: { description: 'Đã nhận, đang xử lý' }, 400: { description: 'Sai tham số' }, 402: { description: 'Không đủ credits' }, 429: { description: 'Vượt rate limit' } },
      },
    },
    '/v1/videos/{id}': {
      get: {
        summary: 'Trạng thái job (done → videoUrl)',
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
}
