// Syntheniq — emotion detection + trajectory scoring for editorial planning.
import type { Segment, Word, Span } from '../../types.js';
import {
  EMOTION_CRISIS, EMOTION_REVELATION, EMOTION_RECOVERY,
  EMOTION_TAGS, TRAJECTORY_KEYWORDS,
} from './lexicons.js';

export type EmotionEventType = 'crisis' | 'revelation' | 'recovery' | 'payoff' | 'hook' | 'satisfaction' | 'transit';
export interface EmotionEvent {
  t: number;
  type: EmotionEventType;
  intensity: number;
  label: string;
}
export interface EmotionTrajectory {
  curve: Array<{ t: number; valence: number }>;
  label: string;
  summary: string;
}

export interface EmotionScore {
  tag: string;
  valence: number;
}
export interface EmotionIntelligence {
  events: EmotionEvent[];
  trajectory: EmotionTrajectory;
  overall: EmotionScore;
  segments: { tag: string; score: EmotionScore; t: number }[];
}

export function countMatches(text: string, lexicon: readonly string[]): number {
  const lower = text.toLowerCase();
  return lexicon.reduce((n, kw) => n + (kw.split(' ').length === 1
    ? (lower.match(new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi'))?.length || 0)
    : (lower.includes(kw) ? 1 : 0)), 0);
}

export function matchLexicon(text: string, lexicon: readonly string[]): string[] {
  const lower = text.toLowerCase();
  const matches: string[] = [];
  for (const kw of lexicon) {
    const re = new RegExp('\\b' + kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    if (re.test(lower)) matches.push(kw);
  }
  return matches;
}

function segText(s: Segment): string { return (s as any).text || ''; }

function r2(n: number): number { return Math.round(n * 100) / 100; }
function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

function dedupe(events: EmotionEvent[]): EmotionEvent[] {
  events.sort((a, b) => a.t - b.t);
  const out: EmotionEvent[] = [];
  const sameTypeWindow = 1.8;
  for (const e of events) {
    const prevSameType = out.filter((o) => o.type === e.type);
    if (prevSameType.length && e.t - prevSameType[prevSameType.length - 1].t < sameTypeWindow) continue;
    out.push({ ...e });
  }
  return out;
}

export function detectEmotionEvents(
  segments: Segment[], words: Word[], silences: Span[], start: number, end: number,
): EmotionEvent[] {
  const events: EmotionEvent[] = [];
  const segs = segments.filter((g) => g.end > start && g.start < end);

  for (const s of segs) {
    const text = segText(s);
    const mCrisis = countMatches(text, EMOTION_CRISIS);
    const mRev = countMatches(text, EMOTION_REVELATION);
    const mRec = countMatches(text, EMOTION_RECOVERY);
    const t = Math.min(end - 0.1, Math.max(start + 0.1, r2(s.start)));
    if (mCrisis > 0) events.push({ t, type: 'crisis', intensity: clamp(0.4 + mCrisis * 0.15, 0, 1), label: 'crisis' });
    if (mRev > 0) events.push({ t, type: 'revelation', intensity: clamp(0.5 + mRev * 0.1, 0, 1), label: 'revelation' });
    if (mRec > 0) events.push({ t, type: 'recovery', intensity: clamp(0.4 + mRec * 0.12, 0, 1), label: 'recovery' });
  }

  const crisisE = events.filter((e) => e.type === 'crisis');
  const revE = events.filter((e) => e.type === 'revelation');
  const recE = events.filter((e) => e.type === 'recovery');
  if (crisisE.length && !revE.some((r) => r.t > crisisE[0].t)) {
    events.push({ t: crisisE[0].t, type: 'revelation', intensity: 0.6, label: 'implied revelation' });
  }
  if (revE.length && !recE.some((r) => r.t > revE[0].t)) {
    events.push({ t: revE[0].t, type: 'recovery', intensity: 0.55, label: 'implied recovery' });
  }

  const sortedUnique = dedupe(events);
  if (!sortedUnique.some((e) => e.type === 'hook')) {
     const first = words.filter((w) => w.start >= start && w.start <= start + 1.5)[0];
    if (first) sortedUnique.push({ t: r2(first.start), type: 'hook', intensity: 0.45, label: 'opening hook' });
  }
  if (!sortedUnique.some((e) => e.type === 'satisfaction' && e.t >= end - 3)) {
    sortedUnique.push({ t: r2(end - 0.6), type: 'satisfaction', intensity: 0.5, label: 'closer' });
  }
  const last = sortedUnique.filter((e) => e.type === 'revelation' || e.type === 'payoff')[0];
  if (last) sortedUnique.push({ t: r2(last.t), type: 'payoff', intensity: Math.min(1, last.intensity + 0.2), label: 'emotional payoff' });

  return sortedUnique.sort((a, b) => a.t - b.t);
}

export function detectCuriosityEvents(segments: Segment[], start: number, end: number): EmotionEvent[] {
  const evs: EmotionEvent[] = [];
  const segs = segments.filter((g) => g.end > start && g.start < end);
  for (const s of segs) {
    const text = segText(s).toLowerCase();
    const score = ['why', 'how', 'what', 'who', 'when', 'which', 'question', 'secret', 'mystery', 'unknown', 'confusion'].reduce((n, q) => n + (text.includes(q) ? 1 : 0), 0);
    if (score >= 2) evs.push({ t: r2(s.start), type: 'crisis', intensity: clamp(0.3 + score * 0.1, 0, 1), label: 'curiosity gap' });
  }
  return evs;
}

export function deriveEmotionTrajectory(events: EmotionEvent[], start: number, end: number): EmotionTrajectory {
  const curve: Array<{ t: number; valence: number }> = [];
  const steps = 12;
  for (let i = 0; i <= steps; i++) {
    const t = start + (end - start) * (i / steps);
    let v = 0.5;
    for (const e of events) {
      const d = Math.abs(e.t - t);
      if (d < 6) {
        const mult = e.type === 'revelation' ? 0.28 : e.type === 'recovery' ? 0.22 : e.type === 'payoff' ? 0.35 : e.type === 'crisis' ? -0.18 : e.type === 'satisfaction' ? 0.15 : 0;
        v += mult * Math.exp(-d / 2) * e.intensity;
      }
    }
    curve.push({ t: r2(t), valence: r2(clamp(v, 0, 1)) });
  }
  const deltas = curve.slice(1).map((c, i) => c.valence - curve[i].valence);
  const rising = deltas.filter((d) => d > 0.02).length;
  const falling = deltas.filter((d) => d < -0.02).length;
  const hasRevelation = events.some((e) => e.type === 'revelation');
  let label: string;
  let summary: string;
  if (rising > falling && hasRevelation) { label = 'escalating'; summary = 'emotional energy builds through revelations'; }
  else if (falling > rising) { label = 'declining'; summary = 'emotional energy winds down over time'; }
  else if (curve.at(-1)!.valence > curve[0].valence) { label = 'uplifting'; summary = 'ends higher than it started'; }
  else { label = 'flat'; summary = 'emotional energy stays consistent'; }
  if (events.some((e) => e.type === 'crisis')) label = 'volatile-' + label;
  return { curve, label, summary };
}

export function deriveEmotionTag(keyphrases: string[]): string {
  const joined = keyphrases.join(' ').toLowerCase();
  for (const [tag] of Object.entries(EMOTION_TAGS)) {
    if (matchLexicon(joined, EMOTION_TAGS[tag].keywords).length > 0) return tag;
  }
  for (const [tk, words] of Object.entries(TRAJECTORY_KEYWORDS)) {
    if (words.some((w: string) => joined.includes(w))) return tk;
  }
  return 'neutral';
}

export function analyzeEmotion(
  segments: Segment[], words: Word[], silences: Span[], start: number, end: number,
  keyphrases: string[] = [],
): EmotionIntelligence {
  const events = detectEmotionEvents(segments, words, silences, start, end);
  const trajectory = deriveEmotionTrajectory(events, start, end);
  const tag = keyphrases.length > 0 ? deriveEmotionTag(keyphrases) : 'neutral';
  const segScores: { tag: string; score: EmotionScore; t: number }[] = [];
  for (const s of segments.filter((g) => g.end > start && g.start < end)) {
    const intensity = clamp(countMatches(segText(s), [...EMOTION_CRISIS, ...EMOTION_REVELATION, ...EMOTION_RECOVERY]) / 4, 0, 1);
    segScores.push({ tag, score: { tag, valence: 0.5 + (intensity - 0.5) * 0.5 }, t: r2((s.start + s.end) / 2) });
  }
  return {
    events,
    trajectory,
    overall: { tag, valence: trajectory.curve.at(-1)?.valence ?? 0.5 },
    segments: segScores,
  };
}
