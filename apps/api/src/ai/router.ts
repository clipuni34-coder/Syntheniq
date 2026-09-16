import {
  DEFAULT_MODELS,
  modelForTask,
  providerKeyPresent,
  type AiConfig,
  type ProviderId,
  type TaskId,
} from '../config.js';
import type { MediaSignals } from '../pipeline/types.js';
import { callGemini } from './gemini.js';
import { callHeuristic, heuristicSupports, type HeuristicSignals } from './heuristic.js';
import { callGrok } from './grok.js';
import { callOpenai } from './openai.js';
import { AiError, type LLMRequest, type LLMResult } from './types.js';

export type LogFn = (msg: string) => void;

const AUTO_ORDER: ProviderId[] = ['gemini', 'openai', 'grok'];

/** A failed provider cools down so a flapping endpoint isn't retried on every
 *  subsequent task in the same job. In-memory: a server restart re-tries
 *  everyone (a provider failure NEVER forces a job restart — spec §4). */
const COOLDOWN_MS = 90_000;

/**
 * Multi-provider AI router.
 *
 * Resolution order per task:
 *   1. explicit per-task provider (AI_TASK_<T>_PROVIDER)
 *   2. primary provider (AI_PROVIDER, or auto-picked: first configured key in gemini→openai→grok)
 *   3. fallback chain (AI_FALLBACK)
 *   4. heuristic offline mode (deterministic, no key required)
 *
 * Failover: each provider is attempted in chain order; on failure the router
 * moves to the next configured provider and finally the local heuristic,
 * persisting which provider served each task to the job state. A failing
 * provider enters a cooldown and is skipped by later calls in this job.
 *
 * Keys are read from process.env only and never leave the server process.
 */
export class AiRouter {
  private cooldown = new Map<ProviderId, number>();

  constructor(
    private cfg: AiConfig,
    public log: LogFn,
    public signals: HeuristicSignals | null,
  ) {}

  primaryProvider(): ProviderId | null {
    if (this.cfg.primary) return this.cfg.primary;
    for (const p of AUTO_ORDER) if (providerKeyPresent(p)) return p;
    return null;
  }

  chainFor(task: TaskId): (ProviderId | 'heuristic')[] {
    const chain: (ProviderId | 'heuristic')[] = [];
    const push = (p: ProviderId | 'heuristic' | null | undefined) => {
      if (p && !chain.includes(p)) chain.push(p);
    };
    push(this.cfg.taskProvider[task]);
    push(this.cfg.taskProvider[task] ? this.cfg.primary ?? this.primaryProvider() : this.cfg.primary ?? this.primaryProvider());
    for (const f of this.cfg.fallback) push(f);
    if (heuristicSupports(task)) push('heuristic');
    return chain;
  }

  /** Chain for the second-pass review: explicit REVIEW_PROVIDER, else a *different* configured provider. */
  reviewChain(exclude?: ProviderId): ProviderId[] {
    const out: ProviderId[] = [];
    if (this.cfg.reviewProvider) {
      if (providerKeyPresent(this.cfg.reviewProvider)) out.push(this.cfg.reviewProvider);
      return out;
    }
    for (const p of AUTO_ORDER) {
      if (p !== exclude && providerKeyPresent(p)) out.push(p);
    }
    return out;
  }

  /** Providers currently in cooldown (for diagnostics; empty = all healthy). */
  coolingDown(): ProviderId[] {
    const now = Date.now();
    const out: ProviderId[] = [];
    for (const [p, until] of this.cooldown) if (until > now) out.push(p);
    return out;
  }

  clearCooldown(p: ProviderId): void {
    this.cooldown.delete(p);
  }

  async call(req: LLMRequest): Promise<LLMResult> {
    const chain = this.chainFor(req.task);
    const errors: string[] = [];
    for (const p of chain) {
      if (p === 'heuristic') {
        this.log(`ai[${req.task}]: no provider available — using heuristic offline mode`);
        return callHeuristic(req, this.signals);
      }
      if (!providerKeyPresent(p)) continue;
      const cd = this.cooldown.get(p);
      if (cd && cd > Date.now()) {
        this.log(`ai[${req.task}]: ${p} cooling down (${Math.ceil((cd - Date.now()) / 1000)}s) — skipped`);
        continue;
      }
      const model = modelForTask(this.cfg, req.task, p);
      try {
        const result = await this.invoke(p, req, model);
        this.cooldown.delete(p);
        this.log(`ai[${req.task}]: ${p}/${model} ok in ${Math.round(result.latencyMs / 1000)}s`);
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable = e instanceof AiError ? e.retryable : true;
        this.cooldown.set(p, Date.now() + COOLDOWN_MS);
        errors.push(`${p}/${model}: ${msg}`);
        this.log(`ai[${req.task}]: ${p}/${model} failed${retryable ? ' (retryable)' : ''} — ${msg} (cooling down)`);
      }
    }
    throw new Error(`all AI providers failed for task '${req.task}': ${errors.join(' | ') || 'none configured'}`);
  }

  async callReview(task: TaskId, req: LLMRequest, producedBy: ProviderId | null): Promise<LLMResult | null> {
    const chain = this.reviewChain(producedBy ?? undefined);
    const errors: string[] = [];
    for (const p of chain) {
      const model = this.cfg.reviewModel || modelForTask(this.cfg, task, p);
      try {
        const result = await this.invoke(p, req, model);
        this.log(`review[${task}]: ${p}/${model} ok`);
        return result;
      } catch (e) {
        this.cooldown.set(p, Date.now() + COOLDOWN_MS);
        errors.push(`${p}: ${(e as Error).message}`);
        this.log(`review[${task}]: ${p} failed — ${(e as Error).message} (cooling down)`);
      }
    }
    if (errors.length) this.log(`review[${task}]: skipped (${errors.join(' | ')})`);
    return null;
  }

  private async invoke(p: ProviderId, req: LLMRequest, model: string): Promise<LLMResult> {
    switch (p) {
      case 'openai':
        return callOpenai(req, process.env.OPENAI_API_KEY!, model);
      case 'gemini':
        return callGemini(req, process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY!, model);
      case 'grok':
        return callGrok(req, process.env.XAI_API_KEY!, model);
    }
  }

  /** Provider status for the UI (never includes keys). */
  status() {
    const primary = this.cfg.primary ?? this.primaryProvider();
    const chains: Record<TaskId, string[]> = { analyze: [], plan: [], package: [], qc: [], video: [] };
    (Object.keys(chains) as TaskId[]).forEach((t) => {
      chains[t] = this.chainFor(t).map((p) => (p === 'heuristic' ? 'heuristic' : p));
    });
    const cooling = this.coolingDown();
    const providers = (['openai', 'gemini', 'grok'] as ProviderId[]).map((id) => ({
      id,
      configured: providerKeyPresent(id),
      primary: primary === id,
      inFallback: this.cfg.fallback.includes(id),
      coolingDown: cooling.includes(id),
      taskOverrides: (Object.keys(this.cfg.taskProvider) as TaskId[])
        .filter((t) => this.cfg.taskProvider[t] === id)
        .map((t) => t.toUpperCase()),
      defaults: DEFAULT_MODELS[id],
    }));
    return {
      mode: providers.some((p) => p.configured) ? 'ai' : 'heuristic',
      primary,
      explicitPrimary: this.cfg.primary,
      fallback: this.cfg.fallback,
      reviewProvider: this.cfg.reviewProvider,
      reviewModel: this.cfg.reviewModel,
      cooling,
      providers,
      chains,
      transcription: 'local faster-whisper',
    };
  }
}

export type { MediaSignals };
