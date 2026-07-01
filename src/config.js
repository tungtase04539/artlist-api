import 'dotenv/config';
import { z } from 'zod';

/**
 * Đọc & validate biến môi trường. Fail-fast nếu thiếu cấu hình bắt buộc để chạy server.
 * Các giá trị phía artlist (BASE_URL, COOKIE...) là optional ở mức boot vì có thể
 * điền sau khi bắt request (Phase 1); client sẽ báo lỗi rõ ràng nếu thiếu khi gọi.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  API_KEY: z.string().min(1, 'API_KEY là bắt buộc — sinh bằng: openssl rand -hex 32'),

  ARTLIST_BASE_URL: z.string().url().optional(),
  ARTLIST_COOKIE: z.string().optional(),
  ARTLIST_AUTH_TOKEN: z.string().optional(),
  ARTLIST_CSRF_TOKEN: z.string().optional(),
  ARTLIST_USER_AGENT: z.string().optional(),

  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(2),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Cấu hình môi trường không hợp lệ:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n👉 Sao chép .env.example thành .env rồi điền giá trị.');
  process.exit(1);
}

export const config = parsed.data;

/** True nếu đã đủ cấu hình để gọi sang artlist. */
export function isArtlistConfigured() {
  return Boolean(config.ARTLIST_BASE_URL && (config.ARTLIST_COOKIE || config.ARTLIST_AUTH_TOKEN));
}
