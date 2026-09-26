// Syntheniq — production boot guard: Postgres + R2 are mandatory in
// production; development stays zero-config.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionStores } from '../src/lib/store.js';

const saved = {
  NODE_ENV: process.env.NODE_ENV,
  DATABASE_URL: process.env.DATABASE_URL,
  STORAGE_DRIVER: process.env.STORAGE_DRIVER,
};

function setEnv(nodeEnv: string | undefined, db: string | undefined, storage: string | undefined) {
  if (nodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = nodeEnv;
  if (db === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = db;
  if (storage === undefined) delete process.env.STORAGE_DRIVER;
  else process.env.STORAGE_DRIVER = storage;
}

test.after(() => {
  setEnv(saved.NODE_ENV, saved.DATABASE_URL, saved.STORAGE_DRIVER);
});

test('development boots without any external services', () => {
  setEnv(undefined, undefined, undefined);
  assert.doesNotThrow(() => assertProductionStores());
  setEnv('test', undefined, 'local');
  assert.doesNotThrow(() => assertProductionStores());
});

test('production refuses the JSON store', () => {
  setEnv('production', undefined, 'r2');
  assert.throws(() => assertProductionStores(), /DATABASE_URL/);
});

test('production refuses local media storage', () => {
  setEnv('production', 'postgres://db:5432/syntheniq', 'local');
  assert.throws(() => assertProductionStores(), /STORAGE_DRIVER=r2/);
});

test('production accepts Postgres + R2', () => {
  setEnv('production', 'postgres://db:5432/syntheniq', 'r2');
  assert.doesNotThrow(() => assertProductionStores());
});
