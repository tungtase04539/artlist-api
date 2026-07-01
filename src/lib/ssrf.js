import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Chặn SSRF: media URL do CLIENT cung cấp được server tải về (uploadMedia) → phải chặn
 * URL trỏ vào hạ tầng nội bộ / cloud metadata. Kiểm tra scheme + IP literal + phân giải DNS.
 * (Không pin IP sau resolve nên còn khe DNS-rebinding cực hẹp — chấp nhận ở phạm vi hiện tại.)
 */

/** IP có phải public không (false = private/reserved/loopback/link-local...). */
export function ipIsPublic(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local + cloud metadata 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false; // 192.0.0.0/24
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a >= 224) return false; // multicast / reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const s = ip.toLowerCase();
    if (s === '::1' || s === '::') return false;
    if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) return false; // fe80::/10
    if (s.startsWith('fc') || s.startsWith('fd')) return false; // unique-local fc00::/7
    if (s.startsWith('::ffff:')) { // IPv4-mapped
      const v4 = s.split(':').pop();
      if (net.isIPv4(v4)) return ipIsPublic(v4);
    }
    return true;
  }
  return false;
}

/** Ném lỗi nếu URL không an toàn để server tải về. Trả lại URL nếu OK. */
export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { throw new Error('URL không hợp lệ'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Chỉ chấp nhận URL http/https');
  if (u.username || u.password) throw new Error('URL không được chứa userinfo (user:pass@)');

  const host = u.hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local') || lower.endsWith('.internal')) {
    throw new Error('Host nội bộ bị chặn');
  }
  if (net.isIP(host)) {
    if (!ipIsPublic(host)) throw new Error('IP nội bộ/reserved bị chặn');
    return raw;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); } catch { throw new Error('Không phân giải được host'); }
  if (!addrs.length) throw new Error('Không phân giải được host');
  for (const { address } of addrs) {
    if (!ipIsPublic(address)) throw new Error('Host phân giải ra IP nội bộ (bị chặn)');
  }
  return raw;
}
