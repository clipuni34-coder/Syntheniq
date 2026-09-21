import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomUUID, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, access, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { DATA_DIR, PASSWORD, PORT, WEB_OUT_DIR, loadAiConfig } from './config.js';
import { isProjectId, listProjects, loadJob, newJobState, projectDir, saveJob } from './store.js';
import { cancelPipeline, getActiveJob, startPipeline } from './jobs.js';
import { AiRouter } from './ai/router.js';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });

await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });
await app.register(cookie, { secret: randomBytes(32).toString('hex') });

const AUTH_TOKENS = new Set<string>();

function authRequired(): boolean {
  return PASSWORD.length > 0;
}

async function isAuthorized(req: any): Promise<boolean> {
  const token: string | undefined = req.cookies?.syntheniq_token;
  return Boolean(token && AUTH_TOKENS.has(token));
}

// ── auth gate (single passcode, personal use — not user accounts) ──────
app.addHook('onRequest', async (req, reply) => {
  if (!authRequired()) return;
  if (req.method === 'OPTIONS') return;
  const p = req.url.split('?')[0];
  if (!p.startsWith('/v1')) return; // web UI itself stays reachable
  if (p === '/v1/auth' || p === '/v1/config') return;
  if (!(await isAuthorized(req))) {
    return reply.code(401).send({ error: 'passcode required' });
  }
});

// ── public ─────────────────────────────────────────────────────────────
app.get('/health', async () => ({ ok: true, name: 'Syntheniq API' }));
app.get('/v1/health', async () => ({ ok: true, name: 'Syntheniq API' }));

app.get('/v1/config', async (req) => {
  const cfg = loadAiConfig();
  const router = new AiRouter(cfg, () => {}, null);
  return {
    authRequired: authRequired(),
    authorized: await isAuthorized(req),
    ai: router.status(),
    whisperModel: process.env.SYNTHENIQ_WHISPER_MODEL || 'small',
  };
});

app.post('/v1/auth', async (req, reply) => {
  const body = (req.body ?? {}) as { password?: string };
  if (body.password === PASSWORD && PASSWORD) {
    const token = randomBytes(24).toString('hex');
    AUTH_TOKENS.add(token);
    reply.setCookie('syntheniq_token', token, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
    return { ok: true };
  }
  return reply.code(401).send({ error: 'wrong passcode' });
});

// ── projects ───────────────────────────────────────────────────────────
app.get('/v1/projects', async () => {
  return { projects: await listProjects() };
});

app.post('/v1/projects', async () => {
  const id = randomUUID();
  const job = newJobState(id);
  await saveJob(job);
  return { id, status: job.status };
});

app.post('/v1/projects/:projectId/upload', async (req, reply) => {
  const projectId = (req.params as any).projectId;
  if (!isProjectId(projectId)) return reply.code(400).send({ error: 'invalid project id' });
  const job = await loadJob(projectId);
  if (!job) return reply.code(404).send({ error: 'project not found' });
  if (job.status === 'running') return reply.code(409).send({ error: 'job already running' });

  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'video file required (field name: "file")' });
  const dir = projectDir(projectId);
  await mkdir(dir, { recursive: true });
  const ext = path.extname(file.filename || 'video.mp4') || '.mp4';
  const name = `source${ext}`;
  const output = path.join(dir, name);
  await pipeline(file.file, createWriteStream(output));
  const size = (await stat(output)).size;
  if (size < 100_000) {
    return reply.code(400).send({ error: 'file too small — not a valid video' });
  }
  job.status = 'running';
  await saveJob(job);
  app.log.info(`upload: ${projectId} ${file.filename} (${(size / 1e6).toFixed(1)}MB) — starting pipeline`);
  startPipeline(projectId).catch((e) => app.log.error(`pipeline start failed: ${e.message}`));
  return { projectId, file: name, size, status: 'processing' };
});

app.get('/v1/projects/:projectId', async (req, reply) => {
  const projectId = (req.params as any).projectId;
  if (!isProjectId(projectId)) return reply.code(400).send({ error: 'invalid project id' });
  const job = await loadJob(projectId);
  if (!job) return reply.code(404).send({ error: 'project not found' });
  const activeJob = getActiveJob(projectId);
  return { ...job, running: Boolean(activeJob), cancelRequested: activeJob?.cancelRequested ?? false };
});

app.post('/v1/projects/:projectId/retry', async (req, reply) => {
  const projectId = (req.params as any).projectId;
  if (!isProjectId(projectId)) return reply.code(400).send({ error: 'invalid project id' });
  const job = await loadJob(projectId);
  if (!job) return reply.code(404).send({ error: 'project not found' });
  if (!['error', 'interrupted', 'cancelled', 'done'].includes(job.status)) {
    return reply.code(409).send({ error: `job status is ${job.status}` });
  }
  job.status = 'running';
  job.error = undefined;
  await saveJob(job);
  startPipeline(projectId).catch((e) => app.log.error(`retry start failed: ${e.message}`));
  return { ok: true, status: 'running' };
});

app.post('/v1/projects/:projectId/cancel', async (req, reply) => {
  const projectId = (req.params as any).projectId;
  if (!isProjectId(projectId)) return reply.code(400).send({ error: 'invalid project id' });
  const ok = await cancelPipeline(projectId);
  return ok ? { ok: true } : reply.code(409).send({ error: 'not running' });
});

