#!/usr/bin/env python3
"""Write the session's NEW source files (not in the original snapshot, so
resets delete them). Idempotent: skips files whose content already matches.
Run: python3 tools/write-session-files.py
Covers: graphics.ts, qc-editorial.ts, ai/router.ts (tests: write-session-tests.py)
"""
import os

ROOT = '/home/user/Syntheniq'

FILES = {}

FILES['apps/api/src/pipeline/graphics.ts'] = r'''/**
 * graphics.ts — intelligent visual storytelling (master directive §6–§8, §15, §28).
 *
 * The bridge from SPEECH to VISUAL: deterministic detection of moments where an
 * on-screen graphic answers "help the viewer understand / feel / remember / keep
 * watching?". Values are re-derived from the transcript — LLM numbers are never
 * trusted. Intensity is budgeted (4–12 total cues/clip incl. motion) so graphics
 * enhance instead of overloading.
 *
 * Browser-safe: the output is plain data consumed by compose. No Node APIs.
 */
import type { Word } from './types.js';

/** An on-screen visual-storytelling graphic, aligned to the source timeline. */
export interface Graphic {
  type: 'stat' | 'progress' | 'list' | 'comparison' | 'timeline';
  t: number; // source-timeline seconds (comp time once mapped by prep)
  title?: string;
  value?: string; // stat
  from?: string; to?: string; // progress
  a?: string; b?: string; // comparison
  items?: (string | { when: string; label: string })[]; // list (strings) / timeline (when+label)
  reason: string; // why this graphic earns its place
}

/* ── budget (§15) ──────────────────────────────────────────────────────── */
export const BUDGET = { minMotion: 4, maxTotal: 12, maxGraphics: 4 };

/** Total meaningful motion cues (motion + graphics) a clip may carry. */
export function maxGraphics(motionCount: number): number {
  const headroom = BUDGET.maxTotal - motionCount;
  return Math.max(0, Math.min(BUDGET.maxGraphics, headroom));
}

/* ── spoken-word → number ──────────────────────────────────────────────── */
const SUFFIX_MULT: Record<string, number> = {
  k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, billion: 1e9,
  bn: 1e9, mn: 1e6, kr: 1e3,
};
const NUM_RE = /\$?\s*\d[\d,.]*/;

function parseSpokenNum(text: string): number | null {
  const m = text.match(NUM_RE);
  if (!m) return null;
  let n = parseFloat(m[0].replace(/[$,]/g, ''));
  if (Number.isNaN(n)) return null;
  const rest = text.slice(m.index! + m[0].length).toLowerCase();
  for (const [suffix, mult] of Object.entries(SUFFIX_MULT)) {
    if (rest.startsWith(suffix)) { n *= mult; break; }
  }
  return n;
}

function fmt(n: number): string {
  if (n >= 1e9) return `${trimNum(n / 1e9)}B`;
  if (n >= 1e6) return `${trimNum(n / 1e6)}M`;
  if (n >= 1e3) return `${trimNum(n / 1e3)}K`;
  return trimNum(n);
}
function trimNum(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/* ── detectors ─────────────────────────────────────────────────────────── */
interface Candidate extends Graphic {}

/** "2x" / "two times" / "double" → stat. */
function detectStat(text: string, t: number, words: Word[]): Candidate | null {
  const low = text.toLowerCase();
  let value: string | null = null;
  let reason = '';
  const mult = low.match(/(\d+(?:\.\d+)?)\s*(?:x\b|times?)/);
  if (mult) { value = `${mult[1]}x`; reason = 'spoken multiplier'; }
  else if (/\bdouble[d]?\b|\btwice\b|\btwice as\b/.test(low)) { value = '2x'; reason = 'spoken "double" claim'; }
  if (!value) return null;
  return { type: 'stat', t, value, title: titleFor('multiplier'), reason };
}

/** "$50K → $3M" style progressions → progress. */
function detectProgress(text: string, t: number, words: Word[]): Candidate | null {
  const amounts = [...text.matchAll(/\$?\s*\d[\d,.]*\s*(?:[kmb]n?|thousand|million|billion)?/gi)];
  if (amounts.length < 2) return null;
  const from = parseSpokenNum(amounts[0][0]);
  const to = parseSpokenNum(amounts[amounts.length - 1][0]);
  if (from == null || to == null || to <= from) return null;
  if (!/\b(from|to|now|went|grew|scaled|from zero)/i.test(text) && amounts.length < 3) return null;
  return {
    type: 'progress', t,
    from: fmt(from), to: fmt(to),
    title: titleFor('growth story'),
    reason: 'spoken number progression',
  };
}

/** Ordered "first/then/finally" or numbered lists → list. */
function detectList(text: string, t: number, words: Word[], after?: { text: string; t: number }): Candidate | null {
  const markers = /(?:first|second|third|fourth|fifth|number\s*one|number\s*two|number\s*three|then,?\s+(?:the\s+)?(?:next|second|third|fourth|fifth)\b|finally)/gi;
  const segHits = text.match(markers) || [];
  // Enumeration items may complete in the segment right after the opener
  // ("So the first thing I started doing…" / next: "…the second thing is captions.").
  const tailHits = after ? (after.text.match(markers) || []) : [];
  const all = [...segHits, ...tailHits];
  const count = all.length;
  const distinct = new Set(all.map((m) => m.toLowerCase().replace(/[^a-z]/g, ''))).size;
  if (count < 2 || distinct < 2) return null;
  const shown = Math.min(count, 4);
  return {
    type: 'list', t,
    title: titleFor(`${shown} key points`),
    items: Array.from({ length: shown }, (_, i) => itemLabel(i, /first|second/i.test(text))),
    reason: 'spoken ordered list',
  };
}
function itemLabel(i: number, named: boolean): string {
  if (!named) return `Point ${i + 1}`;
  return ['First', 'Second', 'Third', 'Fourth', 'Fifth'][i] || `Point ${i + 1}`;
}

/** "A vs B" / "the difference between X and Y" → comparison. */
function detectComparison(text: string, t: number, words: Word[]): Candidate | null {
  const vs = text.match(/the difference between\s+(.+?)\s+(?:and|vs\.?)\s+(.+)/i)
    || text.match(/(.+?)\s+vs\.?\s+(?:the\s+)?(.+?)[.!?]?\s*$/i)
    || text.match(/before\s+(.+?)\s+vs\.?\s+(.+?)[.!?]?\s*$/i);
  if (!vs) return null;
  const a = cleanSide(vs[1]); const b = cleanSide(vs[2]);
  if (a.length < 2 || b.length < 2) return null;
  return { type: 'comparison', t, a, b, title: titleFor('head-to-head'), reason: 'spoken comparison' };
}
function cleanSide(s: string): string {
  return s.replace(/^(so|that|the|my|your)\s+/i, '').replace(/[.!?]+$/, '').trim().slice(0, 24);
}

/** Time references ("in 90 days", "30 minutes") → timeline (single anchor). */
function detectTimeline(text: string, t: number, words: Word[]): Candidate | null {
  const m = text.match(/\bin\s+(\d+)\s+(day|days|week|weeks|month|months|year|years|hour|hours|minute|minutes|second|seconds)\b/i);
  if (!m) return null;
  return {
    type: 'timeline', t,
    items: [{ when: `${m[1]} ${m[2].toLowerCase()}s`, label: titleFor('checkpoint') }],
    reason: 'spoken time reference',
  };
}

function titleFor(base: string): string {
  return base.replace(/[.!?]+$/, '');
}

/* ── main ──────────────────────────────────────────────────────────────── */

/**
 * Detect at most one earned graphic in this transcript segment (plus, for
 * enumerations, the following segment when the cut gap is small). Deterministic:
 * same transcript → same graphics (reproducible renders).
 */
export function detectGraphics(text: string, t: number, words: Word[], after?: { text: string; t: number }): Candidate | null {
  const detectors: Array<(t: string, n: number, w: Word[], a?: { text: string; t: number }) => Candidate | null> = [
    detectProgress, detectStat, detectList, detectComparison, detectTimeline,
  ];
  for (const d of detectors) {
    const c = d(text, t, words, after);
    if (c) return c;
  }
  return null;
}
'''

