// pushAlert phải AN TOÀN khi chưa cấu hình kênh nào (mặc định trên prod cho tới khi bật).
process.env.ADMIN_TOKEN = 'test-admin-token-1234567890';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pushAlert } from '../src/lib/notify.js';

test('pushAlert: không throw khi chưa cấu hình Telegram/webhook', async () => {
  await assert.doesNotReject(pushAlert({ severity: 'critical', kind: 'session_expired', message: 'test' }));
});
