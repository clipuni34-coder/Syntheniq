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
  // Gemini — stable Flash (deep) + Flash-Lite (fast), verified against live API calls.
  // gemini-3.8-flash was initially listed as the deep-tier default but is currently
  // returning 503 "high demand" / quota errors in production; gemini-3.5-flash is
  // the verified-working deep model for analyze/plan/qc/video tasks.
  gemini: { deep: 'gemini-3.5-flash', fast: 'gemini-3.5-flash-lite' },
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

/** Model-name families each provider can actually serve (prefix match).
 *  Guards against the class of bug where a global AI_MODEL from one
 *  provider (e.g. gpt-5.6-luna) is forwarded to another provider (gemini)
 *  and every call 404s, silently degrading the whole chain to heuristic. */
const MODEL_FAMILY: Record<ProviderId, string[]> = {
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'],
  gemini: ['gemini-'],
  grok: ['grok-'],
};

export function modelFitsProvider(model: string, provider: ProviderId): boolean {
  const m = (model || '').toLowerCase();
  return MODEL_FAMILY[provider].some((fam) => m.startsWith(fam));
}

/** Resolve the model for a task+provider given explicit config.
 *  An explicit model (per-task or global AI_MODEL) is only honored when its
 *  model family belongs to the provider being called; otherwise the
 *  provider's own default for the task tier is used (graceful cross-provider
 *  semantics: AI_PROVIDER=gemini + AI_MODEL=gpt-* must not 404 on gemini). */
export function modelForTask(cfg: AiConfig, task: TaskId, provider: ProviderId): string {
  const explicit = cfg.taskModel[task] || cfg.model;
  if (explicit && modelFitsProvider(explicit, provider)) return explicit;
  return DEFAULT_MODELS[provider][TASK_TIER[task]];
}

export const WHISPER_MODEL = (process.env.SYNTHENIQ_WHISPER_MODEL || 'small').trim();
