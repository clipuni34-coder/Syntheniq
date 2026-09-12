// Syntheniq — API + engine server (Fastify).
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { DATA_DIR, MAX_UPLOAD_MB, PORT, STORAGE_DRIVER, WEB_ORIGIN, WEB_OUT_DIR } from './config.js';
import { ensureDir } from './lib/paths.js';
import { staticRoot } from './lib/static.js';
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
      storage: STORAGE_DRIVER,
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
  ensureDir(DATA_DIR);
  // Jobs are in-process: anything marked "analyzing" at boot is stale from a
  // previous run. Drop the dead job pointer so the studio shows the honest
  // "interrupted — retry" state instead of hanging.
  try {
    const db = await import('./lib/db.js');
    let cleared = 0;
    for (const p of db.listProjects()) {
      if (p.status === 'analyzing') {
        await db.updateProject(p.id, { activeJob: null });
        cleared++;
      }
    }
    if (cleared) console.log(`[syntheniq] cleared ${cleared} stale analyzing flag(s)`);
  } catch (err) {
    console.error('[syntheniq] boot cleanup failed', err);
  }
  const app = await buildApp();
  const { OPENAI_API_KEY } = await import('./config.js');
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`[syntheniq] api listening on http://0.0.0.0:${PORT}`);
  console.log(
    `[syntheniq] storage=${STORAGE_DRIVER} whisper=${OPENAI_API_KEY ? 'openai-api' : 'local-or-fallback'}`
  );
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
