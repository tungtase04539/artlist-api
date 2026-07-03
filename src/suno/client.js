import { config } from '../config.js';
import { fetchWithRetry, HttpError } from '../lib/http.js';
import { logEvent } from '../lib/events.js';

/**
 * Lớp gọi nhà cung cấp AI33 (api.ai33.pro) để tạo nhạc Suno — reseller.
 * Xác thực bằng header `xi-api-key`. Luồng async: create -> {task_id} -> poll GET /v1/task/{id}.
 * Mọi HTTP đi qua `call()` để tập trung auth + log + xử lý lỗi.
 */

export function isEnabled() {
  return Boolean(config.AI33_API_KEY);
}

function assertEnabled() {
  if (!config.AI33_API_KEY) throw new HttpError('Tính năng tạo nhạc chưa bật (thiếu AI33_API_KEY)', 503);
}

async function call({ path, method = 'GET', body }) {
  assertEnabled();
  const url = `${config.AI33_BASE_URL}${path}`;
  const started = Date.now();
  const res = await fetchWithRetry(url, {
    method,
    headers: {
      'xi-api-key': config.AI33_API_KEY,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  logEvent({
    level: res.ok ? 'info' : res.status >= 500 ? 'error' : 'warn',
    category: 'suno', event: `${method} ${path}`, method, statusCode: res.status, durationMs: Date.now() - started,
    ...(res.ok ? {} : { message: text.slice(0, 200) }),
  }).catch(() => {});

  if (!res.ok) throw new HttpError(`AI33 trả về HTTP ${res.status}`, res.status, text);
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { _raw: text };
  }
}

/**
 * Tạo task nhạc Suno.
 * @param {{mode:'simple'|'custom', prompt?, instrumental?, title?, lyrics?, tags?, vocalGender?}} p
 * @returns {Promise<{taskId:string, remainCredits?:string, raw:any}>}
 */
export async function createMusic(p) {
  const body = p.mode === 'custom'
    ? {
        create_mode: 'custom',
        ...(p.title ? { title: p.title } : {}),
        ...(p.lyrics ? { lyrics: p.lyrics } : {}),
        ...(p.tags ? { tags: p.tags } : {}),
        ...(p.vocalGender ? { vocal_gender: p.vocalGender } : {}),
      }
    : {
        create_mode: 'simple',
        gpt_description_prompt: p.prompt,
        make_instrumental: Boolean(p.instrumental),
      };
  const raw = await call({ path: '/v1s/task/music-generation', method: 'POST', body });
  const taskId = raw.task_id || raw.id || raw.data?.task_id;
  if (!taskId) throw new HttpError('Response tạo nhạc không có task_id', 502, JSON.stringify(raw).slice(0, 300));
  return { taskId, remainCredits: raw.ec_remain_credits, raw };
}

/**
 * Hỏi trạng thái 1 task (Suno hoặc bất kỳ task AI33 nào) và chuẩn hoá.
 * status upstream: doing | done | (error khi có error_message).
 */
export async function getTask(taskId) {
  const raw = await call({ path: `/v1/task/${encodeURIComponent(taskId)}` });
  return normalizeTask(raw);
}

/** Số dư credits còn lại ở nhà cung cấp AI33 (để admin theo dõi vốn). */
export async function providerCredits() {
  return call({ path: '/v1/credits' });
}

/** Chuẩn hoá task AI33 -> {status, audioUrl, audioUrls, imageUrl, title, duration, error, raw}. */
export function normalizeTask(raw) {
  const m = raw?.metadata || {};
  const clips = m.suno_result?.clips || [];
  const audioUrls = (Array.isArray(m.all_audio_urls) && m.all_audio_urls.length
    ? m.all_audio_urls
    : clips.map((c) => c.audio_url)).filter(Boolean);
  const s = String(raw?.status || '').toLowerCase();
  const failed = ['error', 'failed', 'fail'].includes(s) || (raw?.error_message && s !== 'done' && s !== 'doing');
  const status = s === 'done' ? 'done' : failed ? 'failed' : 'processing';
  const streamClips = m.suno_stream_result?.clips || [];
  return {
    status,
    audioUrl: m.audio_url || audioUrls[0] || null,
    audioUrls,
    imageUrl: m.image_url || m.cover_url || clips[0]?.image_url || null,
    title: m.title || clips[0]?.title || null,
    duration: clips[0]?.duration ?? null,
    progress: raw?.progress ?? null,
    streamUrl: m.stream_url || streamClips[0]?.stream_url || null, // preview khi đang xử lý
    error: raw?.error_message || (failed ? 'AI33 task failed' : null),
    raw,
  };
}
