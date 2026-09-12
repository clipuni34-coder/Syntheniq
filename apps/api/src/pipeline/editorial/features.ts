// Syntheniq — six-dimension clip scoring with human-readable evidence.
import { weightedTotal } from './weights.js';
import {
  HOOK_OPENERS,
  CURIOSITY_MARKERS,
  PAYOFF_MARKERS,
  EMOTION_POSITIVE,
  EMOTION_NEGATIVE,
  INTENSIFIERS,
  LEADING_PRONOUNS,
  CTA_PHRASES,
  FILLERS,
} from './lexicons.js';
import type { EnergyPoint, Scores, Span } from '../../types.js';

export interface Candidate {
  start: number;
  end: number;
  text: string;
  sentences: string[];
}

export interface ScoreContext {
  sceneCuts?: number[];
  energyCurve?: EnergyPoint[];
  speechActive?: Span[];
}

interface DimScore {
  score: number;
  reasons: string[];
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

const countMatches = (text: string, phrases: string[]): number => {
  let n = 0;
  for (const p of phrases) {
    const re = new RegExp(`\\b${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    const m = text.match(re);
    if (m) n += m.length;
  }
  return n;
};

const wordsOf = (text: string): string[] => String(text || '').toLowerCase().split(/\s+/).filter(Boolean);

function scoreHook(sentences: string[]): DimScore {
  const reasons: string[] = [];
  let score = 0.3;
  const first = (sentences[0] || '').trim();
  const firstWords = wordsOf(first);
  if (!first) return { score: 0.2, reasons: ['No opening line'] };

  if (/\?\s*$/.test(first)) {
    score += 0.3;
    reasons.push('Opens with a question');
  }
  const head = firstWords.slice(0, 4).join(' ');
  const opener = HOOK_OPENERS.find((o) => head.startsWith(o) || (firstWords[0] === o.split(' ')[0] && head.includes(o)));
  if (opener || /^\d/.test(first.trim())) {
    score += 0.22;
    reasons.push(`Strong opener: “${first.slice(0, 42)}${first.length > 42 ? '…' : ''}”`);
  }
  if (firstWords.length > 0 && firstWords.length <= 12) {
    score += 0.12;
    if (!reasons.length) reasons.push('Punchy opening line');
  }
  if (/\byou\b/i.test(first)) {
    score += 0.1;
    reasons.push('Speaks directly to the viewer');
  }
  if (firstWords.length > 30) {
    score -= 0.15;
    reasons.push('Opening rambles before landing');
  }
  if (!reasons.length) reasons.push('Neutral opening');
  return { score: clamp01(score), reasons };
}

function scoreCuriosity(text: string, sentences: string[]): DimScore {
  const reasons: string[] = [];
  let score = 0.25;
  const markers = countMatches(text, CURIOSITY_MARKERS);
  if (markers > 0) {
    score += Math.min(0.5, markers * 0.17);
    reasons.push(`${markers} curiosity cue${markers > 1 ? 's' : ''} (“but…”, “until…”, “turns out…”)`);
  }
  const questions = sentences.filter((s) => /\?\s*$/.test(s.trim())).length;
  const openLoops = Math.max(0, questions - 1);
  if (openLoops > 0) {
    score += Math.min(0.22, openLoops * 0.11);
    reasons.push('Keeps asking — open loops hold attention');
  }
  const youCount = (text.toLowerCase().match(/\byou\b/g) || []).length;
  if (youCount >= 2) {
    score += Math.min(0.12, youCount * 0.04);
    reasons.push('Keeps the viewer in the story');
  }
  if (!reasons.length) reasons.push('Plays it straight, little tension');
  return { score: clamp01(score), reasons };
}

function scorePayoff(sentences: string[]): DimScore {
  const reasons: string[] = [];
  let score = 0.25;
  if (!sentences.length) return { score: 0.2, reasons: ['No closing line'] };
  const tailCount = Math.max(1, Math.ceil(sentences.length * 0.4));
  const tail = sentences.slice(-tailCount).join(' ');
  const markers = countMatches(tail, PAYOFF_MARKERS);
  if (markers > 0) {
    score += Math.min(0.55, markers * 0.2);
    reasons.push('Lands a payoff — result, lesson or how-to');
  }
  const imperatives = countMatches(tail, ['do this', 'try this', 'remember', 'start', 'stop', 'never forget']);
  if (imperatives > 0) {
    score += 0.1;
    reasons.push('Ends with a clear takeaway');
  }
  const last = sentences[sentences.length - 1].trim();
  if (/[.!…]\s*$/.test(last)) score += 0.08;
  else if (/\?\s*$/.test(last)) {
    score -= 0.08;
    reasons.push('Ends on an unanswered question');
  }
  if (!reasons.length) reasons.push('Fades out without a clear payoff');
  return { score: clamp01(score), reasons };
}

function scoreStandalone(text: string, sentences: string[], duration: number): DimScore {
  const reasons: string[] = [];
  let score = 0.55;
  const first = (sentences[0] || '').trim().toLowerCase();
  const leadWord = (first.match(/^[a-z']+/) || [''])[0];
  if (LEADING_PRONOUNS.includes(leadWord)) {
    score -= 0.18;
    reasons.push('Starts mid-thought (“it / this / they…”)');
  }
  let entities = 0;
  for (const s of sentences) {
    const ws = s.trim().split(/\s+/).slice(1);
    entities += ws.filter((w) => /^[A-Z][a-z]/.test(w)).length;
  }
  if (entities > 0) {
    score += Math.min(0.18, entities * 0.06);
    reasons.push('Self-contained — names its own context');
  }
  if (duration >= 25 && duration <= 45) {
    score += 0.12;
    reasons.push('Ideal short length');
  } else if (duration < 18 || duration > 58) {
    score -= 0.1;
    reasons.push(duration < 18 ? 'Very short — may feel thin' : 'Long for a short — may drag');
  }
  const cta = countMatches(text, CTA_PHRASES);
  if (cta > 0) {
    score -= Math.min(0.3, 0.25 * cta);
    reasons.push('Contains promo/CTA baggage');
  }
  const filler = countMatches(text.toLowerCase(), FILLERS);
  const density = filler / Math.max(1, wordsOf(text).length);
  if (density > 0.04) {
    score -= Math.min(0.15, density * 2);
    reasons.push('Filler-heavy delivery');
  }
  if (!reasons.length) reasons.push('Stands on its own');
  return { score: clamp01(score), reasons };
}

export interface EnergyStats {
  mean: number;
  variance: number;
}

function scoreEmotion(text: string, energyStats: EnergyStats): DimScore {
  const reasons: string[] = [];
  const lower = text.toLowerCase();
  const pos = countMatches(lower, EMOTION_POSITIVE);
  const neg = countMatches(lower, EMOTION_NEGATIVE);
  const excl = (text.match(/!/g) || []).length;
  const inten = countMatches(lower, INTENSIFIERS);
  let score = 0.3 + Math.min(0.4, (pos + neg) * 0.12) + Math.min(0.12, excl * 0.06) + Math.min(0.1, inten * 0.03);
  if (pos + neg > 0) reasons.push(`Emotional language (${pos + neg} charged word${pos + neg > 1 ? 's' : ''})`);
  if (excl > 0) reasons.push('High-energy delivery');
  if (energyStats && energyStats.variance > 0.012) {
    score += 0.08;
    reasons.push('Voice dynamics rise and fall');
  }
  if (!reasons.length) reasons.push('Even, neutral tone');
  return { score: clamp01(score), reasons };
}

function scoreVisual(
  duration: number,
  cutsInRange: number,
  energyStats: EnergyStats,
  speechRatio: number
): DimScore {
  const reasons: string[] = [];
  const per10s = duration > 0 ? (cutsInRange / duration) * 10 : 0;
  let score: number;
  if (cutsInRange === 0) {
    score = 0.38;
    reasons.push('Single static shot');
  } else if (per10s <= 4) {
    score = 0.55 + per10s * 0.08;
    reasons.push(`${cutsInRange} visual cut${cutsInRange > 1 ? 's' : ''} keep it moving`);
  } else if (per10s <= 8) {
    score = 0.87 - (per10s - 4) * 0.05;
    reasons.push('Fast cutting — high energy');
  } else {
    score = 0.6;
    reasons.push('Frenetic cutting may overwhelm captions');
  }
  if (energyStats && energyStats.variance > 0.015) {
    score += 0.08;
    reasons.push('Dynamic sound keeps ears engaged');
  }
  if (speechRatio >= 0.75) {
    score += 0.07;
    reasons.push('Dense speech — no dead air');
  } else if (speechRatio < 0.35) {
    score -= 0.12;
    reasons.push('Thin speech — stretches of quiet');
  }
  return { score: clamp01(score), reasons };
}

export function energyInRange(curve: EnergyPoint[] | undefined, start: number, end: number): EnergyStats {
  const pts = (curve || []).filter((p) => p.t >= start && p.t <= end).map((p) => p.rms);
  if (!pts.length) return { mean: 0, variance: 0 };
  const mean = pts.reduce((a, b) => a + b, 0) / pts.length;
  const variance = pts.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pts.length;
  return { mean, variance };
}

export function speechRatioInRange(speechActive: Span[] | undefined, start: number, end: number): number {
  const dur = Math.max(0.001, end - start);
  let covered = 0;
  for (const s of speechActive || []) {
    covered += Math.max(0, Math.min(end, s.end) - Math.max(start, s.start));
  }
  return Math.max(0, Math.min(1, covered / dur));
}

export function scoreCandidate(
  candidate: Candidate,
  context: ScoreContext = {}
): { scores: Scores; total: number; reasons: string[] } {
  const { start, end, text = '', sentences = [] } = candidate;
  const duration = Math.max(0.1, end - start);
  const { sceneCuts = [], energyCurve = [], speechActive = [] } = context;

  const hasText = text.trim().length > 0;
  const cutsInRange = sceneCuts.filter((t) => t >= start && t <= end).length;
  const energyStats = energyInRange(energyCurve, start, end);
  const speechRatio = speechRatioInRange(speechActive, start, end);

  const visual = scoreVisual(duration, cutsInRange, energyStats, speechRatio);

  let hook: DimScore;
  let curiosity: DimScore;
  let payoff: DimScore;
  let standalone: DimScore;
  let emotion: DimScore;
  if (!hasText) {
    const neutral: DimScore = {
      score: 0.5,
      reasons: ['Audio-only analysis — no transcript for this passage'],
    };
    hook = curiosity = payoff = standalone = emotion = neutral;
  } else {
    hook = scoreHook(sentences);
    curiosity = scoreCuriosity(text, sentences);
    payoff = scorePayoff(sentences);
    standalone = scoreStandalone(text, sentences, duration);
    emotion = scoreEmotion(text, energyStats);
  }

  const scores: Scores = {
    hook: round3(hook.score),
    curiosity: round3(curiosity.score),
    payoff: round3(payoff.score),
    standalone: round3(standalone.score),
    emotion: round3(emotion.score),
    visual: round3(visual.score),
  };
  const total = round3(weightedTotal(scores));
  const reasons = [
    ...hook.reasons.slice(0, 1),
    ...curiosity.reasons.slice(0, 1),
    ...payoff.reasons.slice(0, 1),
    ...standalone.reasons.slice(0, 1),
    ...visual.reasons.slice(0, 1),
  ].slice(0, 6);

  return { scores, total, reasons };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
