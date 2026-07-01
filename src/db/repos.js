import { query } from './db.js';
import { uuidv7 } from '../lib/uuid.js';
import { sha256, generateApiKey } from '../lib/crypto.js';

const now = () => Date.now();
const one = (r) => r.rows[0] ?? null;

// ─────────────────────────── Clients ───────────────────────────
export const Clients = {
  async create({ name, credits = 0, ratePerMin, ratePerDay, notes = null, defaultChatSessionId = null }) {
    const id = uuidv7();
    await query(
      `INSERT INTO clients(id,name,credits,rate_per_min,rate_per_day,status,notes,default_chat_session_id,created_at)
       VALUES($1,$2,$3,$4,$5,'active',$6,$7,$8)`,
      [id, name, credits, ratePerMin, ratePerDay, notes, defaultChatSessionId, now()],
    );
    return this.get(id);
  },
  async get(id) {
    return one(await query('SELECT * FROM clients WHERE id=$1', [id]));
  },
  async list() {
    return (await query('SELECT * FROM clients ORDER BY created_at DESC')).rows;
  },
  async setStatus(id, status) {
    await query('UPDATE clients SET status=$1 WHERE id=$2', [status, id]);
    return this.get(id);
  },
  async setLimits(id, ratePerMin, ratePerDay) {
    await query('UPDATE clients SET rate_per_min=$1, rate_per_day=$2 WHERE id=$3', [ratePerMin, ratePerDay, id]);
    return this.get(id);
  },
  async setDefaultSession(id, sessionId) {
    await query('UPDATE clients SET default_chat_session_id=$1 WHERE id=$2', [sessionId, id]);
    return this.get(id);
  },
};

// ─────────────────────────── API keys ───────────────────────────
export const ApiKeys = {
  async create(clientId) {
    const { key, hash, prefix } = generateApiKey();
    const id = uuidv7();
    await query(
      `INSERT INTO api_keys(id,client_id,key_hash,key_prefix,status,created_at) VALUES($1,$2,$3,$4,'active',$5)`,
      [id, clientId, hash, prefix, now()],
    );
    return { raw: key, record: one(await query('SELECT id,client_id,key_prefix,status,created_at FROM api_keys WHERE id=$1', [id])) };
  },
  async resolve(rawKey) {
    return one(await query(
      `SELECT k.*, c.status AS client_status FROM api_keys k JOIN clients c ON c.id=k.client_id
       WHERE k.key_hash=$1 AND k.status='active'`,
      [sha256(rawKey)],
    ));
  },
  async touch(id) {
    await query('UPDATE api_keys SET last_used_at=$1 WHERE id=$2', [now(), id]);
  },
  async listByClient(clientId) {
    return (await query('SELECT id,key_prefix,status,created_at,last_used_at FROM api_keys WHERE client_id=$1 ORDER BY created_at DESC', [clientId])).rows;
  },
  async revoke(id) {
    await query(`UPDATE api_keys SET status='revoked' WHERE id=$1`, [id]);
  },
};

// ─────────────────────────── Credits ───────────────────────────
export const Credits = {
  async balance(clientId) {
    return one(await query('SELECT credits FROM clients WHERE id=$1', [clientId]))?.credits ?? 0;
  },
  /**
   * Đổi số dư NGUYÊN TỬ bằng 1 câu UPDATE có điều kiện (không cho âm).
   * amount<0 = trừ, >0 = cộng. Trả { ok, balance }.
   */
  async change(clientId, amount, reason, jobId = null) {
    const r = await query(
      'UPDATE clients SET credits = credits + $1 WHERE id=$2 AND credits + $1 >= 0 RETURNING credits',
      [amount, clientId],
    );
    if (!r.rows.length) {
      return { ok: false, balance: await this.balance(clientId) };
    }
    const balance = r.rows[0].credits;
    await query(
      'INSERT INTO credit_ledger(client_id,delta,reason,job_id,balance_after,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [clientId, amount, reason, jobId, balance, now()],
    );
    return { ok: true, balance };
  },
  async ledger(clientId, limit = 100) {
    return (await query('SELECT * FROM credit_ledger WHERE client_id=$1 ORDER BY id DESC LIMIT $2', [clientId, limit])).rows;
  },
};

