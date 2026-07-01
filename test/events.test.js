// Log sự kiện: add → list (lọc) → summary → prune (dùng PGlite in-memory).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ready } = await import('../src/db/db.js');
const { Events } = await import('../src/db/repos.js');
await ready();

test('Events: add + list lọc theo level/category', async () => {
  await Events.add({ level: 'info', category: 'http', event: 'GET /v1/me', clientId: 'c1', statusCode: 200, durationMs: 12 });
  await Events.add({ level: 'error', category: 'artlist', event: 'modelRouter.getCostQuote', statusCode: 500, message: 'boom' });
  const errs = await Events.list({ level: 'error' });
  assert.ok(errs.length >= 1);
  assert.equal(errs[0].category, 'artlist');
  const http = await Events.list({ category: 'http', clientId: 'c1' });
  assert.ok(http.some((e) => e.event === 'GET /v1/me' && e.status_code === 200));
});

test('Events: summary tổng hợp theo level/category + lỗi upstream', async () => {
  const s = await Events.summary(3_600_000);
  assert.ok(Array.isArray(s.byLevel) && Array.isArray(s.byCategory));
  assert.ok(s.upstreamErrors >= 1); // đã add 1 lỗi artlist ở test trên
  assert.ok(s.recentErrors.some((e) => e.message === 'boom'));
});

test('Events: prune xoá log cũ hơn ngưỡng', async () => {
  await Events.add({ ts: Date.now() - 10 * 86_400_000, level: 'info', category: 'system', event: 'old' });
  const pruned = await Events.prune(7 * 86_400_000);
  assert.ok(pruned >= 1);
});
