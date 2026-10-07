// Syntheniq — PgStore SQL layer against a fake Queryable: claims must be
// atomic (FOR UPDATE SKIP LOCKED), JSON must roundtrip, misses return null.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PgStore, type Queryable } from '../src/lib/pgStore.js';

interface Call {
  text: string;
  params: unknown[] | undefined;
}

function fakeDb(rows: Record<string, unknown>[] = []): Queryable & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    async query(text: string, params?: unknown[]) {
      calls.push({ text, params });
      // One row per query, in order — multi-statement methods consume progressively.
      return { rows: rows.splice(0, 1) };
    },
  };
}

function jobRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'job-1',
    type: 'analyze',
    label: 'Analyze',
    status: 'running',
    progress: 3,
    message: 'Working',
    result: null,
    error: null,
    meta: { projectId: 'p1' },
    attempts: 1,
    lease_owner: 'w1',
    lease_expires_at: new Date(Date.now() + 30000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

function projectRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'p1',
    name: 'Demo',
    status: 'uploaded',
    media: { filename: 'a.mp4' },
    analysis: null,
    active_job: null,
    notes: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...over,
  };
}

test('claimNext uses a single atomic SKIP LOCKED statement', async () => {
  const db = fakeDb([jobRow()]);
  const store = new PgStore(db);
  const claimed = await store.claimNext('worker-7', 30, 3);
  assert.equal(db.calls.length, 1);
  const sql = db.calls[0].text;
  assert.match(sql, /FOR UPDATE SKIP LOCKED/);
  assert.match(sql, /lease_expires_at/);
  assert.match(sql, /attempts/);
  assert.deepEqual(db.calls[0].params, ['worker-7', 30, 3]);
  assert.equal(claimed?.id, 'job-1');
  assert.equal(claimed?.leaseOwner, 'worker-7');
  assert.equal(claimed?.attempts, 1);
});

test('claimNext returns null when no job is claimable', async () => {
  const db = fakeDb([]);
  const store = new PgStore(db);
  assert.equal(await store.claimNext('w', 30, 3), null);
});

test('enqueue serializes meta as JSON; get maps columns to public shape', async () => {
  const db = fakeDb([jobRow({ status: 'queued', progress: 0 })]);
  const store = new PgStore(db);
  const job = await store.enqueue('export', 'Export x', { projectId: 'p1', clipId: 'c1' });
  assert.match(db.calls[0].text, /INSERT INTO jobs/);
  const metaParam = String(db.calls[0].params?.[3] ?? '');
  assert.deepEqual(JSON.parse(metaParam), { projectId: 'p1', clipId: 'c1' });
  assert.equal(job.status, 'queued');

  const db2 = fakeDb([jobRow()]);
  const store2 = new PgStore(db2);
  const got = await store2.get('job-1');
  assert.equal(got?.id, 'job-1');
  assert.equal(got?.leaseOwner, undefined);
  assert.deepEqual(got?.meta, { projectId: 'p1' });
  assert.equal((await store2.get('missing')) ?? null, null);
});

test('update clamps progress and merges meta with jsonb concat', async () => {
  const db = fakeDb([jobRow({ progress: 100 })]);
  const store = new PgStore(db);
  await store.update('job-1', { progress: 140, message: 'm', meta: { coverage: 0.5 } });
  const sql = db.calls[0].text;
  assert.match(sql, /UPDATE jobs SET/);
  assert.match(sql, /RETURNING/);
  assert.match(sql, /meta = meta \|\|/);
  assert.deepEqual(db.calls[0].params?.slice(1), [100, 'm', JSON.stringify({ coverage: 0.5 })]);
});

test('findActive filters queued/running by type + project + clip', async () => {
  const db = fakeDb([jobRow({ type: 'export', meta: { projectId: 'p1', clipId: 'c9' } })]);
  const store = new PgStore(db);
  const found = await store.findActive('export', 'p1', 'c9');
  assert.match(db.calls[0].text, /status IN \('queued','running'\)/);
  assert.match(db.calls[0].text, /meta->>'projectId'/);
  assert.match(db.calls[0].text, /meta->>'clipId'/);
  assert.deepEqual(db.calls[0].params, ['export', 'p1', 'c9']);
  assert.equal(found?.id, 'job-1');
});

test('projects persist as JSONB documents and return null on miss', async () => {
  const db = fakeDb([]);
  const store = new PgStore(db);
  const created = await store.createProject('My Film');
  assert.match(db.calls[0].text, /INSERT INTO projects \(id, data, updated_at\)/);
  assert.equal(created.name, 'My Film');
  assert.equal(created.status, 'created');
  const stored = JSON.parse(String(db.calls[0].params?.[1]));
  assert.equal(stored.id, created.id);
  assert.equal(stored.name, 'My Film');

  const existing = { ...stored, name: 'My Film' };
  const db2 = fakeDb([{ data: existing }, { data: { ...existing, name: 'Renamed', notes: ['n1'] } }]);
  const store2 = new PgStore(db2);
  const updated = await store2.updateProject(created.id, { name: 'Renamed', notes: ['n1'] });
  assert.match(db2.calls[0].text, /SELECT data FROM projects WHERE id/);
  assert.match(db2.calls[1].text, /UPDATE projects SET data = /);
  assert.match(db2.calls[1].text, /RETURNING data/);
  assert.equal(updated.name, 'Renamed');
  assert.deepEqual(updated.notes, ['n1']);

  const db3 = fakeDb([]);
  const store3 = new PgStore(db3);
  assert.equal(await store3.getProject('missing'), null);
  await assert.rejects(() => store3.updateProject('missing', { name: 'x' }), /not found/);
  await assert.rejects(() => store3.removeProject('missing'), /not found/);
});

test('renewLease only extends leases owned by the caller', async () => {
  const db = fakeDb([jobRow()]);
  const store = new PgStore(db);
  assert.equal(await store.renewLease('job-1', 'w1', 30), true);
  assert.match(db.calls[0].text, /lease_owner = \$2/);
  assert.match(db.calls[0].text, /status = 'running'/);

  const db2 = fakeDb([]);
  const store2 = new PgStore(db2);
  assert.equal(await store2.renewLease('job-1', 'impostor', 30), false);
});
