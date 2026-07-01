import pino from 'pino';

/**
 * Logger dùng chung. Redact các field nhạy cảm để KHÔNG BAO GIỜ log full cookie/token.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: [
      'cookie',
      'authorization',
      'headers.cookie',
      'headers.authorization',
      '*.cookie',
      '*.authorization',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino/file', options: { destination: 1 } },
});
