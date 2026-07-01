// Test repos DB (client/key/credits) trên PGlite in-memory (không DATABASE_URL). Không gọi mạng.
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
delete process.env.DATABASE_URL;

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Clients, ApiKeys, Credits } = await import('../src/db/repos.js');

test('client + api key: tạo, tra cứu, key sai', async () => {
  const c = await Clients.create({ name: 'Acme', credits: 5000, ratePerMin: 5, ratePerDay: 100 });
  assert.ok(c.id);
  assert.equal(c.status, 'active');

  const { raw } = await ApiKeys.create(c.id);
  assert.ok(raw.startsWith('alk_'));

  const rec = await ApiKeys.resolve(raw);
  assert.equal(rec.client_id, c.id);
  assert.equal(rec.client_status, 'active');
  assert.equal(await ApiKeys.resolve('alk_saikey'), null);
});

test('credits: reserve / thiếu / refund nguyên tử', async () => {
  const c = await Clients.create({ name: 'B', credits: 1000, ratePerMin: 5, ratePerDay: 100 });
  assert.equal(await Credits.balance(c.id), 1000);

  const r1 = await Credits.change(c.id, -800, 'usage');
  assert.equal(r1.ok, true);
  assert.equal(r1.balance, 200);

  const r2 = await Credits.change(c.id, -800, 'usage'); // không đủ -> chặn, không âm
  assert.equal(r2.ok, false);
  assert.equal(r2.balance, 200);

  const r3 = await Credits.change(c.id, 800, 'refund');
  assert.equal(r3.ok, true);
  assert.equal(r3.balance, 1000);
});

test('suspend client + default session', async () => {
  const c = await Clients.create({ name: 'C', credits: 0, ratePerMin: 5, ratePerDay: 100 });
  const { raw } = await ApiKeys.create(c.id);
  await Clients.setStatus(c.id, 'suspended');
  assert.equal((await ApiKeys.resolve(raw)).client_status, 'suspended');

  const c2 = await Clients.setDefaultSession(c.id, 'sess-123');
  assert.equal(c2.default_chat_session_id, 'sess-123');
});
