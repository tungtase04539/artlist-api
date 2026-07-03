import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Lớp DB Postgres, dùng chung 1 API `query(text, params) -> { rows }`.
 * - Prod: node-postgres (`pg`) tới DATABASE_URL (Supabase).
 * - Local/test: PGlite (Postgres in-process, cùng API) — không cần server.
 */

let _q = null;
let _ready = null;

async function init() {
  const url = config.DATABASE_URL;
  if (url) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10))); // int8 -> Number
    const pool = new pg.Pool({
      connectionString: url,
      max: config.PG_POOL_MAX,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    _q = (text, params) => pool.query(text, params);
    logger.info('Postgres (DATABASE_URL) sẵn sàng');
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const dir = config.PGLITE_DIR || undefined; // undefined => in-memory
    const db = new PGlite(dir);
    _q = (text, params) => db.query(text, params);
    logger.info({ dir: dir || 'memory' }, 'PGlite (local) sẵn sàng');
  }
  await migrate();
}

/** Đảm bảo DB đã khởi tạo (idempotent). */
export async function ready() {
  // Nếu init lỗi (vd DB tạm không tới được), reset để lần gọi sau thử lại.
  if (!_ready) _ready = init().catch((e) => { _ready = null; throw e; });
  return _ready;
}

/** Chạy query, tự init nếu cần. */
export async function query(text, params = []) {
  await ready();
  return _q(text, params);
}

async function migrate() {
  await _q(`CREATE TABLE IF NOT EXISTS clients (
    id text PRIMARY KEY,
    name text NOT NULL,
    credits integer NOT NULL DEFAULT 0,
    rate_per_min integer NOT NULL,
    rate_per_day integer NOT NULL,
    status text NOT NULL DEFAULT 'active',
    notes text,
    default_chat_session_id text,
    created_at bigint NOT NULL
  )`);
  // Cờ: bỏ qua maxCredits/expectedCredits client gửi (chỉ số dư giới hạn). Cho tích hợp relay.
  await _q(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS ignore_price_caps integer NOT NULL DEFAULT 0`);

  await _q(`CREATE TABLE IF NOT EXISTS api_keys (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES clients(id),
    key_hash text NOT NULL UNIQUE,
    key_prefix text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    created_at bigint NOT NULL,
    last_used_at bigint
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_api_keys_client ON api_keys(client_id)`);

  await _q(`CREATE TABLE IF NOT EXISTS credit_ledger (
    id bigserial PRIMARY KEY,
    client_id text NOT NULL REFERENCES clients(id),
    delta integer NOT NULL,
    reason text NOT NULL,
    job_id text,
    balance_after integer NOT NULL,
    created_at bigint NOT NULL
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_ledger_client ON credit_ledger(client_id, created_at)`);

  await _q(`CREATE TABLE IF NOT EXISTS jobs (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES clients(id),
    provider_job_id text,
    status text NOT NULL,
    prompt text,
    params_json text,
    price integer NOT NULL DEFAULT 0,
    refunded integer NOT NULL DEFAULT 0,
    video_url text,
    thumbnail_url text,
    output_file_key text,
    thumbnail_file_key text,
    error text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`);
  // Lưu fileKey kết quả để ký lại url CloudFront khi hết hạn (bảng cũ → thêm cột).
  await _q(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS output_file_key text`);
  await _q(`ALTER TABLE jobs ADD COLUMN IF NOT EXISTS thumbnail_file_key text`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id, created_at)`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);

  // Job tạo nhạc Suno (nguồn AI33) — tách riêng khỏi jobs video để billing/logic sạch.
  await _q(`CREATE TABLE IF NOT EXISTS music_jobs (
    id text PRIMARY KEY,
    client_id text NOT NULL REFERENCES clients(id),
    provider_task_id text,
    status text NOT NULL,
    mode text,
    prompt text,
    params_json text,
    price integer NOT NULL DEFAULT 0,
    refunded integer NOT NULL DEFAULT 0,
    audio_url text,
    audio_urls_json text,
    image_url text,
    title text,
    duration real,
    error text,
    created_at bigint NOT NULL,
    updated_at bigint NOT NULL
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_music_client ON music_jobs(client_id, created_at)`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_music_status ON music_jobs(status)`);

  await _q(`CREATE TABLE IF NOT EXISTS usage_events (
    id bigserial PRIMARY KEY,
    client_id text,
    api_key_id text,
    type text NOT NULL,
    path text,
    status_code integer,
    ip text,
    meta_json text,
    created_at bigint NOT NULL
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_usage_client ON usage_events(client_id, created_at)`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_usage_type ON usage_events(type, created_at)`);

  await _q(`CREATE TABLE IF NOT EXISTS alerts (
    id bigserial PRIMARY KEY,
    client_id text,
    severity text NOT NULL,
    kind text NOT NULL,
    message text NOT NULL,
    meta_json text,
    resolved integer NOT NULL DEFAULT 0,
    created_at bigint NOT NULL
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at)`);

  // Key-value dùng chung mọi instance (serverless): lưu cookie session artlist để
  // auto-refresh (Set-Cookie) & POST /admin/session tồn tại xuyên suốt các lần gọi.
  await _q(`CREATE TABLE IF NOT EXISTS app_settings (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at bigint NOT NULL
  )`);

  // Log sự kiện có cấu trúc: HTTP, call artlist, job, credit, session, abuse, error.
  // Đọc lại để phát hiện bất thường (GET /admin/logs, /admin/logs/summary).
  await _q(`CREATE TABLE IF NOT EXISTS event_log (
    id bigserial PRIMARY KEY,
    ts bigint NOT NULL,
    level text NOT NULL,
    category text NOT NULL,
    event text NOT NULL,
    client_id text,
    job_id text,
    request_id text,
    method text,
    path text,
    status_code integer,
    duration_ms integer,
    ip text,
    message text,
    meta_json text
  )`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_event_ts ON event_log(ts)`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_event_cat ON event_log(category, ts)`);
  await _q(`CREATE INDEX IF NOT EXISTS idx_event_level ON event_log(level, ts)`);
}
