import { db } from './db.js';
import { uuidv7 } from '../lib/uuid.js';
import { sha256, generateApiKey } from '../lib/crypto.js';

const now = () => Date.now();

// ─────────────────────────── Clients ───────────────────────────
export const Clients = {
  create({ name, credits = 0, ratePerMin, ratePerDay, notes = null }) {
    const id = uuidv7();
    db().prepare(
      `INSERT INTO clients(id,name,credits,rate_per_min,rate_per_day,status,notes,created_at)
       VALUES(?,?,?,?,?, 'active', ?, ?)`,
    ).run(id, name, credits, ratePerMin, ratePerDay, notes, now());
    return this.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM clients WHERE id=?').get(id) ?? null;
  },
  list() {
    return db().prepare('SELECT * FROM clients ORDER BY created_at DESC').all();
  },
  setStatus(id, status) {
    db().prepare('UPDATE clients SET status=? WHERE id=?').run(status, id);
    return this.get(id);
  },
  setLimits(id, ratePerMin, ratePerDay) {
    db().prepare('UPDATE clients SET rate_per_min=?, rate_per_day=? WHERE id=?').run(ratePerMin, ratePerDay, id);
    return this.get(id);
  },
};

// ─────────────────────────── API keys ───────────────────────────
export const ApiKeys = {
  /** Tạo key mới cho client. Trả về { raw, record } — raw chỉ hiện 1 lần. */
  create(clientId) {
    const { key, hash, prefix } = generateApiKey();
    const id = uuidv7();
    db().prepare(
      `INSERT INTO api_keys(id,client_id,key_hash,key_prefix,status,created_at) VALUES(?,?,?,?, 'active', ?)`,
    ).run(id, clientId, hash, prefix, now());
    return { raw: key, record: db().prepare('SELECT id,client_id,key_prefix,status,created_at FROM api_keys WHERE id=?').get(id) };
  },
  /** Tra key thô -> record active (kèm client). */
  resolve(rawKey) {
    const row = db().prepare(
      `SELECT k.*, c.status AS client_status FROM api_keys k JOIN clients c ON c.id=k.client_id
       WHERE k.key_hash=? AND k.status='active'`,
    ).get(sha256(rawKey));
    return row ?? null;
  },
  touch(id) {
    db().prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(now(), id);
  },
  listByClient(clientId) {
    return db().prepare('SELECT id,key_prefix,status,created_at,last_used_at FROM api_keys WHERE client_id=? ORDER BY created_at DESC').all(clientId);
  },
  revoke(id) {
    db().prepare(`UPDATE api_keys SET status='revoked' WHERE id=?`).run(id);
  },
};

// ─────────────────────────── Credits ───────────────────────────
export const Credits = {
  balance(clientId) {
    return db().prepare('SELECT credits FROM clients WHERE id=?').get(clientId)?.credits ?? 0;
  },
  /**
   * Thay đổi số dư 1 cách nguyên tử (transaction) và ghi sổ cái.
   * amount < 0 = trừ (usage), > 0 = cộng (topup/refund).
   * Trả { ok, balance }. ok=false nếu trừ mà không đủ số dư.
   */
  change(clientId, amount, reason, jobId = null) {
    const d = db();
    const tx = d.prepare('BEGIN'); tx.run();
    try {
      const row = d.prepare('SELECT credits FROM clients WHERE id=?').get(clientId);
      if (!row) { d.prepare('ROLLBACK').run(); return { ok: false, balance: 0 }; }
      const next = row.credits + amount;
      if (next < 0) { d.prepare('ROLLBACK').run(); return { ok: false, balance: row.credits }; }
      d.prepare('UPDATE clients SET credits=? WHERE id=?').run(next, clientId);
      d.prepare(
        'INSERT INTO credit_ledger(client_id,delta,reason,job_id,balance_after,created_at) VALUES(?,?,?,?,?,?)',
      ).run(clientId, amount, reason, jobId, next, now());
      d.prepare('COMMIT').run();
      return { ok: true, balance: next };
    } catch (e) {
      d.prepare('ROLLBACK').run();
      throw e;
    }
  },
  ledger(clientId, limit = 100) {
    return db().prepare('SELECT * FROM credit_ledger WHERE client_id=? ORDER BY id DESC LIMIT ?').all(clientId, limit);
  },
};

