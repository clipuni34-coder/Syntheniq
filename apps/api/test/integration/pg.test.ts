// Syntheniq — REAL Postgres verification (not a mock).
// Requires TEST_DATABASE_URL (default: local syntheniq_test); skips cleanly
// when Postgres is unreachable. Proves: atomic multi-worker claims (each job
// claimed exactly once under race), lease expiry, and project persistence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.SYNTHENIQ_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-pgint-'));
const DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgres://postgres@127.0.0.1:5432/syntheniq_test';

const { PgStore } = await import('../../src/lib/pgStore.js');

let store: InstanceType<typeof PgStore> | null = null;
let available = false;

// Probing runs at load (before test definitions) so `skip` is accurate.
try {
  store = await PgStore.connect(DATABASE_URL);
  await (store as unknown as { db: { query(t: string): Promise<unknown> } }).db.query(
    'TRUNCATE jobs, projects'
  );
  available = true;
} catch (err) {
  console.log(`[pg-integration] skipping — Postgres unreachable (${(err as Error).message})`);
}

test.after(async () => {
  if (store) await store.close();
});

function must(): InstanceType<typeof PgStore> {
  assert.ok(store, 'Postgres unavailable');
  return store as InstanceType<typeof PgStore>;
}

test('two racing workers claim every job exactly once', { skip: !available } as never, async () => {
  const s = must();
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    const j = await s.enqueue('analyze', `race-${i}`, { projectId: `race-p${i}` });
    ids.push(j.id);
  }
  const claimed: string[] = [];
  const drain = async (owner: string) => {
    for (;;) {
      const c = await s.claimNext(owner, 60, 3);
      if (!c) return;
      if (!ids.includes(c.id)) return; // another test's job — leave it alone
      claimed.push(c.id);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  await Promise.all([drain('race-w1'), drain('race-w2')]);
  assert.deepEqual([...claimed].sort(), [...ids].sort());
});

test('expired leases are reclaimed with attempts incremented', { skip: !available } as never, async () => {
  const s = must();
  const job = await s.enqueue('export', 'lease-int', { projectId: 'lease-p', clipId: 'c1' });
  const first = await s.claimNext('short-worker', 1, 3);
  assert.equal(first?.id, job.id);
  assert.equal(first?.attempts, 1);
  assert.equal(await s.claimNext('other', 60, 3).then((c) => (c && c.id === job.id ? c.id : 'other-job')), 'other-job');
  await new Promise((r) => setTimeout(r, 1400));
  const reclaimed = await s.claimNext('second-worker', 60, 3);
  assert.equal(reclaimed?.id, job.id);
  assert.equal(reclaimed?.attempts, 2);
  assert.equal(await s.renewLease(job.id, 'intruder', 60), false);
  assert.equal(await s.renewLease(job.id, 'second-worker', 60), true);
  await s.finish(job.id, { ok: true });
});

test('projects persist across store instances', { skip: !available } as never, async () => {
  const s = must();
  const created = await s.createProject('Persisted Film');
  await s.updateProject(created.id, {
    status: 'uploaded',
    notes: ['hello'],
    media: { filename: 'a.mp4', bytes: 42 },
  });
  const fresh = await PgStore.connect(DATABASE_URL);
  try {
    const got = await fresh.getProject(created.id);
    assert.equal(got?.name, 'Persisted Film');
    assert.equal(got?.status, 'uploaded');
    assert.deepEqual(got?.notes, ['hello']);
    assert.equal(got?.media?.bytes, 42);
    const listed = await fresh.listProjects();
    assert.ok(listed.some((p) => p.id === created.id));
    await fresh.removeProject(created.id);
    assert.equal(await fresh.getProject(created.id), null);
  } finally {
    await fresh.close();
  }
});
