import { config } from '../config.js';
import { logger } from './logger.js';
import { fetchWithRetry } from './http.js';

const ICON = { critical: '🔴', warning: '🟠', info: 'ℹ️' };

/**
 * Đẩy cảnh báo ra kênh ngoài (Telegram + webhook Discord/Slack/tuỳ ý). Best-effort:
 * lỗi kênh không làm hỏng luồng chính. Chỉ gọi cho các alert MỚI (raise() đã dedup qua DB).
 */
export async function pushAlert({ severity = 'warning', kind, message, meta = null }) {
  const line = `${ICON[severity] || '•'} [${kind}] ${message}`;
  const dash = config.DASHBOARD_URL ? `\n${config.DASHBOARD_URL}` : '';
  const text = line + dash;
  const tasks = [];

  if (config.ALERT_WEBHOOK_URL) {
    // content = Discord · text = Slack · các field còn lại cho webhook tuỳ biến.
    tasks.push(post(config.ALERT_WEBHOOK_URL, { content: text, text, severity, kind, message, meta }));
  }
  if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
    tasks.push(post(`https://api.telegram.org/bot${config.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: config.TELEGRAM_CHAT_ID, text, disable_web_page_preview: true,
    }));
  }
  if (tasks.length) await Promise.allSettled(tasks);
}

async function post(url, body) {
  try {
    await fetchWithRetry(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, { retries: 1, timeoutMs: 8000 });
  } catch (e) {
    logger.warn({ err: String(e.message || e) }, 'Đẩy cảnh báo ra kênh ngoài lỗi (bỏ qua)');
  }
}
