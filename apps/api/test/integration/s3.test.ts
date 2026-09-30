// Syntheniq — REAL S3-compatible verification (moto_server or MinIO/R2).
// Requires TEST_S3_ENDPOINT (default http://127.0.0.1:5000); skips when
// unreachable. Uses the real AWS SDK path — no injected fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENDPOINT = process.env.TEST_S3_ENDPOINT || 'http://127.0.0.1:5000';
const BUCKET = process.env.TEST_S3_BUCKET || 'syntheniq-test';
process.env.SYNTHENIQ_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-s3int-'));
process.env.R2_ENDPOINT = ENDPOINT;
process.env.R2_ACCESS_KEY_ID = process.env.TEST_S3_KEY || 'test';
process.env.R2_SECRET_ACCESS_KEY = process.env.TEST_S3_SECRET || 'test';
process.env.R2_BUCKET = BUCKET;
process.env.S3_FORCE_PATH_STYLE = '1';
process.env.R2_PRESIGN_EXPIRES = '600';

const { createR2Storage } = await import('../../src/storage/r2.js');
const { StorageError } = await import('../../src/storage/index.js');
const { S3Client, CreateBucketCommand, ListBucketsCommand } = await import('@aws-sdk/client-s3');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-s3files-'));
let available = false;

// Probing runs at load (before test definitions) so `skip` is accurate.
try {
  const probe = new S3Client({
    region: 'us-east-1',
    endpoint: ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  await probe.send(new ListBucketsCommand({}));
  await probe.send(new CreateBucketCommand({ Bucket: BUCKET })).catch(() => undefined);
  available = true;
} catch (err) {
  console.log(`[s3-integration] skipping — S3 endpoint unreachable (${(err as Error).message})`);
}

test('mirror → fetch roundtrips bytes through the real SDK', { skip: !available } as never, async () => {
  const storage = createR2Storage();
  const bytes = Buffer.from('real-s3-roundtrip-'.repeat(5000));
  const local = path.join(TMP, 'src.bin');
  fs.writeFileSync(local, bytes);
  await storage.mirror(local, 'projects/p1/source/original.mp4');
  const restored = path.join(TMP, 'restored.bin');
  await storage.fetch('projects/p1/source/original.mp4', restored);
  assert.deepEqual(fs.readFileSync(restored), bytes);
});

test('presigned download URLs serve the exact object bytes', { skip: !available } as never, async () => {
  const storage = createR2Storage();
  const bytes = Buffer.from('presigned-bytes-'.repeat(1000));
  const local = path.join(TMP, 'clip.mp4');
  fs.writeFileSync(local, bytes);
  await storage.mirror(local, 'projects/p1/clips/c1/export.mp4');
  const url = await storage.downloadUrl('projects/p1/clips/c1/export.mp4', { downloadName: 'film-c1.mp4' });
  assert.ok(url && url.startsWith('http'));
  const res = await fetch(url);
  assert.equal(res.status, 200);
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), bytes);
});

test('missing objects fail with StorageError naming the key', { skip: !available } as never, async () => {
  const storage = createR2Storage();
  const err = await storage.fetch('projects/p1/does-not-exist.mp4', path.join(TMP, 'x')).catch((e) => e);
  assert.ok(err instanceof StorageError);
  assert.match(err.message, /does-not-exist/);
});

test('deletePrefix removes a project subtree only', { skip: !available } as never, async () => {
  const storage = createR2Storage();
  const f = path.join(TMP, 'pfx.bin');
  fs.writeFileSync(f, 'x');
  await storage.mirror(f, 'projects/del/a.mp4');
  await storage.mirror(f, 'projects/del/b.mp4');
  await storage.mirror(f, 'projects/keep/a.mp4');
  const { deleted } = await storage.deletePrefix('projects/del/');
  assert.equal(deleted, 2);
  const kept = path.join(TMP, 'kept.bin');
  await storage.fetch('projects/keep/a.mp4', kept);
  assert.equal(fs.readFileSync(kept, 'utf8'), 'x');
});
