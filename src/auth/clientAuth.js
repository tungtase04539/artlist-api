import { ApiKeys, Clients, Usage } from '../db/repos.js';
import * as monitor from '../abuse/monitor.js';
import { realIp } from '../lib/ip.js';

/**
 * preHandler bảo vệ /v1/*: xác thực API key, gắn request.client, chạy giám sát/anti-spam.
 * KHÔNG ghi DB cho request chưa xác thực (thiếu/sai key) — tránh khuếch đại DoS/chi phí khi bị flood.
 */
export async function clientAuth(request, reply) {
  const key = request.headers['x-api-key'];
  const ip = realIp(request);
  request.realIp = ip;

  if (!key) return reply.code(401).send({ error: 'Thiếu X-API-Key' });
  const rec = await ApiKeys.resolve(key);
  if (!rec) return reply.code(401).send({ error: 'API key không hợp lệ hoặc đã bị thu hồi' });
  if (rec.client_status !== 'active') {
    await Usage.record({ clientId: rec.client_id, apiKeyId: rec.id, type: 'error', statusCode: 403, ip, meta: { reason: 'suspended' } });
    return reply.code(403).send({ error: 'Tài khoản bị tạm khoá' });
  }

  const client = await Clients.get(rec.client_id);
  await ApiKeys.touch(rec.id);
  request.client = client;
  request.apiKeyId = rec.id;

  const gate = await monitor.recordRequest(client, rec.id, ip, request.url);
  if (!gate.allowed) return reply.code(gate.code).send({ error: gate.message });
}
