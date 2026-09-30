// Syntheniq — store singleton. DATABASE_URL set → Postgres (production),
// unset → JSON document (development + tests).
import type { Store } from './store.js';

let instance: Store | null = null;
let pending: Promise<Store> | null = null;

export async function getStore(): Promise<Store> {
  if (instance) return instance;
  if (!pending) {
    pending = (async () => {
      const url = process.env.DATABASE_URL || '';
      if (url) {
        const { PgStore } = await import('./pgStore.js');
        instance = await PgStore.connect(url);
      } else {
        const { JsonStore } = await import('./jsonStore.js');
        instance = new JsonStore();
        await instance.ensureReady();
      }
      return instance;
    })();
  }
  return pending;
}

export function storeKind(): 'postgres' | 'json' {
  if (instance) return instance.kind;
  return (process.env.DATABASE_URL || '') ? 'postgres' : 'json';
}

export async function closeStore(): Promise<void> {
  if (pending) {
    const store = await pending.catch(() => null);
    if (store) await store.close().catch(() => undefined);
  }
  instance = null;
  pending = null;
}