FILES['apps/api/src/pipeline/qc-editorial.ts'] = r'''/**
 * qc-editorial.ts — editorial quality control + plan repair (spec §15, §19).
 *
 * Technical QC (render.ts) verifies the video is decodable. This module
 * verifies the EDIT is good: hook strength (something happens early), pacing
 * (no dead air between kept segments), effect budget (no cue overload), and
 * payoff placement (the major payoff lands in the back half). Issues trigger
 * trimOverload(), which revises the plan before render — a weak plan is
 * repaired, never just reported.
 *
 * Visual budget count = non-structural motion cues + graphics.
 * Structural cues (drift/settle/transition) are the baseline grammar and
 * don't spend budget.
 */
import type { ClipPlan, MotionCue, Plan } from './types.js';

export const EDITORIAL = {
  /** soft cap: above this, warn */
  maxVisual: 12,
  /** hard cap: above this, it's an issue → plan gets revised */
  hardVisual: 14,
  /** gap between kept segments longer than this is dead air (s) */
  maxDeadGap: 2.5,
  /** first on-screen cue must land within this of clip start (s) */
  maxHookGap: 1.5,
  /** major-payoff beat must sit at/after this fraction of the clip span */
  minPayoffPos: 0.55,
} as const;

const STRUCTURAL: MotionCue['kind'][] = ['drift', 'settle', 'transition'];

/** Budget spend of one clip: visible motion cues + graphics. */
export function visualCount(c: ClipPlan): number {
  const cues = (c.motion?.cues || []).filter((x) => !STRUCTURAL.includes(x.kind)).length;
  return cues + (c.graphics?.length || 0);
}

export interface EditorialReport {
  issues: string[]; // plan should be revised
  warnings: string[]; // acceptable, log for the record
}

export function editorialQc(plan: Plan): EditorialReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const c of plan.clips) {
    const span = c.sourceEnd - c.sourceStart;
    if (span <= 0) continue;

    // 1. effect budget (§15: ~4–12 meaningful cues per clip)
    const vc = visualCount(c);
    if (vc > EDITORIAL.hardVisual) issues.push(`${c.id}: ${vc} visual cues > ${EDITORIAL.hardVisual} — overload, trim`);
    else if (vc > EDITORIAL.maxVisual) warnings.push(`${c.id}: ${vc} visual cues > ${EDITORIAL.maxVisual} — busy`);

    // 2. pacing: dead air between kept segments
    for (let i = 1; i < c.segments.length; i++) {
      const gap = c.segments[i].start - c.segments[i - 1].end;
      if (gap > EDITORIAL.maxDeadGap)
        issues.push(`${c.id}: ${gap.toFixed(1)}s dead gap between segments (pacing hole)`);
    }

    // 3. hook strength: the first visible cue should land early
    const cueTs = [
      ...(c.motion?.cues || []).map((x) => x.t),
      ...(c.punchIns || []).map((x) => x.time),
      ...(c.callouts || []).map((x) => x.time),
      ...(c.graphics || []).map((x) => x.t),
    ];
    if (cueTs.length) {
      const first = Math.min(...cueTs) - c.sourceStart;
      if (first > EDITORIAL.maxHookGap)
        warnings.push(`${c.id}: first visual cue ${(first).toFixed(1)}s in — weak hook window`);
    } else {
      warnings.push(`${c.id}: no motion/graphics cues at all — flat edit`);
    }

    // 4. payoff placement: major payoff belongs in the back half
    const beats = c.retention?.beats || [];
    const payoff = beats.find((b) => b.role === 'major-payoff') || beats[beats.length - 1];
    if (payoff && beats.length > 1) {
      const rel = (payoff.t - c.sourceStart) / span;
      if (rel < EDITORIAL.minPayoffPos)
        warnings.push(`${c.id}: major payoff at ${(rel * 100).toFixed(0)}% of clip (want ≥ ${EDITORIAL.minPayoffPos * 100}%)`);
    }
  }

  return { issues, warnings };
}

/** Drop the lowest-value non-structural cues until the clip is under the hard cap. */
export function trimOverload(plan: Plan): boolean {
  let changed = false;
  for (const c of plan.clips) {
    const cues = c.motion?.cues;
    if (!cues) continue;
    // rank: pulse (most expendable) < impact < emphasis/lowerThird
    const rank = (k: MotionCue['kind']) => (k === 'pulse' ? 0 : k === 'impact' ? 2 : 3);
    let guard = 0;
    while (visualCount(c) > EDITORIAL.maxVisual && cues.length && guard++ < 32) {
      let idx = -1;
      let best = Infinity;
      cues.forEach((x, i) => {
        if (STRUCTURAL.includes(x.kind)) return;
        const r = rank(x.kind) + (x.intensity ?? 0.5) * 0.1;
        if (r < best) {
          best = r;
          idx = i;
        }
      });
      if (idx < 0) break; // only structural cues left
      cues.splice(idx, 1);
      changed = true;
    }
  }
  return changed;
}
'''


FILES['apps/api/src/ai/router.ts'] = r'''import {
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
'''
print('write-session-files: graphics.ts, qc-editorial.ts (tests written by write-session-tests.py)')
written = 0
for rel, content in FILES.items():
    p = os.path.join(ROOT, rel)
    if os.path.exists(p) and open(p).read() == content:
        print(f'  = {rel} (unchanged)')
        continue
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(content)
    written += 1
    print(f'  + {rel}')
print(f'done ({written} written)')
