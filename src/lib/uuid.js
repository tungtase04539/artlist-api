import { randomBytes } from 'node:crypto';

/**
 * Sinh UUIDv7 (time-ordered) — khớp cách artlist sinh chatSessionId/generationId ở client.
 * 48-bit đầu = timestamp ms, sau đó là version(7)/variant + random.
 * (crypto.randomUUID của Node là v4, nên tự cài v7 cho khớp hành vi.)
 */
export function uuidv7() {
  const ts = Date.now();
  const b = randomBytes(16);
  b[0] = Math.floor(ts / 2 ** 40) & 0xff;
  b[1] = Math.floor(ts / 2 ** 32) & 0xff;
  b[2] = Math.floor(ts / 2 ** 24) & 0xff;
  b[3] = Math.floor(ts / 2 ** 16) & 0xff;
  b[4] = Math.floor(ts / 2 ** 8) & 0xff;
  b[5] = ts & 0xff;
  b[6] = (b[6] & 0x0f) | 0x70; // version 7
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
