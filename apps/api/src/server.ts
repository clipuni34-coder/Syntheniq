// Syntheniq — API + engine server (Fastify).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import {
  API_ONLY,
  DATA_DIR,
  JOB_LEASE_SEC,
  JOB_MAX_ATTEMPTS,
  MAX_UPLOAD_MB,
  PORT,
  STORAGE_DRIVER,
  WEB_ORIGIN,
  WEB_OUT_DIR,
  WORKER_CONCURRENCY,
  WORKER_POLL_MS,
} from './config.js';
import { ensureDir } from './lib/paths.js';
import { staticRoot } from './lib/static.js';
import { assertProductionStores } from './lib/store.js';
import { closeStore, getStore, storeKind } from './lib/database.js';
import { startWorker } from './lib/jobs.js';
import { getStorage } from './storage/index.js';
import { jobHandlers } from './pipeline/index.js';
import { projectRoutes } from './routes/projects.js';
import { uploadRoutes } from './routes/upload.js';
import { analyzeRoutes } from './routes/analyze.js';
import { jobRoutes } from './routes/jobs.js';
import { clipRoutes } from './routes/clips.js';
import { exportRoutes } from './routes/export.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function readVersion(): Promise<string> {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export async function buildApp() {
  const app = Fastify({ logger: false });

  // Fail fast on misconfigured persistence/storage instead of half-booting.
  await getStore();
  getStorage();

  await app.register(cors, { origin: WEB_ORIGIN || true });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
  });

  app.setErrorHandler((err: any, req, reply) => {
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) {
      console.error('[syntheniq]', err);
    }
    reply.code(status).send({ error: err.message || 'Internal server error' });
  });

  const health = async () => {
    const { hasCommand } = await import('./lib/ffmpeg.js');
    const localWhisper = await import('./pipeline/transcribe/localWhisper.js');
    const [ffmpeg, ffprobe, localStt] = await Promise.all([
      hasCommand('ffmpeg'),
      hasCommand('ffprobe'),
      localWhisper.isAvailable().catch(() => false),
    ]);
    const { OPENAI_API_KEY } = await import('./config.js');
    return {
      ok: true,
      name: 'Syntheniq API',
      version: await readVersion(),
      store: storeKind(),
      storage: getStorage().kind,
      worker: API_ONLY ? 'external' : 'embedded',
      ffmpeg,
      ffprobe,
      transcription: {
        openaiApi: Boolean(OPENAI_API_KEY),
        localWhisper: localStt,
        fallback: true,
      },
    };
  };
  app.get('/health', health);
  app.get('/v1/health', health);

  await projectRoutes(app);
  await uploadRoutes(app);
  await analyzeRoutes(app);
  await jobRoutes(app);
  await clipRoutes(app);
  await exportRoutes(app);

  // Embedded worker: dev and single-node deployments process jobs in-process.
  // Scale-out deployments set API_ONLY=1 and run separate workers (see worker.ts).
  if (!API_ONLY) {
    const worker = startWorker({
      handlers: jobHandlers(),
      concurrency: WORKER_CONCURRENCY,
      pollMs: WORKER_POLL_MS,
      leaseSec: JOB_LEASE_SEC,
      maxAttempts: JOB_MAX_ATTEMPTS,
    });
    app.addHook('onClose', async () => {
      await worker.stop();
      await closeStore();
    });
  } else {
    app.addHook('onClose', async () => {
      await closeStore();
    });
  }

  // Serve the exported web app when it exists (single-command local demo).
  const webIndex = path.join(WEB_OUT_DIR, 'index.html');
  if (fs.existsSync(webIndex)) {
    const serve = staticRoot(WEB_OUT_DIR);
    app.get('/*', async (req, reply) => serve(req, reply));
  } else {
    app.get('/', async () => ({
      name: 'Syntheniq API',
      web: 'Web app not built — run the web dev server or build the static export.',
    }));
  }

  app.setNotFoundHandler(async (req, reply) => {
    const url = req.raw.url || '';
    if (url.startsWith('/v1/') || url.startsWith('/health')) {
      reply.code(404).send({ error: 'Unknown API endpoint' });
      return;
    }
    if (fs.existsSync(webIndex)) {
      const serve = staticRoot(WEB_OUT_DIR);
      return serve(req, reply);
    }
    reply.code(404).send({ error: 'Not found' });
  });

  return app;
}

async function main(): Promise<void> {
  // Never boot production on the file store or local media.
  assertProductionStores();
  ensureDir(DATA_DIR);
  // Jobs persist in the store now: anything queued/running at boot is picked
  // up by the worker (leases recover orphaned claims automatically).
  const app = await buildApp();
  const { OPENAI_API_KEY } = await import('./config.js');
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[syntheniq] api listening on http://0.0.0.0:${PORT}`);
  console.log(
    `[syntheniq] store=${storeKind()} storage=${getStorage().kind} worker=${API_ONLY ? 'external' : 'embedded'} ` +
      `whisper=${OPENAI_API_KEY ? 'openai-api' : 'local-or-fallback'}`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
