import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * SQLite (built-in node:sqlite). Đồng bộ, đủ nhanh cho dịch vụ nhỏ/vừa.
 * Lưu: clients, api_keys, credit_ledger, jobs, usage_events, alerts.
 */

let _db = null;

export function db() {
  if (_db) return _db;
  if (config.DB_PATH !== ':memory:') mkdirSync(dirname(config.DB_PATH), { recursive: true });
  _db = new DatabaseSync(config.DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  migrate(_db);
  logger.info({ dbPath: config.DB_PATH }, 'SQLite sẵn sàng');
  return _db;
}

function migrate(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      id           TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      credits      INTEGER NOT NULL DEFAULT 0,
      rate_per_min INTEGER NOT NULL,
      rate_per_day INTEGER NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',   -- active | suspended
      notes        TEXT,
      created_at   INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      client_id    TEXT NOT NULL REFERENCES clients(id),
      key_hash     TEXT NOT NULL UNIQUE,   -- sha256(key)
      key_prefix   TEXT NOT NULL,          -- vài ký tự đầu để hiển thị
      status       TEXT NOT NULL DEFAULT 'active', -- active | revoked
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_client ON api_keys(client_id);

    CREATE TABLE IF NOT EXISTS credit_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id     TEXT NOT NULL REFERENCES clients(id),
      delta         INTEGER NOT NULL,       -- + nạp/refund, - tiêu
      reason        TEXT NOT NULL,          -- topup | usage | refund | adjust
      job_id        TEXT,
      balance_after INTEGER NOT NULL,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_client ON credit_ledger(client_id, created_at);

    CREATE TABLE IF NOT EXISTS jobs (
      id             TEXT PRIMARY KEY,
      client_id      TEXT NOT NULL REFERENCES clients(id),
      provider_job_id TEXT,
      status         TEXT NOT NULL,         -- pending|processing|done|failed
      prompt         TEXT,
      params_json    TEXT,
      price          INTEGER NOT NULL DEFAULT 0,
      refunded       INTEGER NOT NULL DEFAULT 0,
      video_url      TEXT,
      thumbnail_url  TEXT,
      error          TEXT,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_client ON jobs(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS usage_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   TEXT,
      api_key_id  TEXT,
      type        TEXT NOT NULL,            -- request | create | error | quota_block | rate_block
      path        TEXT,
      status_code INTEGER,
      ip          TEXT,
      meta_json   TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_client ON usage_events(client_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_usage_type ON usage_events(type, created_at);

    CREATE TABLE IF NOT EXISTS alerts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id  TEXT,
      severity   TEXT NOT NULL,             -- info | warning | critical
      kind       TEXT NOT NULL,             -- rate_abuse | quota_abuse | error_spike | key_sharing | price_mismatch | session_expired ...
      message    TEXT NOT NULL,
      meta_json  TEXT,
      resolved   INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
  `);
}
