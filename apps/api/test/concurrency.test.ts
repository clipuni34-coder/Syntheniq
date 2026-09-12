// Syntheniq — concurrent analyses: two projects analyzed at once both
// finish correctly, and a duplicate analyze reattaches to the live job.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-conc-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;

const { ensureFixtures } = await import('./helpers/fixtures.js');
const { buildApp } = await import('../src/server.js');

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

async function waitForJob(jobId: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  for (;;) {
    const job = await api(`/v1/jobs/${jobId}`);
    if (job.status === 'done') return job;
    if (job.status === 'error') throw new Error(`job ${jobId} failed: ${job.error}`);
    if (Date.now() - start > timeoutMs) throw new Error(`job ${jobId} timed out: ${job.message}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function makeProjectWithVideo(name: string, file: string): Promise<string> {
  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name }) });
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(file)]), path.basename(file));
  const up = await fetch(base + `/v1/projects/${proj.id}/upload`, { method: 'POST', body: form });
  assert.equal(up.status, 201);
  return proj.id as string;
}

test('two analyses started together both complete with isolated results', async () => {
  const { short } = ensureFixtures();
  const [idA, idB] = await Promise.all([
    makeProjectWithVideo('conc-a', short),
    makeProjectWithVideo('conc-b', short),
  ]);
  const [jobA, jobB] = await Promise.all([
    api(`/v1/projects/${idA}/analyze`, { method: 'POST', body: JSON.stringify({ maxClips: 2 }) }),
    api(`/v1/projects/${idB}/analyze`, { method: 'POST', body: JSON.stringify({ maxClips: 2 }) }),
  ]);
  assert.notEqual(jobA.jobId, jobB.jobId);
  const [doneA, doneB] = await Promise.all([
    waitForJob(jobA.jobId, 420000),
    waitForJob(jobB.jobId, 420000),
  ]);
  assert.equal(doneA.status, 'done');
  assert.equal(doneB.status, 'done');
  const [projA, projB] = await Promise.all([
    api(`/v1/projects/${idA}`),
    api(`/v1/projects/${idB}`),
  ]);
  assert.equal(projA.status, 'clips-ready');
  assert.equal(projB.status, 'clips-ready');
  const [clipsA, clipsB] = await Promise.all([
    api(`/v1/projects/${idA}/clips`),
    api(`/v1/projects/${idB}/clips`),
  ]);
  assert.ok(clipsA.clips.length > 0);
  assert.ok(clipsB.clips.length > 0);
  assert.equal(clipsA.projectId, idA);
  assert.equal(clipsB.projectId, idB);
});

test('duplicate analyze reattaches to the live job instead of double-processing', async () => {
  const { short } = ensureFixtures();
  const id = await makeProjectWithVideo('conc-dup', short);
  const first = await api(`/v1/projects/${id}/analyze`, { method: 'POST', body: JSON.stringify({}) });
  const second = await api(`/v1/projects/${id}/analyze`, { method: 'POST', body: JSON.stringify({}) });
  assert.equal(second.jobId, first.jobId);
  const done = await waitForJob(first.jobId, 420000);
  assert.equal(done.status, 'done');
});
