export const env = {
  port: Number(process.env.PORT ?? 3000),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017',
  mongoDb: process.env.MONGO_DB || 'mydatabase',
  worker: {
    enabled: (process.env.WORKER_ENABLED ?? 'true') === 'true',
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 800),
    leaseMs: Number(process.env.WORKER_LEASE_MS ?? 30_000),
    pollMs: Number(process.env.WORKER_POLL_MS ?? 500),
    processingMs: Number(process.env.PROCESSING_MS ?? 5_000),
  },
};