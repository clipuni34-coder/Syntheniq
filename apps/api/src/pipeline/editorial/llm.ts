// Syntheniq — LLM editorial-decision layer.
//
// After transcription + coverage repair, the deterministic heuristic ranks
// every candidate window (fast, free, always available). The LLM then
// re-evaluates the top-K candidates with full transcript context plus
// structural/video signals, producing structured 0..1 scores and grounded
// evidence for each of the six dimensions.
//
// Rules:
//   - The heuristic is the safety layer: without an API key, on timeout,
//     on schema violation, or on any provider error, heuristic scores stand.
//   - LLM output is validated strictly per candidate; invalid candidates
//     fall back individually — one bad apple never spoils the ranking.
//   - Prompts cap context (transcript + 20 candidates per request) so cost
//     and latency stay bounded on long videos.
import {
  OPENAI_API_KEY,
  OPENAI_BASE_URL,
  OPENAI_EDITORIAL_MODEL,
  OPENAI_TIMEOUT_MS,
} from '../../config.js';
import type { Clip, Scores, Segment } from '../../types.js';

export class LlmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export interface LlmCandidateSignals {
  sceneCuts: number;
  speechRatio: number;
  energyVariance: number;
}

export interface LlmCandidate {
  id: string;
  start: number;
  end: number;
  text: string;
  signals: LlmCandidateSignals;
}

export interface LlmEvaluation {
  id: string;
  scores: Scores;
  /** Exactly 6 evidence strings: hook, curiosity, payoff, standalone, emotion, visual. */
  reasons: [string, string, string, string, string, string];
  title: string;
}

export interface LlmInput {
  transcriptContext: string;
  candidates: LlmCandidate[];
}

export interface LlmProvider {
  readonly name: string;
  evaluate(input: LlmInput): Promise<LlmEvaluation[]>;
}

const DIMS = ['hook', 'curiosity', 'payoff', 'standalone', 'emotion', 'visual'] as const;

const EVAL_SCHEMA = {
  type: 'object',
  properties: {
    evaluations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          scores: {
            type: 'object',
            properties: {
              hook: { type: 'number' },
              curiosity: { type: 'number' },
              payoff: { type: 'number' },
              standalone: { type: 'number' },
              emotion: { type: 'number' },
              visual: { type: 'number' },
            },
            required: ['hook', 'curiosity', 'payoff', 'standalone', 'emotion', 'visual'],
            additionalProperties: false,
          },
          reasons: { type: 'array', items: { type: 'string' } },
          title: { type: 'string' },
        },
        required: ['id', 'scores', 'reasons', 'title'],
        additionalProperties: false,
      },
    },
  },
  required: ['evaluations'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You are the senior editor in the Syntheniq cutting room.',
  'You judge short-form clip candidates from a long video. For each candidate you score six dimensions 0..1:',
  'hook (does the opening stop a cold scroller), curiosity (open loops that hold attention),',
  'payoff (result/lesson/how-to landed), standalone (makes sense with zero outside context),',
  'emotion (charged language and delivery energy), visual (cutting, motion and sound dynamics from the measured signals).',
  'Score from the candidate text and the provided video signals — never invent plot the transcript does not contain.',
  'Each of the 6 reasons must be one short evidence phrase (max 90 chars) grounded in the candidate.',
  'Order of reasons is fixed: hook, curiosity, payoff, standalone, emotion, visual.',
  'Titles are short headline-case phrases (max 64 chars), no clickbait lies, no emojis, no quotes.',
  'Return ONLY the JSON object matching the schema.',
].join(' ');

