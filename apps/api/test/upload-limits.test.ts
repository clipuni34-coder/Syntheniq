// Syntheniq — oversized uploads are rejected with 413 before any work happens.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-limits-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;
process.env.MAX_UPLOAD_MB = '1';

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

test('a file over MAX_UPLOAD_MB gets 413 with the limit in the message', async () => {
  const { short } = ensureFixtures();
  assert.ok(fs.statSync(short).size > 1024 * 1024, 'fixture must exceed the 1 MB test limit');

  const created = await fetch(base + '/v1/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'too big' }),
  });
  const proj = (await created.json()) as { id: string };

  const form = new FormData();
  form.append('video', new Blob([fs.readFileSync(short)]), 'short.mp4');
  const res = await fetch(base + `/v1/projects/${proj.id}/upload`, { method: 'POST', body: form });
  assert.equal(res.status, 413);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /1 MB/);

  const after = (await (await fetch(base + `/v1/projects/${proj.id}`)).json()) as { status: string };
  assert.equal(after.status, 'created');
});
