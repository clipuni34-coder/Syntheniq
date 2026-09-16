import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/ (or src/) → apps/api → apps → repo root
export const ROOT = path.resolve(__dirname, '../../../');
export const DATA_DIR = path.resolve(process.env.SYNTHENIQ_DATA || path.join(ROOT, 'data'));
export const WEB_OUT_DIR = process.env.WEB_OUT_DIR
  ? path.resolve(process.env.WEB_OUT_DIR)
  : path.resolve(ROOT, 'apps/web/out');
export const ASSETS_DIR = path.resolve(__dirname, '../assets');
export const PORT = Number(process.env.PORT || 8787);
export const PASSWORD = process.env.SYNTHENIQ_PASSWORD || '';

export type ProviderId = 'openai' | 'gemini' | 'grok';
export type TaskId = 'analyze' | 'plan' | 'package' | 'qc' | 'video';

export const PROVIDERS: ProviderId[] = ['openai', 'gemini', 'grok'];

/** Smart per-provider model defaults, by tier. `deep` = reasoning-heavy tasks, `fast` = cheap/bulk tasks. */
export const DEFAULT_MODELS: Record<ProviderId, { deep: string; fast: string }> = {
  // xAI — single flagship model (current as of 2026-09, verified in official docs)
  grok: { deep: 'grok-4.6', fast: 'grok-4.6' },
  // OpenAI — balanced + high-volume tiers (verified against developers.openai.com pricing, 2026-09-15)
  openai: { deep: 'gpt-5.6-terra', fast: 'gpt-5.6-luna' },
  // Gemini — current stable Flash + cheapest Flash-Lite (verified in ai.google.dev model docs, 2026-09-15)
  gemini: { deep: 'gemini-3.8-flash', fast: 'gemini-3.5-flash-lite' },
};

/** Which tier each task uses when no explicit model is configured. */
export const TASK_TIER: Record<TaskId, 'deep' | 'fast'> = {
  analyze: 'deep',
  plan: 'deep',
  qc: 'deep',
  video: 'deep',
  package: 'fast',
};

export interface AiConfig {
  /** Explicit primary provider (env AI_PROVIDER), or null = auto-pick. */
  primary: ProviderId | null;
  /** Explicit primary model (env AI_MODEL), or null = per-provider default. */
  model: string | null;
  /** Fallback chain (env AI_FALLBACK). */
  fallback: ProviderId[];
  /** Per-task provider/model overrides. */
  taskProvider: Partial<Record<TaskId, ProviderId>>;
  taskModel: Partial<Record<TaskId, string>>;
  /** Optional second-pass review provider/model. */
  reviewProvider: ProviderId | null;
  reviewModel: string | null;
}

function parseProviders(raw: string | undefined): ProviderId[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is ProviderId => (PROVIDERS as string[]).includes(s));
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
  const primary: ProviderId | null =
    primaryRaw === '' ? null : (PROVIDERS as string[]).includes(primaryRaw) ? (primaryRaw as ProviderId) : null;

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

/** Resolve the model for a task+provider given explicit config. */
export function modelForTask(cfg: AiConfig, task: TaskId, provider: ProviderId): string {
  return (
    cfg.taskModel[task] ||
    cfg.model ||
    DEFAULT_MODELS[provider][TASK_TIER[task]]
  );
}

export const WHISPER_MODEL = (process.env.SYNTHENIQ_WHISPER_MODEL || 'small').trim();
