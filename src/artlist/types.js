/**
 * @typedef {Object} GenerateParams
 * @property {string} prompt          Mô tả cảnh cần tạo
 * @property {string} [image]         URL ảnh (cho image-to-video), tuỳ chọn
 * @property {string} [model]         Mặc định 'seedance-2'
 * @property {number} [duration]      Độ dài (giây)
 * @property {string} [aspectRatio]   '16:9' | '9:16' | '1:1' ...
 * @property {string} [resolution]    '720p' | '1080p' ...
 * @property {boolean} [generateAudio] Tạo kèm audio (settings.generate_audio)
 * @property {number} [modelId]       ID model cụ thể (vd 2524 = Seedance 2.0 T2V 720p)
 * @property {number} [modelGroupId]  ID group model (vd 358 = Seedance 2.0) — dùng cho QUOTE
 * @property {string} [chatSessionId] ID phiên/project. ⚠️ BẮT BUỘC cho create.
 *                                    Nguồn gốc chưa rõ (client tự sinh UUIDv7 hay có request tạo?) — cần xác nhận.
 * @property {any[]}  [artifacts]     Tệp đính kèm (ảnh cho image-to-video), mặc định []
 * @property {string} [generationMethod] 'credits' | ... (mặc định 'credits')
 */

/**
 * Kết quả cost quote — do server artlist ký, đính kèm khi create.
 * @typedef {Object} QuoteResult
 * @property {number} price                     Giá (credits), phải khớp chữ ký
 * @property {number} timestamp                 Mốc thời gian, phải khớp chữ ký
 * @property {string} costQuoteDigitalSignature JWT (HS256) ký bởi server — KHÔNG tự chế được
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
