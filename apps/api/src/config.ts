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
