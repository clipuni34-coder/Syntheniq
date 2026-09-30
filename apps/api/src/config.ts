import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '../../../');
export const DATA_DIR = path.resolve(process.env.SYNTHENIQ_DATA || path.join(ROOT, 'data'));
export const WEB_OUT_DIR = process.env.WEB_OUT_DIR
  ? path.resolve(process.env.WEB_OUT_DIR)
  : path.resolve(ROOT, 'apps/web/out');
export const ASSETS_DIR = path.resolve(here, '../assets');
export const PORT = Number(process.env.PORT || 8787);
export const PASSWORD = process.env.SYNTHENIQ_PASSWORD || '';

export type ProviderId = 'openai' | 'gemini' | 'grok';
export type TaskId = 'analyze' | 'plan' | 'package' | 'qc' | 'video';

export const PROVIDERS: ProviderId[] = ['openai', 'gemini', 'grok'];

// ── AI model configuration (unified routing) ─────────────────────────────
export const DEFAULT_MODELS: Record<ProviderId, { deep: string; fast: string }> = {
  grok: { deep: 'grok-4.6', fast: 'grok-4.6' },
  openai: { deep: 'gpt-5.6-terra', fast: 'gpt-5.6-luna' },
  gemini: { deep: 'gemini-3.5-flash', fast: 'gemini-3.5-flash-lite' },
};

export const TASK_TIER: Record<TaskId, 'deep' | 'fast'> = {
  analyze: 'deep',
  plan: 'deep',
  qc: 'deep',
  video: 'deep',
  package: 'fast',
};

export interface AiConfig {
  primary: ProviderId | null;
  model: string | null;
  fallback: ProviderId[];
  taskProvider: Partial<Record<TaskId, ProviderId>>;
  taskModel: Partial<Record<TaskId, string>>;
  reviewProvider: ProviderId | null;
  reviewModel: string | null;
}

function parseProviders(raw: string | undefined): ProviderId[] {
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter((s): s is ProviderId => (PROVIDERS as string[]).includes(s));
}

export function providerKeyPresent(p: ProviderId): boolean {
  switch (p) {
    case 'openai':
      return Boolean(process.env.OPENAI_API_KEY);
    case 'gemini':
      return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    case 'grok':
      return Boolean(process.env.XAI_API_KEY);
  }
}

export function loadAiConfig(): AiConfig {
  const primaryRaw = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const primary: ProviderId | null = primaryRaw === '' ? null : (PROVIDERS as string[]).includes(primaryRaw) ? (primaryRaw as ProviderId) : null;
  return {
    primary,
    model: process.env.AI_MODEL?.trim() || null,
    fallback: parseProviders(process.env.AI_FALLBACK),
    taskProvider: {
      analyze: parseTaskProvider(process.env.AI_TASK_ANALYZE_PROVIDER),
      plan: parseTaskProvider(process.env.AI_TASK_PLAN_PROVIDER),
      package: parseTaskProvider(process.env.AI_TASK_PACKAGE_PROVIDER),
      qc: parseTaskProvider(process.env.AI_TASK_QC_PROVIDER),
      video: parseTaskProvider(process.env.AI_TASK_VIDEO_PROVIDER),
    },
    taskModel: {
      analyze: taskModel(process.env.AI_TASK_ANALYZE_MODEL),
      plan: taskModel(process.env.AI_TASK_PLAN_MODEL),
      package: taskModel(process.env.AI_TASK_PACKAGE_MODEL),
      qc: taskModel(process.env.AI_TASK_QC_MODEL),
      video: taskModel(process.env.AI_TASK_VIDEO_MODEL),
    },
    reviewProvider: parseTaskProvider(process.env.REVIEW_PROVIDER) ?? null,
    reviewModel: taskModel(process.env.REVIEW_MODEL) ?? null,
  };
}

function parseTaskProvider(raw: string | undefined): ProviderId | undefined {
  const v = (raw || '').trim().toLowerCase();
  return v && (PROVIDERS as string[]).includes(v) ? (v as ProviderId) : undefined;
}
function taskModel(raw: string | undefined): string | undefined {
  const v = (raw || '').trim();
  return v || undefined;
}

const MODEL_FAMILY: Record<ProviderId, string[]> = {
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'],
  gemini: ['gemini-'],
  grok: ['grok-'],
};

export function modelFitsProvider(model: string, provider: ProviderId): boolean {
  const m = (model || '').toLowerCase();
  return MODEL_FAMILY[provider].some((fam) => m.startsWith(fam));
}

export function modelForTask(cfg: AiConfig, task: TaskId, provider: ProviderId): string {
  const explicit = cfg.taskModel[task] || cfg.model;
  if (explicit && modelFitsProvider(explicit, provider)) return explicit;
  return DEFAULT_MODELS[provider][TASK_TIER[task]];
}

// ── Transcription (legacy compatibility) ─────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
export const OPENAI_MODEL = process.env.OPENAI_MODEL || 'whisper-1';
export const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
export const OPENAI_EDITORIAL_MODEL = process.env.OPENAI_EDITORIAL_MODEL || 'gpt-4o-mini';
export const OPENAI_TIMEOUT_MS = int('OPENAI_TIMEOUT_MS', 60000);
export const LLM_TOP_K = int('LLM_TOP_K', 40);
export const SYNTHENIQ_WHISPER_MODEL = (process.env.SYNTHENIQ_WHISPER_MODEL || 'small').trim();
export const WHISPER_MODEL = process.env.WHISPER_MODEL || 'tiny';
export const WHISPER_DEVICE = process.env.WHISPER_DEVICE || 'cpu';

// ── Upload limits ─────────────────────────────────────────────────────────
export const MAX_UPLOAD_MB = int('MAX_UPLOAD_MB', 2048);

// ── Clips configuration ───────────────────────────────────────────────────
export const CLIPS_DEFAULT = int('CLIPS_DEFAULT', 5);
export const CLIPS_MAX = int('CLIPS_MAX', 8);

// ── Storage configuration ─────────────────────────────────────────────────
export const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
export const WEB_ORIGIN = process.env.WEB_ORIGIN || '';

export const R2 = {
  endpoint: process.env.R2_ENDPOINT || '',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  bucket: process.env.R2_BUCKET || '',
  publicBaseUrl: process.env.R2_PUBLIC_BASE_URL || '',
};
export const S3_FORCE_PATH_STYLE = (process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === '1' || (process.env.S3_FORCE_PATH_STYLE || '').toLowerCase() === 'true';
export const R2_PRESIGN_EXPIRES = int('R2_PRESIGN_EXPIRES', 3600);

// ── Database ──────────────────────────────────────────────────────────────
export const DATABASE_URL = process.env.DATABASE_URL || '';
export const API_ONLY = (process.env.API_ONLY || '').toLowerCase() === '1' || (process.env.API_ONLY || '').toLowerCase() === 'true';

// ── Workers (legacy standalone worker support) ──────────────────────────
export const WORKER_CONCURRENCY = int('WORKER_CONCURRENCY', 1);
export const WORKER_POLL_MS = int('WORKER_POLL_MS', 1000);
export const JOB_LEASE_SEC = int('JOB_LEASE_SEC', 30);
export const JOB_MAX_ATTEMPTS = int('JOB_MAX_ATTEMPTS', 3);

function int(name: string, fallback: number): number {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) ? v : fallback;
}