export function buildEditorialPrompt(input: LlmInput): { system: string; user: string } {
  const cands = input.candidates
    .map((c) => {
      const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
      return [
        `--- candidate ${c.id} (${mmss(c.start)}–${mmss(c.end)}) ---`,
        `transcript: """${c.text.slice(0, 2000)}"""`,
        `signals: sceneCuts=${c.signals.sceneCuts} speechRatio=${c.signals.speechRatio.toFixed(2)} energyVariance=${c.signals.energyVariance.toFixed(4)}`,
      ].join('\n');
    })
    .join('\n\n');
  return {
    system: SYSTEM_PROMPT,
    user: [
      'FULL VIDEO TRANSCRIPT (context — candidates are windows of this):',
      `"""${input.transcriptContext.slice(0, 12000)}"""`,
      '',
      'CANDIDATES TO EVALUATE:',
      cands,
    ].join('\n'),
  };
}

export function buildTranscriptContext(segments: Segment[] | undefined | null, maxChars = 12000): string {
  const lines = (segments || [])
    .filter((s) => s.text && s.text.trim())
    .map((s) => {
      const m = Math.floor(s.start / 60);
      const sec = Math.floor(s.start % 60);
      return `[${m}:${String(sec).padStart(2, '0')}] ${s.text.trim()}`;
    });
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxChars) {
      out += '\n[…transcript truncated for context window…]';
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const round3 = (v: number): number => Math.round(v * 1000) / 1000;

function cleanReason(s: unknown): string {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140) || '—';
}

// Strict per-candidate validation. Returns null for anything that does not
// fully conform — the caller keeps the heuristic scores for those.
export function validateEvaluation(raw: unknown): LlmEvaluation | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return null;
  const s = r.scores as Record<string, unknown> | null;
  if (!s || typeof s !== 'object') return null;
  const scores = {} as Scores;
  for (const d of DIMS) {
    const v = s[d];
    if (typeof v !== 'number' || !Number.isFinite(v)) return null;
    scores[d] = round3(clamp01(v));
  }
  if (!Array.isArray(r.reasons) || r.reasons.length !== 6) return null;
  if (!r.reasons.every((x) => typeof x === 'string' && x.trim().length > 0)) return null;
  return {
    id: r.id,
    scores,
    reasons: (r.reasons as string[]).map(cleanReason) as [string, string, string, string, string, string],
    title: String(r.title || '').trim().slice(0, 80),
  };
}

export function applyLlmEvaluations(clips: Clip[], evals: LlmEvaluation[]): { applied: number; skipped: number } {
  const byId = new Map(evals.map((e) => [e.id, e]));
  let applied = 0;
  let skipped = 0;
  for (const clip of clips) {
    const ev = byId.get(clip.id);
    if (!ev) {
      skipped++;
      continue;
    }
    clip.scores = { ...ev.scores };
    clip.total = round3(
      ev.scores.hook * 0.25 +
        ev.scores.curiosity * 0.2 +
        ev.scores.payoff * 0.2 +
        ev.scores.standalone * 0.15 +
        ev.scores.emotion * 0.1 +
        ev.scores.visual * 0.1
    );
    clip.reasons = [...ev.reasons];
    if (ev.title) clip.title = ev.title;
    clip.decidedBy = 'llm';
    applied++;
  }
  return { applied, skipped };
}

export type FetchImpl = (url: string, init?: Record<string, unknown>) => Promise<Response>;

export interface OpenAiEditorialOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  chunkSize?: number;
  fetchImpl?: FetchImpl;
}

