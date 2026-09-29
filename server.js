import { createApp } from './lib/app.js';

const env = process.env;
const number = (value, fallback) => (value !== undefined && value !== '' && !Number.isNaN(Number(value)) ? Number(value) : fallback);

const { server, config } = await createApp({
  dataDir: env.DATA_DIR || './data',
  ttlMs: number(env.EXPIRE_HOURS, 24) * 60 * 60 * 1000,
  maxFileBytes: number(env.MAX_FILE_MB, 25) * 1024 * 1024,
  maxTextBytes: number(env.MAX_TEXT_KB, 1024) * 1024,
  rateLimit: number(env.RATE_LIMIT_PER_HOUR, 60),
  trustProxy: env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true',
});

const port = number(env.PORT, 3000);
server.listen(port, () => {
  console.log(`Easy Paste running on http://localhost:${port} (data: ${config.dataDir})`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
