// Test repos DB (client/key/credits) trên SQLite in-memory. Không gọi mạng.
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';
process.env.DB_PATH = ':memory:';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { Clients, ApiKeys, Credits } = await import('../src/db/repos.js');

test('client + api key: tạo, tra cứu, key sai', () => {
  const c = Clients.create({ name: 'Acme', credits: 5000, ratePerMin: 5, ratePerDay: 100 });
  assert.ok(c.id);
  assert.equal(c.status, 'active');

  const { raw } = ApiKeys.create(c.id);
  assert.ok(raw.startsWith('alk_'));

  const rec = ApiKeys.resolve(raw);
  assert.equal(rec.client_id, c.id);
  assert.equal(rec.client_status, 'active');
  assert.equal(ApiKeys.resolve('alk_saikey'), null);
});

test('credits: reserve / thiếu / refund nguyên tử', () => {
  const c = Clients.create({ name: 'B', credits: 1000, ratePerMin: 5, ratePerDay: 100 });
  assert.equal(Credits.balance(c.id), 1000);

  const r1 = Credits.change(c.id, -800, 'usage');
  assert.equal(r1.ok, true);
  assert.equal(r1.balance, 200);

  const r2 = Credits.change(c.id, -800, 'usage'); // không đủ -> chặn
  assert.equal(r2.ok, false);
  assert.equal(r2.balance, 200);

  const r3 = Credits.change(c.id, 800, 'refund'); // hoàn
  assert.equal(r3.ok, true);
  assert.equal(r3.balance, 1000);
});

test('suspend client', () => {
  const c = Clients.create({ name: 'C', credits: 0, ratePerMin: 5, ratePerDay: 100 });
  const { raw } = ApiKeys.create(c.id);
  Clients.setStatus(c.id, 'suspended');
  assert.equal(ApiKeys.resolve(raw).client_status, 'suspended');
});
