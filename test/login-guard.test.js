// Chống brute-force đăng nhập admin: khoá IP sau N lần sai (PGlite in-memory).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ready } = await import('../src/db/db.js');
const guard = await import('../src/auth/loginGuard.js');
await ready();

test('khoá IP sau 5 lần sai liên tiếp', async () => {
  const ip = '1.2.3.4';
  let st;
  for (let i = 0; i < 5; i++) st = await guard.recordFail(ip);
  assert.equal(st.fails, 5);
  const s = await guard.loginStatus(ip);
  assert.equal(s.locked, true);
  assert.ok(s.retryAfterSec > 0);
});

test('IP khác không bị ảnh hưởng', async () => {
  const s = await guard.loginStatus('9.9.9.9');
  assert.equal(s.locked, false);
});

test('recordSuccess xoá đếm sai', async () => {
  const ip = '5.6.7.8';
  for (let i = 0; i < 5; i++) await guard.recordFail(ip);
  await guard.recordSuccess(ip);
  const s = await guard.loginStatus(ip);
  assert.equal(s.locked, false);
  assert.equal(s.fails, 0);
});
