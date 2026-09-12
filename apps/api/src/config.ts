// Syntheniq — central configuration.
// Every secret and environment-specific value comes from process.env.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/ in dev (tsx), dist/ in production builds — the package root is one up.
export const ROOT = path.join(here, '..');

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}

export const DATA_DIR =
  process.env.SYNTHENIQ_DATA || process.env.DATA_DIR || path.join(ROOT, 'data');
export const PORT = int('PORT', 8787);
export const MAX_UPLOAD_MB = int('MAX_UPLOAD_MB', 2048);

export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'whisper-1';
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny';
export const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'cpu';

export const CLIPS_DEFAULT = int('CLIPS_DEFAULT', 5);
export const CLIPS_MAX = int('CLIPS_MAX', 8);

export const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
export const WEB_ORIGIN = process.env.WEB_ORIGIN || '';
export const WEB_OUT_DIR =
  process.env.WEB_OUT_DIR || path.join(ROOT, '..', 'web', 'out');

export const R2 = {
  endpoint: process.env.R2_ENDPOINT || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || '',
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '',
};
export const S3_FORCE_PATH_STYLE =
  (process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === '1' ||
  (process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
export const R2_PRESIGN_EXPIRES = int('R2_PRESIGN_EXPIRES', 3600);

// --- Persistence (production requires Postgres) ---
export const DATABASE_URL = process.env.DATABASE_URL || '';

// --- LLM editorial (OpenAI Responses API; heuristic fallback without key) ---
export const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
export const OPENAI_EDITORIAL_MODEL = process.env.OPENAI_EDITORIAL_MODEL || 'gpt-4o-mini';
export const OPENAI_TIMEOUT_MS = int('OPENAI_TIMEOUT_MS', 60000);
export const LLM_TOP_K = int('LLM_TOP_K', 40);

// --- Workers ---
export const WORKER_CONCURRENCY = int('WORKER_CONCURRENCY', 1);
export const WORKER_POLL_MS = int('WORKER_POLL_MS', 1000);
export const JOB_LEASE_SEC = int('JOB_LEASE_SEC', 30);
export const JOB_MAX_ATTEMPTS = int('JOB_MAX_ATTEMPTS', 3);
export const API_ONLY =
  (process.env.API_ONLY || '').toLowerCase() === '1' ||
  (process.env.API_ONLY || '').toLowerCase() === 'true';
