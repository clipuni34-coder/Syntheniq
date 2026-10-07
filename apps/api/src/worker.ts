// Syntheniq — standalone worker entrypoint.
//
// Production topology: N API replicas (API_ONLY=1) + M workers, all sharing
// Postgres (jobs) and R2 (media). Run with: `node dist/worker.js`
// (dev: `npm run worker --workspace @syntheniq/api`).
import 'dotenv/config';
import {
  DATA_DIR,
  JOB_LEASE_SEC,
  JOB_MAX_ATTEMPTS,
  WORKER_CONCURRENCY,
  WORKER_POLL_MS,
} from './config.js';
import { assertProductionStores } from './lib/store.js';
import { closeStore, getStore, storeKind } from './lib/database.js';
import { startWorker } from './lib/jobs.js';
import { ensureDir } from './lib/paths.js';
import { getStorage } from './storage/index.js';
import { jobHandlers } from './pipeline/index.js';

async function main(): Promise<void> {
  assertProductionStores();
  ensureDir(DATA_DIR);
  await getStore();
  getStorage(); // validates R2 config eagerly
  const worker = startWorker({
    handlers: jobHandlers(),
    concurrency: WORKER_CONCURRENCY,
    pollMs: WORKER_POLL_MS,
    leaseSec: JOB_LEASE_SEC,
    maxAttempts: JOB_MAX_ATTEMPTS,
  });
  console.log(
    `[syntheniq] worker ${worker.id} started (store=${storeKind()} storage=${getStorage().kind} ` +
      `concurrency=${WORKER_CONCURRENCY})`
  );
  const shutdown = async (signal: string) => {
    console.log(`[syntheniq] worker ${worker.id} received ${signal} — draining…`);
    try {
      await worker.stop();
      await closeStore();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
