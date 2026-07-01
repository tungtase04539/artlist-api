/**
 * IP client thật. Trên Vercel, `x-real-ip` do hạ tầng đặt (client không giả mạo được),
 * đáng tin hơn req.ip khi trustProxy:true (lấy leftmost X-Forwarded-For — client tự thêm được).
 */
export function realIp(req) {
  const xr = req.headers?.['x-real-ip'];
  if (xr) return String(xr).split(',')[0].trim();
  return req.ip;
}