// ─────────────────────────── Jobs ───────────────────────────
export const Jobs = {
  create({ id, clientId, prompt, params, price }) {
    const t = now();
    db().prepare(
      `INSERT INTO jobs(id,client_id,status,prompt,params_json,price,created_at,updated_at)
       VALUES(?,?, 'pending', ?, ?, ?, ?, ?)`,
    ).run(id, clientId, prompt, JSON.stringify(params ?? {}), price ?? 0, t, t);
    return this.get(id);
  },
  get(id) {
    return db().prepare('SELECT * FROM jobs WHERE id=?').get(id) ?? null;
  },
  update(id, patch) {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updated_at: now() };
    db().prepare(
      `UPDATE jobs SET provider_job_id=?, status=?, price=?, refunded=?, video_url=?, thumbnail_url=?, error=?, updated_at=? WHERE id=?`,
    ).run(next.provider_job_id, next.status, next.price, next.refunded ? 1 : 0, next.video_url, next.thumbnail_url, next.error, next.updated_at, id);
    return this.get(id);
  },
  listByClient(clientId, limit = 100) {
    return db().prepare('SELECT * FROM jobs WHERE client_id=? ORDER BY created_at DESC LIMIT ?').all(clientId, limit);
  },
  listProcessing() {
    return db().prepare(`SELECT * FROM jobs WHERE status IN ('pending','processing')`).all();
  },
};

// ─────────────────────────── Usage events ───────────────────────────
export const Usage = {
  record({ clientId = null, apiKeyId = null, type, path = null, statusCode = null, ip = null, meta = null }) {
    db().prepare(
      'INSERT INTO usage_events(client_id,api_key_id,type,path,status_code,ip,meta_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    ).run(clientId, apiKeyId, type, path, statusCode, ip, meta ? JSON.stringify(meta) : null, now());
  },
  /** Đếm event của client theo type trong khoảng windowMs gần đây. */
  countRecent(clientId, sinceMs, types = null) {
    const since = now() - sinceMs;
    if (types) {
      const q = types.map(() => '?').join(',');
      return db().prepare(
        `SELECT COUNT(*) n FROM usage_events WHERE client_id=? AND created_at>=? AND type IN (${q})`,
      ).get(clientId, since, ...types).n;
    }
    return db().prepare('SELECT COUNT(*) n FROM usage_events WHERE client_id=? AND created_at>=?').get(clientId, since).n;
  },
  distinctIps(clientId, sinceMs) {
    const since = now() - sinceMs;
    return db().prepare(
      'SELECT COUNT(DISTINCT ip) n FROM usage_events WHERE client_id=? AND created_at>=? AND ip IS NOT NULL',
    ).get(clientId, since).n;
  },
  errorRate(clientId, sinceMs) {
    const since = now() - sinceMs;
    const total = db().prepare('SELECT COUNT(*) n FROM usage_events WHERE client_id=? AND created_at>=?').get(clientId, since).n;
    const errs = db().prepare(
      `SELECT COUNT(*) n FROM usage_events WHERE client_id=? AND created_at>=? AND (type IN ('error','quota_block','rate_block') OR status_code>=400)`,
    ).get(clientId, since).n;
    return { total, errs, rate: total ? errs / total : 0 };
  },
  recent(limit = 200) {
    return db().prepare('SELECT * FROM usage_events ORDER BY id DESC LIMIT ?').all(limit);
  },
};

// ─────────────────────────── Alerts ───────────────────────────
export const Alerts = {
  add({ clientId = null, severity, kind, message, meta = null }) {
    db().prepare(
      'INSERT INTO alerts(client_id,severity,kind,message,meta_json,created_at) VALUES(?,?,?,?,?,?)',
    ).run(clientId, severity, kind, message, meta ? JSON.stringify(meta) : null, now());
  },
  list(limit = 200) {
    return db().prepare('SELECT * FROM alerts ORDER BY id DESC LIMIT ?').all(limit);
  },
  resolve(id) {
    db().prepare('UPDATE alerts SET resolved=1 WHERE id=?').run(id);
  },
  countUnresolved() {
    return db().prepare('SELECT COUNT(*) n FROM alerts WHERE resolved=0').get().n;
  },
};
