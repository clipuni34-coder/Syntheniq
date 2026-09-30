// Syntheniq — full upload → analyze → clips → export → download flow
// over real HTTP against an ephemeral SYNTHENIQ_DATA.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-e2e-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;

const { ensureFixtures } = await import('./helpers/fixtures.js');
const { buildApp } = await import('../src/server.js');
const { verifyExport } = await import('../src/pipeline/render/index.js');

let base = '';
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let lastJobId: string | null = null;

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

async function api(p: string, opts: RequestInit = {}): Promise<any> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + p, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${p} → ${res.status}: ${(data as any).error || ''}`);
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

test('health reports a working engine', async () => {
  const h = await api('/v1/health');
  assert.equal(h.ok, true);
  assert.equal(h.ffmpeg, true);
  assert.equal(h.ffprobe, true);
  const root = await api('/health');
  assert.equal(root.name, 'Syntheniq API');
});

test('analysis requires an upload first', async () => {
  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'empty' }) });
  const res = await fetch(base + `/v1/projects/${proj.id}/analyze`, { method: 'POST' });
  assert.equal(res.status, 409);
});

test('non-video uploads are rejected', async () => {
  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'bad' }) });
  const form = new FormData();
  form.append('video', new Blob(['not a video']), 'notes.txt');
  const res = await fetch(base + `/v1/projects/${proj.id}/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 400);
});

test('upload → analyze → clips → export → download', async () => {
  const { short } = ensureFixtures();

  const proj = await api('/v1/projects', { method: 'POST', body: JSON.stringify({ name: 'E2E story' }) });
  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(short)], { type: 'video/mp4' }), 'short-30.mp4');
  const upRes = await fetch(base + `/v1/projects/${proj.id}/upload`, { method: 'POST', body: form });
  assert.equal(upRes.status, 201);
  const uploaded = await upRes.json();
  assert.equal(uploaded.status, 'uploaded');
  assert.ok(uploaded.media.probe.duration > 25);

  const { jobId } = await api(`/v1/projects/${proj.id}/analyze`, {
    method: 'POST',
    body: JSON.stringify({ maxClips: 3 }),
  });
  const done = await waitForJob(jobId, 480000);
  assert.equal(done.result.clipCount >= 1, true);
  lastJobId = jobId;

  const after = await api(`/v1/projects/${proj.id}`);
  assert.equal(after.status, 'clips-ready');

  const clipsData = await api(`/v1/projects/${proj.id}/clips`);
  assert.ok(clipsData.clips.length >= 1 && clipsData.clips.length <= 3);
  const clip = clipsData.clips[0];
  assert.deepEqual(Object.keys(clip.scores).sort(), ['curiosity', 'emotion', 'hook', 'payoff', 'standalone', 'visual']);
  assert.ok(clip.total >= 0 && clip.total <= 1);
  assert.ok(clipsData.timeline.waveform.length > 10);

  const detail = await api(`/v1/projects/${proj.id}/clips/${clip.id}`);
  assert.equal(detail.clip.id, clip.id);
  assert.ok(Array.isArray(detail.transcript));

  const exp = await api(`/v1/projects/${proj.id}/clips/${clip.id}/export`, { method: 'POST' });
  const expDone = await waitForJob(exp.jobId, 300000);
  assert.ok(expDone.result.downloadUrl);

  const fileRes = await fetch(base + expDone.result.downloadUrl);
  assert.equal(fileRes.status, 200);
  assert.ok((fileRes.headers.get('content-type') || '').includes('video/mp4'));
  assert.ok((fileRes.headers.get('content-disposition') || '').includes('attachment'));
  const buf = Buffer.from(await fileRes.arrayBuffer());
  assert.ok(buf.length > 100000, `export has real bytes, got ${buf.length}`);

  const v = await verifyExport(path.join(DATA_DIR, 'projects', proj.id, 'clips', clip.id, 'export.mp4'));
  assert.equal(v.ok, true);
  assert.equal(v.details.width, 1080);
  assert.equal(v.details.height, 1920);
});

test('job events stream over SSE', async () => {
  const missing = await fetch(base + '/v1/jobs/does-not-exist/events');
  assert.equal(missing.status, 404);

  assert.ok(lastJobId, 'e2e test ran first and left a finished job');
  const ctrl = new AbortController();
  const res = await fetch(base + `/v1/jobs/${lastJobId}/events`, {
    signal: ctrl.signal,
    headers: { Accept: 'text/event-stream' },
  });
  assert.equal(res.status, 200);
  assert.ok((res.headers.get('content-type') || '').includes('text/event-stream'));
  const reader = res.body!.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (value) text += Buffer.from(value).toString('utf8');
    if (text.includes('data:')) break;
    if (done) break;
  }
  ctrl.abort();
  assert.ok(text.includes('"status":"done"'), `SSE frame carries the job snapshot, got: ${text.slice(0, 200)}`);
});
