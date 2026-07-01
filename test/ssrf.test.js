// Chặn SSRF cho media URL do client cung cấp (không phụ thuộc DNS: dùng IP literal / localhost).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertPublicUrl, ipIsPublic } from '../src/lib/ssrf.js';

test('chặn IP nội bộ / metadata / loopback / non-http', async () => {
  const blocked = [
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://127.0.0.1/x', 'http://10.1.2.3/x', 'http://192.168.0.1/x', 'http://172.16.5.5/x',
    'http://100.64.0.1/x', // CGNAT
    'https://localhost/x', 'http://foo.internal/x', 'http://bar.local/x',
    'ftp://1.1.1.1/x', 'file:///etc/passwd',
    'http://user:pass@1.1.1.1/x', // userinfo
    'http://[::1]/x', // IPv6 loopback
  ];
  for (const u of blocked) {
    await assert.rejects(assertPublicUrl(u), new RegExp('.'), `phải chặn: ${u}`);
  }
});

test('cho phép IP public literal (không cần DNS)', async () => {
  assert.equal(await assertPublicUrl('https://1.1.1.1/img.png'), 'https://1.1.1.1/img.png');
  assert.equal(await assertPublicUrl('https://8.8.8.8/x.jpg'), 'https://8.8.8.8/x.jpg');
});

test('ipIsPublic phân loại đúng', () => {
  assert.equal(ipIsPublic('1.1.1.1'), true);
  assert.equal(ipIsPublic('10.0.0.1'), false);
  assert.equal(ipIsPublic('169.254.169.254'), false);
  assert.equal(ipIsPublic('::1'), false);
  assert.equal(ipIsPublic('fd00::1'), false);
  assert.equal(ipIsPublic('2606:4700:4700::1111'), true);
});
