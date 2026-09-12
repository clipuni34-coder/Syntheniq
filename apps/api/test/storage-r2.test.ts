// Syntheniq — R2 provider against a fake S3 transport: byte roundtrips,
// clear errors on missing objects/local files, prefix deletion.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-r2-'));
process.env.R2_ENDPOINT = 'https://r2.test.local';
process.env.R2_ACCESS_KEY_ID = 'test-key';
process.env.R2_SECRET_ACCESS_KEY = 'test-secret';
process.env.R2_BUCKET = 'syntheniq-test';
process.env.S3_FORCE_PATH_STYLE = '1';

const { createR2Storage } = await import('../src/storage/r2.js');
const { StorageError } = await import('../src/storage/index.js');

class FakeS3 {
  objects = new Map<string, Buffer>();
  failWith: Error | null = null;

  async send(cmd: any): Promise<any> {
    if (this.failWith) throw this.failWith;
    const name = cmd?.constructor?.name;
    const input = cmd?.input || {};
    if (name === 'PutObjectCommand') {
      const body = Buffer.isBuffer(input.Body) ? input.Body : Buffer.from(input.Body as Uint8Array);
      this.objects.set(String(input.Key), body);
      return { ETag: '"fake"' };
    }
    if (name === 'GetObjectCommand') {
      const body = this.objects.get(String(input.Key));
      if (!body) {
        const err = new Error('NoSuchKey: The specified key does not exist.');
        (err as any).$metadata = { httpStatusCode: 404 };
        throw err;
      }
      return {
        Body: (async function* () {
          yield body.subarray(0, 3);
          yield body.subarray(3);
        })(),
      };
    }
    if (name === 'ListObjectsV2Command') {
      const prefix = String(input.Prefix || '');
      const keys = [...this.objects.keys()].filter((k) => k.startsWith(prefix));
      return { Contents: keys.map((Key) => ({ Key })), NextContinuationToken: undefined };
    }
    if (name === 'DeleteObjectsCommand') {
      const objs = (input.Delete?.Objects || []) as { Key: string }[];
      for (const o of objs) this.objects.delete(o.Key);
      return { Deleted: objs };
    }
    throw new Error(`unexpected command ${name}`);
  }
}

test('mirror → fetch roundtrips bytes exactly', async () => {
  const s3 = new FakeS3();
  const storage = createR2Storage(s3 as never);
  assert.equal(storage.kind, 'r2');
  const local = path.join(TMP, 'clip.mp4');
  const bytes = Buffer.from('fake-mp4-bytes-'.repeat(1000));
  fs.writeFileSync(local, bytes);
  await storage.mirror(local, 'projects/p1/clips/c1/export.mp4');
  const restored = path.join(TMP, 'restored.mp4');
  await storage.fetch('projects/p1/clips/c1/export.mp4', restored);
  assert.deepEqual(fs.readFileSync(restored), bytes);
});

test('fetch of a missing object throws StorageError naming the key', async () => {
  const storage = createR2Storage(new FakeS3() as never);
  const err = await storage.fetch('projects/p1/missing.mp4', path.join(TMP, 'x.mp4')).catch((e) => e);
  assert.ok(err instanceof StorageError);
  assert.equal(err.op, 'fetch');
  assert.match(err.message, /projects\/p1\/missing\.mp4/);
});

test('mirror of a missing local file fails before any network call', async () => {
  const s3 = new FakeS3();
  const storage = createR2Storage(s3 as never);
  await assert.rejects(() => storage.mirror(path.join(TMP, 'nope.mp4'), 'k'), /local file missing/);
  assert.equal(s3.objects.size, 0);
});

test('transport failures surface as StorageError with the operation', async () => {
  const s3 = new FakeS3();
  s3.failWith = new Error('socket hang up');
  const storage = createR2Storage(s3 as never);
  const local = path.join(TMP, 'up.mp4');
  fs.writeFileSync(local, 'data');
  const err = await storage.mirror(local, 'k').catch((e) => e);
  assert.ok(err instanceof StorageError);
  assert.equal(err.op, 'mirror');
  assert.match(err.message, /socket hang up/);
});

test('deletePrefix removes every object under the prefix', async () => {
  const s3 = new FakeS3();
  const storage = createR2Storage(s3 as never);
  for (const k of ['projects/p1/a.mp4', 'projects/p1/b.mp4', 'projects/p2/a.mp4']) {
    const f = path.join(TMP, `f-${Math.random()}.bin`);
    fs.writeFileSync(f, 'x');
    await storage.mirror(f, k);
  }
  const { deleted } = await storage.deletePrefix('projects/p1/');
  assert.equal(deleted, 2);
  assert.equal(s3.objects.has('projects/p2/a.mp4'), true);
});