// ─────────────────────────── Jobs ───────────────────────────
const JOB_COLS = ['provider_job_id', 'status', 'price', 'refunded', 'video_url', 'thumbnail_url', 'output_file_key', 'thumbnail_file_key', 'error'];
export const Jobs = {
  async create({ id, clientId, prompt, params, price }) {
    const t = now();
    await query(
      `INSERT INTO jobs(id,client_id,status,prompt,params_json,price,created_at,updated_at)
       VALUES($1,$2,'pending',$3,$4,$5,$6,$6)`,
      [id, clientId, prompt, JSON.stringify(params ?? {}), price ?? 0, t],
    );
    return this.get(id);
  },
  async get(id) {
    return one(await query('SELECT * FROM jobs WHERE id=$1', [id]));
  },
  async update(id, patch) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const col of JOB_COLS) {
      if (col in patch) {
        sets.push(`${col}=$${i++}`);
        vals.push(col === 'refunded' ? (patch[col] ? 1 : 0) : patch[col]);
      }
    }
    sets.push(`updated_at=$${i++}`);
    vals.push(now());
    vals.push(id);
    await query(`UPDATE jobs SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    return this.get(id);
  },
  async listByClient(clientId, limit = 100) {
    return (await query('SELECT * FROM jobs WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2', [clientId, limit])).rows;
  },
  async countActiveByClient(clientId) {
    return one(await query(`SELECT COUNT(*)::int n FROM jobs WHERE client_id=$1 AND status IN ('pending','processing')`, [clientId])).n;
  },
  async listProcessing(olderThanMs = 0, limit = 100) {
    return (await query(
      `SELECT * FROM jobs WHERE status IN ('pending','processing') AND updated_at <= $1 ORDER BY updated_at ASC LIMIT $2`,
      [now() - olderThanMs, limit],
    )).rows;
  },
};

// ─────────────────────────── Usage ───────────────────────────
export const Usage = {
  async record({ clientId = null, apiKeyId = null, type, path = null, statusCode = null, ip = null, meta = null }) {
    await query(
      'INSERT INTO usage_events(client_id,api_key_id,type,path,status_code,ip,meta_json,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [clientId, apiKeyId, type, path, statusCode, ip, meta ? JSON.stringify(meta) : null, now()],
    );
  },
  async countRecent(clientId, sinceMs, types = null) {
    const since = now() - sinceMs;
    if (types) {
      const ph = types.map((_, i) => `$${i + 3}`).join(',');
      return one(await query(
        `SELECT COUNT(*)::int n FROM usage_events WHERE client_id=$1 AND created_at>=$2 AND type IN (${ph})`,
        [clientId, since, ...types],
      )).n;
    }
    return one(await query('SELECT COUNT(*)::int n FROM usage_events WHERE client_id=$1 AND created_at>=$2', [clientId, since])).n;
  },
  async distinctIps(clientId, sinceMs) {
    return one(await query(
      'SELECT COUNT(DISTINCT ip)::int n FROM usage_events WHERE client_id=$1 AND created_at>=$2 AND ip IS NOT NULL',
      [clientId, now() - sinceMs],
    )).n;
  },
  async errorRate(clientId, sinceMs) {
    const since = now() - sinceMs;
    const total = one(await query('SELECT COUNT(*)::int n FROM usage_events WHERE client_id=$1 AND created_at>=$2', [clientId, since])).n;
    const errs = one(await query(
      `SELECT COUNT(*)::int n FROM usage_events WHERE client_id=$1 AND created_at>=$2 AND (type IN ('error','quota_block','rate_block') OR status_code>=400)`,
      [clientId, since],
    )).n;
    return { total, errs, rate: total ? errs / total : 0 };
  },
  async recent(limit = 200) {
    return (await query('SELECT * FROM usage_events ORDER BY id DESC LIMIT $1', [limit])).rows;
  },
};

// ─────────────────────────── Alerts ───────────────────────────
export const Alerts = {
  async add({ clientId = null, severity, kind, message, meta = null }) {
    await query(
      'INSERT INTO alerts(client_id,severity,kind,message,meta_json,created_at) VALUES($1,$2,$3,$4,$5,$6)',
      [clientId, severity, kind, message, meta ? JSON.stringify(meta) : null, now()],
    );
  },
  /** Có alert cùng (client, kind) chưa xử lý trong windowMs không (để chống spam alert). */
  async existsRecent(clientId, kind, windowMs) {
    return Boolean(one(await query(
      'SELECT 1 FROM alerts WHERE client_id IS NOT DISTINCT FROM $1 AND kind=$2 AND created_at>=$3 LIMIT 1',
      [clientId, kind, now() - windowMs],
    )));
  },
  async list(limit = 200) {
    return (await query('SELECT * FROM alerts ORDER BY id DESC LIMIT $1', [limit])).rows;
  },
  async resolve(id) {
    await query('UPDATE alerts SET resolved=1 WHERE id=$1', [id]);
  },
  async countUnresolved() {
    return one(await query('SELECT COUNT(*)::int n FROM alerts WHERE resolved=0')).n;
  },
};

// ─────────────────────────── Settings (key-value dùng chung) ───────────────────────────
export const Settings = {
  async get(key) {
    return one(await query('SELECT value FROM app_settings WHERE key=$1', [key]))?.value ?? null;
  },
  async set(key, value) {
    await query(
      `INSERT INTO app_settings(key,value,updated_at) VALUES($1,$2,$3)
       ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at`,
      [key, value, now()],
    );
  },
};
