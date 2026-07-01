import 'dotenv/config';
import { z } from 'zod';

/**
 * Đọc & validate biến môi trường. Fail-fast nếu thiếu cấu hình bắt buộc.
 */
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  // Admin: token bảo vệ toàn bộ /admin/* và dashboard.
  ADMIN_TOKEN: z.string().min(16, 'ADMIN_TOKEN cần >= 16 ký tự (openssl rand -hex 32)'),

  // DB: Postgres/Supabase (prod). Để trống => PGlite in-process (local/test).
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().optional(), // thư mục lưu PGlite local (trống => in-memory)
  PG_POOL_MAX: z.coerce.number().int().positive().default(5),
  CRON_SECRET: z.string().optional(), // bảo vệ /cron/sweep (Vercel Cron gửi Bearer)

  // Nguyên liệu artlist (admin cung cấp). Điền sau khi bắt request.
  ARTLIST_BASE_URL: z.string().url().optional(),
  ARTLIST_COOKIE: z.string().optional(),
  ARTLIST_USER_AGENT: z.string().optional(),
  ARTLIST_AUTH_TOKEN: z.string().optional(),
  ARTLIST_CSRF_TOKEN: z.string().optional(),

  // Poll & concurrency (outbound tới artlist).
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4000),
  POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(600000),
  MAX_CONCURRENT_JOBS: z.coerce.number().int().positive().default(4),

  // Rate limit mặc định cho client mới (admin chỉnh riêng từng client được).
  DEFAULT_RATE_PER_MIN: z.coerce.number().int().positive().default(6),
  DEFAULT_RATE_PER_DAY: z.coerce.number().int().positive().default(200),

  // Cache catalog model (ms).
  CATALOG_TTL_MS: z.coerce.number().int().positive().default(300000),

  // Ngưỡng phát hiện lạm dụng.
  ABUSE_ERROR_RATE: z.coerce.number().min(0).max(1).default(0.5), // tỉ lệ lỗi cảnh báo
  ABUSE_MIN_EVENTS: z.coerce.number().int().positive().default(20), // số event tối thiểu để xét
  ABUSE_MULTI_IP: z.coerce.number().int().positive().default(4), // số IP/key trong 1h -> nghi rò key
  ABUSE_AUTO_SUSPEND: z.string().optional().transform((v) => v !== 'false').pipe(z.boolean()), // tự khoá khi cheat giá
  MAX_CONCURRENT_PER_CLIENT: z.coerce.number().int().positive().default(3), // job đang chạy tối đa/client
  MAX_IMAGE_MB: z.coerce.number().positive().default(10), // trần dung lượng ảnh upload
  MAX_VIDEO_MB: z.coerce.number().positive().default(100), // trần video đầu vào
  MAX_AUDIO_MB: z.coerce.number().positive().default(30), // trần audio đầu vào
  MAX_IMAGES: z.coerce.number().int().positive().default(9), // số ảnh tối đa (image_urls)

  // Cảnh báo đẩy (khi session hết hạn / cheat...). Trống = chỉ ghi dashboard+log.
  ALERT_WEBHOOK_URL: z.string().url().optional(), // Discord/Slack/webhook tuỳ ý (nhận {content,text,...})
  TELEGRAM_BOT_TOKEN: z.string().optional(), // bot Telegram (BotFather)
  TELEGRAM_CHAT_ID: z.string().optional(), // chat/nhóm nhận cảnh báo
  DASHBOARD_URL: z.string().url().optional(), // chèn link dashboard vào nội dung cảnh báo
  ALERT_PUSH_KINDS: z.string().optional().default('session_expired,auto_suspend,price_mismatch'), // loại nào thì đẩy

  // Log sự kiện: giữ lại bao nhiêu ngày (cron tự dọn để bảng không phình).
  LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Cấu hình môi trường không hợp lệ:');
  for (const issue of parsed.error.issues) {
    console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
  }
  console.error('\n👉 Sao chép .env.example thành .env rồi điền giá trị (ít nhất ADMIN_TOKEN).');
  process.exit(1);
}

export const config = parsed.data;
