import test from 'node:test';
import assert from 'node:assert/strict';

test('local storage is the default and needs no configuration', async () => {
  const { getStorage } = await import('../src/storage/index.js');
  const s = await getStorage();
  assert.equal(s.kind, 'local');
});

test('selecting R2 without credentials fails with the documented error', async () => {
  process.env.STORAGE_DRIVER_BACKUP = process.env.STORAGE_DRIVER || '';
  process.env.STORAGE_DRIVER = 'r2';
  // Config is read at import time; force a fresh module graph with a query suffix.
  const { createR2Storage } = await import(`../src/storage/r2.ts?storage-test=${Date.now()}`);
  await assert.rejects(() => createR2Storage(), /missing configuration|R2_ENDPOINT/);
  if (process.env.STORAGE_DRIVER_BACKUP) process.env.STORAGE_DRIVER = process.env.STORAGE_DRIVER_BACKUP;
  else delete process.env.STORAGE_DRIVER;
});
