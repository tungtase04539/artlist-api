// Cookie session bền hoá qua DB (bắt buộc cho serverless: nhiều instance dùng chung 1 jar).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { ready } = await import('../src/db/db.js');
const { session } = await import('../src/session/session.js');
await ready();

test('persist() → loadFromStore() khôi phục cookie (mô phỏng instance serverless mới)', async () => {
  session.setCredentials({ cookie: 'cf_clearance=ABC; __cf_bm=BM; keepme=1', userAgent: 'UA-serverless' });
  await session.persist();

  // Instance mới: RAM trắng.
  session._jar = new Map();
  session._ua = null;
  session.updatedAt = null;
  session._loadedAt = 0;

  await session.loadFromStore();
  assert.match(session.cookie(), /cf_clearance=ABC/);
  assert.match(session.cookie(), /__cf_bm=BM/);
  assert.match(session.cookie(), /keepme=1/);
  assert.equal(session.userAgent(), 'UA-serverless');
});

test('mergeSetCookie() trả true khi jar đổi (để caller biết cần persist)', () => {
  session.setCredentials({ cookie: 'cf_clearance=OLD' });
  assert.equal(session.mergeSetCookie(['cf_clearance=NEWER; Path=/']), true);
  assert.equal(session.mergeSetCookie(['cf_clearance=NEWER; Path=/']), false); // không đổi → false
});
