/**
 * Lưu job trong bộ nhớ (Map). Đủ dùng cho cá nhân; nâng cấp SQLite ở Phase 6 nếu cần
 * bền vững qua restart. API giữ nguyên để đổi backend không ảnh hưởng nơi gọi.
 */
class JobStore {
  constructor() {
    /** @type {Map<string, import('../artlist/types.js').Job>} */
    this.jobs = new Map();
    this._seq = 0;
  }

  _nextId() {
    // ID tăng dần + hậu tố để tránh trùng; không dùng Date.now/random để đơn giản & test được.
    this._seq += 1;
    return `job_${this._seq.toString(36)}${this._seq}`;
  }

  /**
   * @param {import('../artlist/types.js').GenerateParams} params
   * @param {number} now timestamp (ms) truyền từ ngoài vào
   */
  create(params, now) {
    const id = this._nextId();
    /** @type {import('../artlist/types.js').Job} */
    const job = { id, status: 'pending', params, createdAt: now, updatedAt: now };
    this.jobs.set(id, job);
    return job;
  }

  get(id) {
    return this.jobs.get(id) ?? null;
  }

  /**
   * @param {string} id
   * @param {Partial<import('../artlist/types.js').Job>} patch
   * @param {number} now
   */
  update(id, patch, now) {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: now });
    return job;
  }

  list() {
    return [...this.jobs.values()];
  }

  /** Đếm job đang chạy (để giới hạn concurrency). */
  countActive() {
    let n = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'pending' || j.status === 'processing') n += 1;
    }
    return n;
  }
}

export const jobStore = new JobStore();
