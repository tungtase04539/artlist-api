// Chạy: npm test   (dùng node:test có sẵn, không cần cài thêm)
// Test logic build-request & parse-response bằng DỮ LIỆU THẬT đã bắt được.
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Cấu hình tối thiểu để import config/endpoints (không gọi mạng).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
process.env.ARTLIST_BASE_URL = 'https://toolkit.artlist.io';

const ep = await import('../src/artlist/endpoints.js');
const { uuidv7 } = await import('../src/lib/uuid.js');

// ── Response STATUS THẬT (lúc processing) mà bạn đã gửi ──
const REAL_PROCESSING = {
  result: { data: { json: [ {
    id: '019f1c65-5aa5-7c43-9cc3-6f065621505b',
    type: 'video',
    status: 'processing',
    chatSessionId: '019f1c65-5730-7488-8538-2f352102c92a',
    prompt: 'zxqw a red panda skateboarding',
    modelId: 2524,
    settings: { prompt: 'zxqw a red panda skateboarding', duration: 4, resolution: '720p', aspect_ratio: '16:9', generate_audio: true },
    feature: 'text-to-video',
    price: 1200,
  } ] } },
};

test('normalizeStatus: parse response THẬT lúc processing', () => {
  const s = ep.normalizeStatus(REAL_PROCESSING);
  assert.equal(s.providerJobId, '019f1c65-5aa5-7c43-9cc3-6f065621505b');
  assert.equal(s.status, 'processing');
  assert.equal(s.videoUrl, undefined); // chưa xong nên chưa có URL — đúng
});

test('normalizeStatus: video done với fileUrl trực tiếp', () => {
  const done = { result: { data: { json: [ { id: 'x', status: 'completed', fileUrl: 'https://cdn/x.mp4' } ] } } };
  const s = ep.normalizeStatus(done);
  assert.equal(s.status, 'done');
  assert.equal(s.videoUrl, 'https://cdn/x.mp4');
});

test('normalizeStatus: video done với outputs[].fileUrl', () => {
  const done = { result: { data: { json: { id: 'y', status: 'ready', outputs: [ { fileKey: 'k', fileUrl: 'https://cdn/y.mp4' } ] } } } };
  const s = ep.normalizeStatus(done);
  assert.equal(s.status, 'done');
  assert.equal(s.videoUrl, 'https://cdn/y.mp4');
});

test('normalizeStatus: create trả {success,data:{id}} → lấy được id', () => {
  const createRes = { result: { data: { json: { success: true, data: { id: '019f1cb6-f362-7f2d-8416-6d3cc3295dda' } } } } };
  const s = ep.normalizeStatus(createRes);
  assert.equal(s.providerJobId, '019f1cb6-f362-7f2d-8416-6d3cc3295dda');
});

test('normalizeStatus: response done THẬT (video đã tạo) → done + videoUrl + thumbnail', () => {
  const realDone = { result: { data: { json: [ {
    id: '019f1cb6-f362-7f2d-8416-6d3cc3295dda',
    status: 'completed',
    fileKey: 'file-key-placeholder',
    thumbnailUrl: 'https://cms-toolkit-public-artifacts.artlist.io/thumb.jpg',
    videoUrl: 'https://cms-toolkit-artifacts.artlist.io/video.mp4?Expires=2098253334&Signature=abc',
    modelId: 2524, feature: 'text-to-video',
  } ] } } };
  const s = ep.normalizeStatus(realDone);
  assert.equal(s.status, 'done');
  assert.equal(s.providerJobId, '019f1cb6-f362-7f2d-8416-6d3cc3295dda');
  assert.ok(s.videoUrl.includes('.mp4'));
  assert.ok(s.thumbnailUrl.includes('.jpg'));
});

test('normalizeQuote: map cost/digitalSignature/timestamp (envelope {success,data})', () => {
  const raw = { result: { data: { json: { success: true, data: { cost: 1200, digitalSignature: 'JWT.aaa.bbb', timestamp: 1782887821107 } } } } };
  const q = ep.normalizeQuote(raw);
  assert.equal(q.price, 1200);
  assert.equal(q.costQuoteDigitalSignature, 'JWT.aaa.bbb');
  assert.equal(q.timestamp, 1782887821107);
});

test('quoteRequest: đúng endpoint & input shape (modelGroupId 358, server tự resolve modelId)', () => {
  const r = ep.quoteRequest({ prompt: 'p', duration: 4, resolution: '720p', aspectRatio: '16:9', generateAudio: true, modelGroupId: 358 });
  assert.equal(r.method, 'GET');
  assert.ok(r.url.includes('/api/trpc/modelRouter.getCostQuote?input='));
  const input = JSON.parse(decodeURIComponent(r.url.split('input=')[1]));
  assert.deepEqual(input, { json: { modelGroupId: 358, input: { prompt: 'p', resolution: '720p', duration: 4, generate_audio: true, aspect_ratio: '16:9' } } });
});

test('normalizeQuote: lấy được resolvedModelId từ response', () => {
  const raw = { result: { data: { json: { success: true, data: { modelId: 2525, cost: 2400, digitalSignature: 'sig', timestamp: 1 } } } } };
  const q = ep.normalizeQuote(raw);
  assert.equal(q.resolvedModelId, 2525);
  assert.equal(q.price, 2400);
});

test('submitRequest: body khớp cấu trúc request THẬT', () => {
  const r = ep.submitRequest({ prompt: 'p', duration: 4, resolution: '720p', aspectRatio: '16:9', generateAudio: true,
    modelId: 2524, chatSessionId: 'cs', price: 1200, timestamp: 111, costQuoteDigitalSignature: 'sig' });
  assert.equal(r.method, 'POST');
  assert.ok(r.url.endsWith('/api/trpc/userGenerationRouter.createUserGeneration'));
  const j = r.body.json;
  assert.deepEqual(Object.keys(j).sort(), [
    'artifacts','chatSessionId','costQuoteDigitalSignature','feature','generationMethod',
    'inputs','isCopyCmsFileEnabled','modelGroupId','price','settings','timestamp',
  ].sort());
  assert.equal(j.feature, 'text-to-video');
  assert.equal(j.modelGroupId, 2524);
  assert.deepEqual(j.inputs, { prompt: 'p' });
  assert.equal(j.costQuoteDigitalSignature, 'sig');
});

test('uuidv7: đúng định dạng & version 7', () => {
  const id = uuidv7();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
