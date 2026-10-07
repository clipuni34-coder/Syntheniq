// Syntheniq — persistent job queue semantics: FIFO claiming, leases,
// expiry reclaim, attempt budgets, dedup lookup, failure recording.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-queue-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;

const { JsonStore } = await import('../src/lib/jsonStore.js');

function freshStore(name: string) {
  return new JsonStore(path.join(DATA_DIR, `${name}.json`));
}

test('enqueue → get roundtrip starts queued', async () => {
  const store = freshStore('roundtrip');
  const job = await store.enqueue('analyze', 'Analyze demo', { projectId: 'p1', maxClips: 3 });
  assert.equal(job.status, 'queued');
  assert.equal(job.progress, 0);
  assert.deepEqual((job.meta as any).projectId, 'p1');
  const got = await store.get(job.id);
  assert.equal(got?.id, job.id);
  assert.equal(await store.get('missing'), null);
});

test('claimNext is FIFO and marks jobs running with a lease', async () => {
  const store = freshStore('fifo');
  const a = await store.enqueue('analyze', 'first', { projectId: 'p1' });
  const b = await store.enqueue('analyze', 'second', { projectId: 'p1' });
  const c1 = await store.claimNext('worker-1', 60, 3);
  assert.equal(c1?.id, a.id);
  assert.equal(c1?.leaseOwner, 'worker-1');
  assert.equal(c1?.attempts, 1);
  const c2 = await store.claimNext('worker-2', 60, 3);
  assert.equal(c2?.id, b.id);
  assert.equal(await store.claimNext('worker-3', 60, 3), null);
  const snap = await store.get(a.id);
  assert.equal(snap?.status, 'running');
});

test('a held lease blocks reclaim; expiry releases it with attempts+1', async () => {
  const store = freshStore('lease');
  const job = await store.enqueue('export', 'held', { projectId: 'p1', clipId: 'c1' });
  const first = await store.claimNext('worker-1', 60, 3);
  assert.equal(first?.id, job.id);
  assert.equal(await store.claimNext('worker-2', 60, 3), null);
  assert.equal(await store.renewLease(job.id, 'worker-2', 60), false);
  assert.equal(await store.renewLease(job.id, 'worker-1', 60), true);

  // Simulate a dead worker by claiming with an already-expired lease.
  const store2 = freshStore('expiry');
  const j2 = await store2.enqueue('export', 'orphan', { projectId: 'p1', clipId: 'c1' });
  await store2.claimNext('dead-worker', -1, 3);
  const reclaimed = await store2.claimNext('worker-9', 60, 3);
  assert.equal(reclaimed?.id, j2.id);
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(reclaimed?.leaseOwner, 'worker-9');
});

test('maxAttempts caps reclaim of poison jobs', async () => {
  const store = freshStore('poison');
  const job = await store.enqueue('analyze', 'poison', { projectId: 'p1' });
  await store.claimNext('w1', -1, 1);
  assert.equal(await store.claimNext('w2', 60, 1), null);
  const snap = await store.get(job.id);
  assert.equal(snap?.status, 'running');
});

test('findActive powers idempotent reattach (earliest wins, clip-scoped)', async () => {
  const store = freshStore('active');
  const first = await store.enqueue('export', 'one', { projectId: 'p1', clipId: 'c1' });
  await store.enqueue('export', 'two', { projectId: 'p1', clipId: 'c1' });
  await store.enqueue('export', 'three', { projectId: 'p1', clipId: 'c2' });
  const found = await store.findActive('export', 'p1', 'c1');
  assert.equal(found?.id, first.id);
  const other = await store.findActive('export', 'p1', 'c2');
  assert.equal((other?.meta as any).clipId, 'c2');
  assert.equal(await store.findActive('analyze', 'p1'), null);
  assert.equal(await store.findActive('export', 'nope', 'c1'), null);
  await store.finish(first.id, {});
  const next = await store.findActive('export', 'p1', 'c1');
  assert.notEqual(next?.id, first.id);
});

test('update merges progress/meta; finish and fail record outcomes', async () => {
  const store = freshStore('lifecycle');
  const job = await store.enqueue('analyze', 'life', { projectId: 'p1' });
  await store.update(job.id, { progress: 42, message: 'halfway', meta: { coverage: 0.8 } });
  const mid = await store.get(job.id);
  assert.equal(mid?.progress, 42);
  assert.equal(mid?.message, 'halfway');
  assert.equal((mid?.meta as any).coverage, 0.8);
  assert.equal((mid?.meta as any).projectId, 'p1');

  await store.finish(job.id, { clipCount: 4 });
  const done = await store.get(job.id);
  assert.equal(done?.status, 'done');
  assert.equal(done?.progress, 100);
  assert.equal((done?.result as any).clipCount, 4);

  const bad = await store.enqueue('analyze', 'bad', { projectId: 'p1' });
  await store.fail(bad.id, new Error('boom'));
  const failed = await store.get(bad.id);
  assert.equal(failed?.status, 'error');
  assert.match(failed?.error || '', /boom/);
});

test('queue state survives a process restart (file-backed)', async () => {
  const file = path.join(DATA_DIR, 'restart.json');
  const s1 = new JsonStore(file);
  const job = await s1.enqueue('analyze', 'durable', { projectId: 'p1' });
  await s1.claimNext('w1', 60, 3);
  const s2 = new JsonStore(file);
  const snap = await s2.get(job.id);
  assert.equal(snap?.status, 'running');
  assert.equal(await s2.findActive('analyze', 'p1').then((j) => j?.id), job.id);
});
