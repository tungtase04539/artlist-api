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
  async setIgnorePriceCaps(id, on) {
    await query('UPDATE clients SET ignore_price_caps=$1 WHERE id=$2', [on ? 1 : 0, id]);
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

  // ── Ví MUSIC (Suno) — tách riêng, cột clients.music_credits ──
  async musicBalance(clientId) {
    return one(await query('SELECT music_credits FROM clients WHERE id=$1', [clientId]))?.music_credits ?? 0;
  },
  async changeMusic(clientId, amount, reason, jobId = null) {
    const r = await query(
      'UPDATE clients SET music_credits = music_credits + $1 WHERE id=$2 AND music_credits + $1 >= 0 RETURNING music_credits',
      [amount, clientId],
    );
    if (!r.rows.length) return { ok: false, balance: await this.musicBalance(clientId) };
    const balance = r.rows[0].music_credits;
    await query(
      "INSERT INTO credit_ledger(client_id,delta,reason,job_id,balance_after,created_at,currency) VALUES($1,$2,$3,$4,$5,$6,'music')",
      [clientId, amount, reason, jobId, balance, now()],
    );
    return { ok: true, balance };
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
  // Chi tiết job của 1 client trong khoảng thời gian (để dựng hoá đơn).
  async forBilling(clientId, since, until) {
    return (await query(
      `SELECT id,status,price,refunded,params_json,created_at FROM jobs
       WHERE client_id=$1 AND created_at>=$2 AND created_at<=$3 ORDER BY created_at DESC`,
      [clientId, since, until],
    )).rows;
  },
  // Tổng hợp mọi client: số video done + credits đã dùng (billable) trong khoảng.
  async billingAll(since, until) {
    return (await query(
      `SELECT client_id,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)::int videos_done,
        SUM(CASE WHEN status='done' THEN price ELSE 0 END)::int credits_used,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)::int videos_failed
       FROM jobs WHERE created_at>=$1 AND created_at<=$2 GROUP BY client_id`,
      [since, until],
    )).rows;
  },
};

// ─────────────────────────── Music jobs (Suno qua AI33) ───────────────────────────
const MUSIC_COLS = ['provider_task_id', 'status', 'price', 'refunded', 'audio_url', 'audio_urls_json', 'image_url', 'title', 'duration', 'error'];
export const MusicJobs = {
  async create({ id, clientId, mode, prompt, params, price }) {
    const t = now();
    await query(
      `INSERT INTO music_jobs(id,client_id,status,mode,prompt,params_json,price,created_at,updated_at)
       VALUES($1,$2,'pending',$3,$4,$5,$6,$7,$7)`,
      [id, clientId, mode ?? null, prompt ?? null, JSON.stringify(params ?? {}), price ?? 0, t],
    );
    return this.get(id);
  },
  async get(id) {
    return one(await query('SELECT * FROM music_jobs WHERE id=$1', [id]));
  },
  async update(id, patch) {
    const sets = [];
    const vals = [];
    let i = 1;
    for (const col of MUSIC_COLS) {
      if (col in patch) {
        sets.push(`${col}=$${i++}`);
        vals.push(col === 'refunded' ? (patch[col] ? 1 : 0) : patch[col]);
      }
    }
    sets.push(`updated_at=$${i++}`);
    vals.push(now());
    vals.push(id);
    await query(`UPDATE music_jobs SET ${sets.join(', ')} WHERE id=$${i}`, vals);
    return this.get(id);
  },
  async listByClient(clientId, limit = 100) {
    return (await query('SELECT * FROM music_jobs WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2', [clientId, limit])).rows;
  },
  async countActiveByClient(clientId) {
    return one(await query(`SELECT COUNT(*)::int n FROM music_jobs WHERE client_id=$1 AND status IN ('pending','processing')`, [clientId])).n;
  },
  async listProcessing(olderThanMs = 0, limit = 100) {
    return (await query(
      `SELECT * FROM music_jobs WHERE status IN ('pending','processing') AND updated_at <= $1 ORDER BY updated_at ASC LIMIT $2`,
      [now() - olderThanMs, limit],
    )).rows;
  },
  // Tổng hợp mọi client: số nhạc done + credits đã dùng trong khoảng (billing).
  async billingAll(since, until) {
    return (await query(
      `SELECT client_id,
        SUM(CASE WHEN status='done' THEN 1 ELSE 0 END)::int songs_done,
        SUM(CASE WHEN status='done' THEN price ELSE 0 END)::int credits_used,
        SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END)::int songs_failed
       FROM music_jobs WHERE created_at>=$1 AND created_at<=$2 GROUP BY client_id`,
      [since, until],
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
  async pruneKeysLike(prefix, olderThanMs) {
    const r = await query('DELETE FROM app_settings WHERE key LIKE $1 AND updated_at < $2', [`${prefix}%`, now() - olderThanMs]);
    return r.rowCount ?? r.affectedRows ?? 0;
  },
  async deleteKeysLike(prefix) {
    const r = await query('DELETE FROM app_settings WHERE key LIKE $1', [`${prefix}%`]);
    return r.rowCount ?? r.affectedRows ?? 0;
  },
};

// ─────────────────────────── Event log (đọc lại để soi bất thường) ───────────────────────────
export const Events = {
  async add(e = {}) {
    await query(
      `INSERT INTO event_log(ts,level,category,event,client_id,job_id,request_id,method,path,status_code,duration_ms,ip,message,meta_json)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        e.ts ?? now(), e.level ?? 'info', e.category ?? 'system', String(e.event ?? '').slice(0, 120),
        e.clientId ?? null, e.jobId ?? null, e.requestId ?? null, e.method ?? null,
        e.path ? String(e.path).slice(0, 200) : null, e.statusCode ?? null, e.durationMs ?? null, e.ip ?? null,
        e.message ? String(e.message).slice(0, 500) : null, e.meta ? JSON.stringify(e.meta).slice(0, 4000) : null,
      ],
    );
  },
  async list({ level, category, clientId, event, since, until, statusMin, limit = 200 } = {}) {
    const w = []; const p = []; let i = 1;
    if (level) { w.push(`level=$${i++}`); p.push(level); }
    if (category) { w.push(`category=$${i++}`); p.push(category); }
    if (clientId) { w.push(`client_id=$${i++}`); p.push(clientId); }
    if (event) { w.push(`event ILIKE $${i++}`); p.push(`%${event}%`); }
    if (since) { w.push(`ts>=$${i++}`); p.push(Number(since)); }
    if (until) { w.push(`ts<=$${i++}`); p.push(Number(until)); }
    if (statusMin) { w.push(`status_code>=$${i++}`); p.push(Number(statusMin)); }
    const where = w.length ? `WHERE ${w.join(' AND ')}` : '';
    p.push(Math.min(Number(limit) || 200, 1000));
    return (await query(`SELECT * FROM event_log ${where} ORDER BY id DESC LIMIT $${i}`, p)).rows;
  },
  async summary(sinceMs = 3_600_000) {
    const since = now() - sinceMs;
    const rows = (q, params = [since]) => query(q, params).then((r) => r.rows);
    const [byLevel, byCat, httpStatus, recentErrors, slowest, upstream] = await Promise.all([
      rows(`SELECT level, COUNT(*)::int n FROM event_log WHERE ts>=$1 GROUP BY level`),
      rows(`SELECT category, COUNT(*)::int n FROM event_log WHERE ts>=$1 GROUP BY category ORDER BY n DESC`),
      rows(`SELECT status_code, COUNT(*)::int n FROM event_log WHERE ts>=$1 AND category='http' AND status_code IS NOT NULL GROUP BY status_code ORDER BY n DESC`),
      rows(`SELECT ts,category,event,path,status_code,client_id,message FROM event_log WHERE ts>=$1 AND level='error' ORDER BY id DESC LIMIT 30`),
      rows(`SELECT ts,method,path,duration_ms,status_code FROM event_log WHERE ts>=$1 AND category='http' AND duration_ms IS NOT NULL ORDER BY duration_ms DESC LIMIT 10`),
      rows(`SELECT COUNT(*)::int n FROM event_log WHERE ts>=$1 AND category='artlist' AND level IN ('warn','error')`),
    ]);
    return { windowMs: sinceMs, byLevel, byCategory: byCat, httpStatus, upstreamErrors: upstream[0]?.n ?? 0, recentErrors, slowestHttp: slowest };
  },
  async prune(olderThanMs) {
    const r = await query(`DELETE FROM event_log WHERE ts < $1`, [now() - olderThanMs]);
    return r.rowCount ?? r.affectedRows ?? 0; // pg dùng rowCount, PGlite dùng affectedRows
  },
};