app.post('/v1/projects/:projectId/clips/:clipId/variants', async (req, reply) => {
  const { projectId, clipId } = req.params as any;
  if (!isProjectId(projectId) || !/^[a-zA-Z0-9-]{3,40}$/.test(clipId)) {
    return reply.code(400).send({ error: 'invalid id' });
  }
  const job = await loadJob(projectId);
  if (!job) return reply.code(404).send({ error: 'project not found' });
  if (job.status !== 'done') return reply.code(409).send({ error: 'project still processing' });
  const clip = job.clips.find((c) => c.id === clipId);
  if (!clip || clip.status !== 'done') return reply.code(409).send({ error: 'clip not ready' });
  const body = (req.body ?? {}) as { hookText?: string };
  const hookText = (body.hookText || '').trim().slice(0, 80);
  if (!hookText) return reply.code(400).send({ error: 'hookText required' });
  if (clip.variant && clip.variant.status === 'rendering') return reply.code(409).send({ error: 'variant already rendering' });

  clip.variant = { hookText, title: clip.title, status: 'rendering' };
  await saveJob(job);
  const { renderVariant } = await import('./pipeline/variant.js');
  renderVariant(projectDir(projectId), clipId, hookText, job)
    .then(async () => {
      job.logs.push({ t: new Date().toISOString(), level: 'info', msg: `[variant] ${clipId} completed` });
      job.logs = job.logs.slice(-400);
      await saveJob(job);
    })
    .catch(async (e) => {
      clip.variant = { hookText, title: clip.title, status: 'error' };
      job.logs.push({ t: new Date().toISOString(), level: 'error', msg: `[variant] ${clipId} failed: ${(e as Error).message}` });
      job.logs = job.logs.slice(-400);
      await saveJob(job);
    });
  return { ok: true, clipId, variant: 'rendering' };
});

// ── files (mp4 / jpg / json) ───────────────────────────────────────────
app.get('/v1/projects/:projectId/files/:name', async (req, reply) => {
  const { projectId, name } = req.params as any;
  if (!isProjectId(projectId) || !/^[A-Za-z0-9._-]{1,120}$/.test(name)) {
    return reply.code(400).send({ error: 'invalid path' });
  }
  const file = path.join(projectDir(projectId), 'files', name);
  try {
    await access(file);
  } catch {
    return reply.code(404).send({ error: 'file not found' });
  }
  const disposition = name.endsWith('.json') ? 'inline' : 'attachment';
  const mime = name.endsWith('.mp4')
    ? 'video/mp4'
    : name.endsWith('.jpg')
      ? 'image/jpeg'
      : name.endsWith('.json')
        ? 'application/json'
        : 'application/octet-stream';
  const friendly = name.replace(/_meta\.json$/, '.json');
  reply.header('content-type', mime);
  if (disposition === 'attachment') reply.header('content-disposition', `attachment; filename="${friendly}"`);
  return reply.send(await import('node:fs/promises').then((m) => m.readFile(file)));
});

// ── web (static export) ────────────────────────────────────────────────
try {
  await access(WEB_OUT_DIR);
  await app.register(fastifyStatic, {
    root: WEB_OUT_DIR,
    index: 'index.html',
    decorateReply: false,
  });
  app.setNotFoundHandler(async (req, reply) => {
    const p = req.url.split('?')[0];
    if (p.startsWith('/v1')) return reply.code(404).send({ error: 'not found' });
    if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    // deep links: /project → project.html (Next.js static export pages)
    if (p !== '/' && p !== '' && !p.includes('..')) {
      const fsP = await import('node:fs/promises');
      for (const cand of [path.join(WEB_OUT_DIR, `${p}.html`), path.join(WEB_OUT_DIR, p, 'index.html')]) {
        try {
          await fsP.access(cand);
          reply.header('content-type', 'text/html');
          return reply.send(await fsP.readFile(cand));
        } catch {
          /* try next candidate */
        }
      }
    }
    try {
      await access(path.join(WEB_OUT_DIR, 'index.html'));
      reply.header('content-type', 'text/html');
      return reply.send(await import('node:fs/promises').then((m) => m.readFile(path.join(WEB_OUT_DIR, 'index.html'))));
    } catch {
      return reply
        .code(200)
        .header('content-type', 'text/html')
        .send(
          `<html><body style="font-family:system-ui;background:#070809;color:#f5f7f8;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h2>Syntheniq API is running</h2><p>Web build not found (expected at ${WEB_OUT_DIR}). Run <code>npm run build:web</code> first.</p></div></body></html>`,
        );
    }
  });
} catch {
  app.log.warn(`web out dir not found at ${WEB_OUT_DIR} — API only mode`);
}

// ── startup reconcile (crash-consistency) ──────────────────────────────
// If the server died mid-job, its persisted state still says
// running/cancelling. Mark those orphans 'interrupted' ONCE at boot so the
// UI shows "Paused — resume ready" and POST /retry can resume from the last
// completed stage (intermediate artifacts are persisted on disk). This must
// happen at startup only — NOT inside hydrateJob (that misfired on fresh
// uploads whose job legitimately starts running).
{
  const orphans = await listProjects();
  for (const summary of orphans) {
    const state = await loadJob(summary.id);
    if (state && (state.status === 'running' || state.status === 'cancelling')) {
      const orphaned = state.status;
      state.status = 'interrupted';
      state.error = 'interrupted by server restart — retry resumes from the last completed stage';
      await saveJob(state);
      app.log.info(`startup: ${state.id} marked interrupted (orphaned ${orphaned})`);
    }
  }
}

app.listen({ port: PORT, host: '0.0.0.0' });
