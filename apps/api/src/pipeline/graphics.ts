/**
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