function extractOutputText(payload: unknown): string {
  const p = payload as Record<string, unknown>;
  if (typeof p?.output_text === 'string' && p.output_text) return p.output_text;
  const output = (p?.output as unknown[]) || [];
  const texts: string[] = [];
  for (const item of output) {
    const it = item as Record<string, unknown>;
    const content = (it?.content as unknown[]) || [];
    for (const c of content) {
      const cc = c as Record<string, unknown>;
      if ((cc?.type === 'output_text' || cc?.type === 'text') && typeof cc.text === 'string') {
        texts.push(cc.text);
      }
    }
  }
  return texts.join('\n');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class OpenAiEditorialProvider implements LlmProvider {
  readonly name: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private timeoutMs: number;
  private chunkSize: number;
  private fetchImpl: FetchImpl;

  constructor(opts: OpenAiEditorialOptions = {}) {
    this.apiKey = opts.apiKey || OPENAI_API_KEY;
    this.baseUrl = (opts.baseUrl || OPENAI_BASE_URL).replace(/\/$/, '');
    this.model = opts.model || OPENAI_EDITORIAL_MODEL;
    this.timeoutMs = opts.timeoutMs ?? OPENAI_TIMEOUT_MS;
    this.chunkSize = Math.max(1, opts.chunkSize ?? 20);
    this.fetchImpl = opts.fetchImpl || ((fetch as unknown) as FetchImpl);
    this.name = `openai-responses (${this.model})`;
    if (!this.apiKey) throw new LlmError('OPENAI_API_KEY is not set');
  }

  async evaluate(input: LlmInput): Promise<LlmEvaluation[]> {
    if (!input.candidates.length) return [];
    const out: LlmEvaluation[] = [];
    let failures = 0;
    let lastErr: unknown = null;
    for (let i = 0; i < input.candidates.length; i += this.chunkSize) {
      const chunk = input.candidates.slice(i, i + this.chunkSize);
      try {
        const evals = await this.evaluateChunk(input.transcriptContext, chunk);
        out.push(...evals);
      } catch (err) {
        failures++;
        lastErr = err;
        if (failures > 2) {
          throw new LlmError(`editorial requests failing repeatedly: ${(err as Error).message}`);
        }
      }
    }
    if (!out.length && input.candidates.length > 0 && failures > 0) {
      const cause = lastErr instanceof Error ? lastErr.message : String(lastErr);
      throw new LlmError(`all editorial requests failed (${cause}) — heuristic scores stand`);
    }
    return out;
  }

  private async evaluateChunk(context: string, candidates: LlmCandidate[]): Promise<LlmEvaluation[]> {
    const { system, user } = buildEditorialPrompt({ transcriptContext: context, candidates });
    const body = {
      model: this.model,
      input: [
        { role: 'system', content: [{ type: 'input_text', text: system }] },
        { role: 'user', content: [{ type: 'input_text', text: user }] },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'editorial_evaluations', strict: true, schema: EVAL_SCHEMA },
      },
      max_output_tokens: 6000,
    };
    const raw = await this.postWithRetry('/responses', body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError('editorial model returned invalid JSON');
    }
    const list = (parsed as Record<string, unknown>)?.evaluations;
    if (!Array.isArray(list)) throw new LlmError('editorial response missing evaluations array');
    const valid: LlmEvaluation[] = [];
    for (const item of list) {
      const ev = validateEvaluation(item);
      if (ev) valid.push(ev);
    }
    return valid;
  }

  private async postWithRetry(pathname: string, body: unknown): Promise<string> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          const payload = (await res.json()) as unknown;
          const text = extractOutputText(payload);
          if (!text) throw new LlmError('editorial response carried no text');
          return text;
        }
        const retryable = res.status === 429 || res.status >= 500;
        const detail = await res.text().catch(() => '');
        lastErr = new LlmError(`editorial request failed (${res.status}): ${detail.slice(0, 300)}`);
        if (!retryable || attempt === 1) throw lastErr;
        await sleep(1500);
      } catch (err) {
        if (err instanceof LlmError && attempt === 1) throw err;
        if (err instanceof LlmError && (err.message.includes('(4') || err.message.includes('(400'))) throw err;
        lastErr = err;
        if (attempt === 1) {
          throw err instanceof LlmError ? err : new LlmError(`editorial request failed: ${(err as Error).message}`);
        }
        await sleep(1500);
      }
    }
    throw lastErr instanceof Error ? lastErr : new LlmError('editorial request failed');
  }
}

// Null when no key is configured — the pipeline then stays heuristic-only.
export function selectLlmProvider(): LlmProvider | null {
  if (!OPENAI_API_KEY) return null;
  try {
    return new OpenAiEditorialProvider();
  } catch {
    return null;
  }
}
