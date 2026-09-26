// Syntheniq — storage seam.
//
// Production path: Cloudflare R2 (S3-compatible) — required when
// NODE_ENV=production (see assertProductionStores). Local disk is the
// development default: zero setup, media served straight from DATA_DIR.
//
// R2 key layout:
//   projects/{id}/source/{filename}
//   projects/{id}/analysis.json
//   projects/{id}/transcript.json
//   projects/{id}/clips/{clipId}/export.mp4
//   projects/{id}/clips/{clipId}/poster.jpg
//   projects/{id}/clips/{clipId}/captions.ass
import { STORAGE_DRIVER } from '../config.js';
import { createR2Storage } from './r2.js';

export interface StorageProvider {
  kind: string;
  /** Durable copy of a local file. Throws StorageError on failure. */
  mirror(localPath: string, key: string): Promise<{ key: string }>;
  /** Restore a durable object to a local path. Throws StorageError on failure. */
  fetch(key: string, localPath: string): Promise<{ key: string; localPath: string }>;
  /**
   * Direct-download URL. Local driver returns null (bytes are served by the
   * API itself); R2 returns a time-limited presigned URL so media never
   * proxies through the API tier in production.
   */
  downloadUrl(key: string, opts?: { downloadName?: string }): Promise<string | null>;
}

export class StorageError extends Error {
  readonly key: string;
  readonly op: string;
  constructor(op: string, key: string, message: string) {
    super(`storage ${op} failed for "${key}": ${message}`);
    this.name = 'StorageError';
    this.op = op;
    this.key = key;
  }
}

export const localStorage: StorageProvider = {
  kind: 'local',
  async mirror(localPath: string, key: string) {
    return { key };
  },
  async fetch(key: string, localPath: string) {
    return { key, localPath };
  },
  async downloadUrl(): Promise<string | null> {
    return null;
  },
};

let override: StorageProvider | null = null;

/** Test seam: swap the active provider within a test process. */
export function __setStorageOverride(provider: StorageProvider | null): void {
  override = provider;
}

export function getStorage(): StorageProvider {
  if (override) return override;
  if ((STORAGE_DRIVER || 'local').toLowerCase() === 'r2') {
    return createR2Storage();
  }
  return localStorage;
}

export function isR2(): boolean {
  if (override) return override.kind === 'r2';
  return (STORAGE_DRIVER || 'local').toLowerCase() === 'r2';
}

// Deterministic keys (importable without constructing a provider).
export const keys = {
  source: (projectId: string, filename: string) => `projects/${projectId}/source/${filename}`,
  analysis: (projectId: string) => `projects/${projectId}/analysis.json`,
  transcript: (projectId: string) => `projects/${projectId}/transcript.json`,
  exportFile: (projectId: string, clipId: string) => `projects/${projectId}/clips/${clipId}/export.mp4`,
  poster: (projectId: string, clipId: string) => `projects/${projectId}/clips/${clipId}/poster.jpg`,
  captions: (projectId: string, clipId: string) => `projects/${projectId}/clips/${clipId}/captions.ass`,
};
