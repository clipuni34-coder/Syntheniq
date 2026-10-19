// Syntheniq — API + engine server (Fastify).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { run } from './lib/ffmpeg.js';
import {
  API_ONLY,
  DATA_DIR,
  JOB_LEASE_SEC,
  JOB_MAX_ATTEMPTS,
  MAX_UPLOAD_BYTES,
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
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_UPLOAD_BYTES,
    requestTimeout: 0,
    handlerTimeout: 0,
  });

  // Override server-level timeouts directly on the HTTP server.
  // Fastify's config validator does NOT properly apply keepAliveTimeout: 0
  // (it falls back to the 72s default), which kills long uploads with >72s
  // data gaps → browser sees xhr.onerror ("network error").
  const _srv = app.server as any;
  _srv.requestTimeout = 0;
  _srv.keepAliveTimeout = 0;
  _srv.headersTimeout = 0;

  // Fail fast on misconfigured persistence/storage instead of half-booting.
  await getStore();
  getStorage();

  // Safari's media engine treats cross-origin video requests as tainted when
  // credentials are in play. credentials: false lets the wildcard origin
  // reflect work for <video>/src loads without opaque-blocking the body.
  await app.register(cors, { origin: WEB_ORIGIN || true, credentials: false });
  await app.register(multipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  });

    // Fastify 5 returns 415 "Unsupported media type" when a POST/PATCH/PUT
    // request arrives without a Content-Type header — or with a content-type
    // it can't parse (e.g. `curl -X POST ...` without `-H`, or a bodyless
    // fetch() through Cloudflare Tunnel which injects an unknown content-type).
    // Normalise to application/json so route handlers always receive a
    // parseable body.  For bodyless requests we substitute `{}` via the
    // preParsing hook below, so the JSON parser never sees an empty stream.
    //
    // IMPORTANT: this runs as an `onRequest` hook, NOT `preHandler`, because
    // Fastify parses the body (and throws 415 for unknown content-types) *before*
    // `preHandler` in the request lifecycle.  onRequest runs first, so the
    // normalised content-type is seen by the body parser.
    app.addHook('onRequest', async (req, reply) => {
      const ct = String(req.headers['content-type'] || '').trim().toLowerCase();
      if (['post', 'patch', 'put'].includes(req.method.toLowerCase())) {
        // Skip multipart — the multipart plugin owns that parsing.
        if (ct.startsWith('multipart/')) return;
        // Missing or empty content-type → default to JSON (including bodyless
        // requests; the preParsing hook will supply `{}` as needed).
        if (ct === '' || ct === 'application/json; charset=utf-8') {
          req.headers['content-type'] = 'application/json';
          return;
        }
        // Downgrade everything except:
        // - text/plain (Fastify's only built-in non-JSON parser)
        // Other text/* types (text/html, text/csv) and unknown content-types
        // have no registered parser and Fastify 5 throws 415.
        if (ct !== 'text/plain') {
          req.headers['content-type'] = 'application/json';
        }
      }
    });

    // Substitute `{}` for empty JSON bodies so Fastify's JSON parser doesn't
    // throw "Body cannot be empty when content-type is application/json".
    // This handles bodyless POSTs (e.g., export trigger) coming through Cloudflare
    // Tunnel, which may inject a content-type on empty-bodied requests.
    app.addHook('preParsing', async (req, reply, payload) => {
      const ct = String(req.headers['content-type'] || '').trim().toLowerCase();
      if (ct.startsWith('application/json')) {
        if (!payload) {
          return Readable.from([Buffer.from('{}', 'utf8')]);
        }
        if (typeof payload === 'string' && payload.trim() === '') {
          return Readable.from([Buffer.from('{}', 'utf8')]);
        }
        if (Buffer.isBuffer(payload) && payload.length === 0) {
          return Readable.from([Buffer.from('{}', 'utf8')]);
        }
        if (typeof payload.pipe === 'function' && !Buffer.isBuffer(payload) && typeof payload !== 'string') {
          const chunks: Buffer[] = [];
          for await (const chunk of payload) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          if (body.length === 0) {
            return Readable.from([Buffer.from('{}', 'utf8')]);
          }
          return Readable.from([body]);
        }
      }
      return payload;
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
  // Ensure local Whisper is available for offline transcription.
  // Installed at build time via requirements.txt; this ensures the runtime
  // can import faster_whisper even on a bare `node --import tsx` start.
  await ensureWhisper();
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

async function ensureWhisper(): Promise<void> {
  try {
    await run('python3', ['-c', 'import faster_whisper'], { timeoutMs: 5000 });
  } catch {
    // faster_whisper not yet installed — attempt a non-fatal install in the
    // background so the server still boots.  Transcription gracefully falls
    // back to the energy-based provider if this fails.
    console.log('[syntheniq] installing faster-whisper for offline transcription…');
    await run('pip3', ['install', '--break-system-packages', '-q', '-r', path.join(here, '..', 'requirements.txt')], { timeoutMs: 1000 * 60 * 5 }).catch((e) => {
      console.warn('[syntheniq] faster-whisper install skipped:', (e as Error).message);
    });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
