// Syntheniq — storage seam: local disk default, Cloudflare R2 optional.
import { STORAGE_DRIVER } from '../config.js';

export interface StorageProvider {
  kind: string;
  mirror(localPath: string, key: string): Promise<Record<string, unknown>>;
  fetch(key: string, localPath: string): Promise<Record<string, unknown>>;
}

export const localStorage: StorageProvider = {
  kind: 'local',
  async mirror(localPath: string, key: string) {
    return { kind: 'local', key, localPath };
  },
  async fetch(key: string, localPath: string) {
    return { kind: 'local', key, localPath };
  },
};

export async function getStorage(): Promise<StorageProvider> {
  if ((STORAGE_DRIVER || 'local').toLowerCase() === 'r2') {
    const { createR2Storage } = await import('./r2.js');
    return createR2Storage();
  }
  return localStorage;
}
