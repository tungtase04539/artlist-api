// Test cookie jar tự làm mới (không gọi mạng).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { session } = await import('../src/session/session.js');

test('cookie jar: setCredentials + mergeSetCookie tự làm mới', () => {
  session.setCredentials({ cookie: 'a=1; b=2; cf_clearance=OLD; __cf_bm=OLDBM' });
  assert.match(session.cookie(), /a=1/);
  assert.match(session.cookie(), /cf_clearance=OLD/);

  // artlist trả Set-Cookie mới -> jar tự cập nhật, giữ cookie khác.
  session.mergeSetCookie([
    'cf_clearance=NEW; Path=/; Expires=Wed, 01 Jul 2026 09:00:00 GMT; Secure',
    '__cf_bm=NEWBM; Path=/; HttpOnly',
  ]);
  assert.match(session.cookie(), /cf_clearance=NEW/);
  assert.match(session.cookie(), /__cf_bm=NEWBM/);
  assert.match(session.cookie(), /a=1/); // cookie cũ vẫn giữ
  assert.doesNotMatch(session.cookie(), /cf_clearance=OLD/);
});

test('mergeSetCookie: bỏ qua cookie rỗng/deleted', () => {
  session.setCredentials({ cookie: 'keep=1' });
  session.mergeSetCookie(['keep=; Max-Age=0', 'x=deleted']);
  assert.match(session.cookie(), /keep=1/); // không bị xoá bởi giá trị rỗng
});
