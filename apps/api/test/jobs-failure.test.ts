// Syntheniq — failed jobs: the error surfaces on the job AND the project,
// and the project is retryable (no stuck activeJob).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-jobfail-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;

const { ensureFixtures } = await import('./helpers/fixtures.js');
const { buildApp } = await import('../src/server.js');
const p = await import('../src/lib/paths.js');

let base = '';
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

test.before(async () => {
  app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  base = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  if (app) await app.close();
});

async function api(url: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${url} → ${res.status}: ${(data as any).error || ''}`);
  return data;
}

async function waitTerminal(jobId: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  for (;;) {
    const job = await api(`/v1/jobs/${jobId}`);
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} timed out`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

test('analysis with a missing source file fails the job with a clear error', async () => {
  const { short } = ensureFixtures();
  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'doomed' }) });
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(short)]), 'short.mp4');
  const up = await fetch(base + `/v1/projects/${proj.id}/upload`, { method: 'POST', body: form });
  assert.equal(up.status, 201);
  const uploaded = (await up.json()) as { media: { filename: string } };

  // Simulate storage loss between upload and analysis.
  fs.rmSync(p.sourceFile(proj.id, uploaded.media.filename));

  const started = await api(`/v1/projects/${proj.id}/analyze`, { method: 'POST', body: JSON.stringify({}) });
  const job = await waitTerminal(started.jobId, 60000);
  assert.equal(job.status, 'error');
  assert.match(job.error as string, /missing from storage/);

  const project = await api(`/v1/projects/${proj.id}`);
  assert.equal(project.status, 'error');
  assert.equal(project.activeJob, null);
  assert.ok((project.notes as string[]).some((n) => n.includes('missing from storage')));
});

test('exporting an unknown clip is a sync 404, not a poisoned job', async () => {
  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'noclips' }) });
  fs.mkdirSync(path.dirname(p.analysisPath(proj.id)), { recursive: true });
  fs.writeFileSync(p.analysisPath(proj.id), JSON.stringify({ projectId: proj.id, clips: [] }));
  const res = await fetch(base + `/v1/projects/${proj.id}/clips/clip-99/export`, { method: 'POST' });
  assert.equal(res.status, 404);
  const after = await api(`/v1/projects/${proj.id}`);
  assert.ok(after.activeJob == null);
});
