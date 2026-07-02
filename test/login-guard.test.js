// Chống brute-force đăng nhập admin: khoá per-IP + khoá TOÀN CỤC (chống xoay IP). PGlite.
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ready } = await import('../src/db/db.js');
const guard = await import('../src/auth/loginGuard.js');
await ready();

test('per-IP: khoá sau 5 lần sai từ CÙNG IP', async () => {
  await guard.clearAll();
  let st;
  for (let i = 0; i < 5; i++) st = await guard.recordFail('1.1.1.1');
  assert.equal(st.ipLocked, true);
  assert.equal((await guard.loginStatus('1.1.1.1')).locked, true);
  assert.equal((await guard.loginStatus('2.2.2.2')).locked, false);
});

test('toàn cục: khoá sau 20 lần sai DÙ XOAY IP mỗi lần', async () => {
  await guard.clearAll();
  let st;
  for (let i = 0; i < 20; i++) st = await guard.recordFail('10.0.0.' + i);
  assert.equal(st.globalLocked, true);
  // IP hoàn toàn mới vẫn bị chặn vì đang khoá toàn cục
  assert.equal((await guard.loginStatus('123.45.67.89')).locked, true);
});

test('clearAll mở khoá tất cả', async () => {
  await guard.clearAll();
  for (let i = 0; i < 20; i++) await guard.recordFail('10.9.0.' + i);
  const cleared = await guard.clearAll();
  assert.ok(cleared >= 1);
  assert.equal((await guard.loginStatus('123.45.67.89')).locked, false);
});
