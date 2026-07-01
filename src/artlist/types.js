/**
 * @typedef {Object} GenerateParams
 * @property {string} prompt          Mô tả cảnh cần tạo
 * @property {string} [image]         URL ảnh (cho image-to-video), tuỳ chọn
 * @property {string} [model]         Mặc định 'seedance-2'
 * @property {number} [duration]      Độ dài (giây)
 * @property {string} [aspectRatio]   '16:9' | '9:16' | '1:1' ...
 * @property {string} [resolution]    '720p' | '1080p' ...
 * @property {boolean} [generateAudio] Tạo kèm audio (settings.generate_audio)
 * @property {number} [modelId]       ID model artlist (vd 2524 = Seedance)
 */

/**
 * @typedef {'pending'|'processing'|'done'|'failed'} JobStatus
 */

/**
 * @typedef {Object} Job
 * @property {string} id                 jobId nội bộ của bạn
 * @property {string} [providerJobId]    jobId phía artlist
 * @property {JobStatus} status
 * @property {number} [progress]         0..100
 * @property {GenerateParams} params
 * @property {string} [videoUrl]
 * @property {string} [error]
 * @property {number} createdAt
 * @property {number} updatedAt
 */

export {};
