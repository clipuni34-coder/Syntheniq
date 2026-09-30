// Syntheniq — retention scoring: predicts viewer engagement curves and
// segment-level retention based on structural and emotional signals.
// Feeds into motion planning (Phase 7) and edit decisions (Phase 8).
import type { EnergyPoint, Scores, Span } from '../../types.js';
import type { Segment, Word } from '../../types.js';
import type { EmotionEvent, EmotionTrajectory } from './emotion.js';
import { HOOK_OPENERS, CURIOSITY_MARKERS, PAYOFF_MARKERS } from './lexicons.js';

export type RetentionBeatRole =
  | 'teaser'
  | 'setup'
  | 'narrative'
  | 'curiosity'
  | 'payoff'
  | 'bridge'
  | 'closer';

export interface RetentionBeat {
  role: RetentionBeatRole;
  start: number;
  end: number;
  confidence: number;
  label: string;
  signals: string[];
}

export interface RetentionTeaser {
  text: string;
  duration: number;
}

export interface RetentionPlan {
  architecture: string;
  teaser?: RetentionTeaser;
  beats: RetentionBeat[];
  curve: Array<{ t: number; predicted: number }>;
  summary: string;
}

export interface RetentionScore {
  segment: { start: number; end: number };
  predicted: number;
  reasons: string[];
  signals: {
    energy: number;
    textDensity: number;
    hookPotential: number;
    payoffPotential: number;
    curiosity: number;
  };
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const r2 = (n: number): number => Math.round(n * 100) / 100;

function segText(s: Segment): string {
  return (s as any).text || '';
}

function avgEnergy(curve: EnergyPoint[] | undefined, start: number, end: number): number {
  const pts = (curve || []).filter((p) => p.t >= start && p.t <= end);
  if (!pts.length) return 0;
  return pts.reduce((a, p) => a + p.rms, 0) / pts.length;
}

function energyVariation(curve: EnergyPoint[] | undefined, start: number, end: number): number {
  const pts = (curve || []).filter((p) => p.t >= start && p.t <= end);
  if (pts.length < 2) return 0;
  const mean = pts.reduce((a, p) => a + p.rms, 0) / pts.length;
  return pts.reduce((a, p) => a + Math.abs(p.rms - mean), 0) / pts.length;
}

function textDensity(segments: Segment[], start: number, end: number): number {
  const dur = Math.max(0.001, end - start);
  let chars = 0;
  for (const s of segments) {
    if (s.end > start && s.start < end) {
      chars += segText(s).length;
    }
  }
  return r2(chars / dur);
}

function hookPotential(segments: Segment[], start: number, end: number, words: { start: number }[]): number {
  const text = segments
    .filter((s) => s.end > start && s.start < end && segText(s).trim())
    .map((s) => segText(s).trim())
    .join(' ')
    .toLowerCase();
  let score = 0.3;
  for (const marker of HOOK_OPENERS) {
    if (text.startsWith(marker)) score += 0.3;
  }
  const hasQuestion = text.includes('?');
  if (hasQuestion) score += 0.15;
  const earlyWords = words.filter((w) => w.start >= start && w.start <= start + 2);
  if (earlyWords.length > 0) score += 0.1;
  return clamp01(score);
}

function payoffPotential(segments: Segment[], start: number, end: number): number {
  const text = segments
    .filter((s) => s.end > start && s.start < end && segText(s).trim())
    .map((s) => segText(s).trim())
    .join(' ')
    .toLowerCase();
  let score = 0.25;
  for (const marker of PAYOFF_MARKERS) {
    if (text.includes(marker)) score += 0.25;
  }
  if (text.includes('finally') || text.includes('in the end')) score += 0.15;
  if (text.includes("here's how") || text.includes('this is how')) score += 0.1;
  const hasNumber = /\b\d+(\.\d+)?\b/.test(text);
  if (hasNumber) score += 0.1;
  return clamp01(score);
}

function curiosityScore(segments: Segment[], start: number, end: number): number {
  const text = segments
    .filter((s) => s.end > start && s.start < end && segText(s).trim())
    .map((s) => segText(s).trim())
    .join(' ')
    .toLowerCase();
  let score = 0.2;
  for (const marker of CURIOSITY_MARKERS) {
    if (text.includes(marker)) score += 0.15;
  }
  const questionCount = (text.match(/\?/g) || []).length;
  score += Math.min(0.3, questionCount * 0.1);
  if (text.includes('but') || text.includes('however')) score += 0.1;
  return clamp01(score);
}

function classifyBeat(
  idx: number,
  total: number,
  start: number,
  end: number,
  segments: Segment[],
  emotionEvents: EmotionEvent[],
  words: { start: number }[],
  energyCurve: EnergyPoint[] | undefined,
  duration: number
): RetentionBeat {
  const text = segText(segments.find((s) => s.end > start && s.start < end) || ({} as Segment));
  const signals: string[] = [];
  let role: RetentionBeatRole = 'narrative';
  let confidence = 0.5;
  let label = 'segment';

  const avgE = avgEnergy(energyCurve, start, end);
  const varE = energyVariation(energyCurve, start, end);
  const hooks = hookPotential(segments, start, end, words);
  const payoffs = payoffPotential(segments, start, end);
  const curiosity = curiosityScore(segments, start, end);

  const earlyCutoff = duration * 0.15;
  const lateCutoff = duration * 0.85;

  if (idx === 0 && start < earlyCutoff) {
    role = 'teaser';
    confidence = clamp01(0.6 + hooks * 0.3);
    label = 'opening hook';
    if (hooks > 0.5) signals.push('hook_opener', 'question');
  } else if (idx === total - 1 && end > lateCutoff) {
    role = 'closer';
    confidence = clamp01(0.5 + payoffs * 0.4);
    label = 'closing payoff';
    if (payoffs > 0.5) signals.push('payoff_marker');
  } else if (curiosity > 0.5) {
    role = 'curiosity';
    confidence = clamp01(0.4 + curiosity * 0.5);
    label = 'curiosity gap';
    signals.push('open_loop', 'transition_cue');
  } else if (payoffs > 0.5) {
    role = 'payoff';
    confidence = clamp01(0.5 + payoffs * 0.4);
    label = 'emotional payoff';
    signals.push('payoff_marker', 'resolution');
  } else if (hooks > 0.45) {
    role = 'bridge';
    confidence = clamp01(0.4 + hooks * 0.3);
    label = 'transition hook';
    signals.push('setup_cue');
  } else {
    role = 'narrative';
    confidence = 0.4;
    label = 'narrative body';
    if (varE > 0.01) signals.push('energy_shift');
    if (avgE > 0.05) signals.push('voice_active');
  }

  const eventAt = emotionEvents.find((e) => Math.abs(e.t - (start + end) / 2) < 2);
  if (eventAt) {
    signals.push(`emotion:${eventAt.type}`);
    confidence = clamp01(confidence + 0.1);
  }

  return { role, start: r2(start), end: r2(end), confidence: r2(confidence), label, signals };
}

export function scoreSegmentRetention(
  start: number,
  end: number,
  context: {
    segments: Segment[];
    words: { start: number }[];
    energyCurve?: EnergyPoint[];
    silence?: Span[];
  }
): RetentionScore {
  const { segments, words, energyCurve, silence = [] } = context;
  const avgE = avgEnergy(energyCurve, start, end);

  const inSilence = silence.filter((s) => {
    const overlap = Math.min(end, s.end) - Math.max(start, s.start);
    return overlap > 0;
  }).reduce((a, s) => a + (Math.min(end, s.end) - Math.max(start, s.start)), 0);

  const silenceRatio = inSilence / Math.max(0.001, end - start);

  const hook = hookPotential(segments, start, end, words);
  const payoff = payoffPotential(segments, start, end);
  const curiosity = curiosityScore(segments, start, end);
  const density = textDensity(segments, start, end);

  let predicted = 0.3 + avgE * 0.15 + (1 - silenceRatio) * 0.2 + hook * 0.15 + payoff * 0.1 + curiosity * 0.1;
  predicted = clamp01(predicted);

  const reasons: string[] = [];
  if (hook > 0.4) reasons.push('Strong opening hook potential');
  if (payoff > 0.4) reasons.push('Contains payoff language');
  if (curiosity > 0.4) reasons.push('Creates curiosity gap');
  if (silenceRatio > 0.2) reasons.push(`High silence ratio (${Math.round(silenceRatio * 100)}%)`);
  if (avgE > 0.03) reasons.push('Active voice energy');
  if (density > 8) reasons.push('Dense, information-rich text');
  if (!reasons.length) reasons.push('Steady but unremarkable');

  return {
    segment: { start: r2(start), end: r2(end) },
    predicted: r2(predicted),
    reasons,
    signals: {
      energy: r2(avgE),
      textDensity: r2(density),
      hookPotential: r2(hook),
      payoffPotential: r2(payoff),
      curiosity: r2(curiosity),
    },
  };
}

export function buildRetentionCurve(
  segments: Segment[],
  words: { start: number }[],
  energyCurve: EnergyPoint[] | undefined,
  silences: Span[],
  start: number,
  end: number,
  steps: number = 24
): Array<{ t: number; predicted: number }> {
  const curve: Array<{ t: number; predicted: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const t = start + ((end - start) * i) / steps;
    const w = 1.5;
    const score = scoreSegmentRetention(t - w / 2, t + w / 2, { segments, words, energyCurve, silence: silences });
    curve.push({ t: r2(t), predicted: score.predicted });
  }
  return curve;
}

export function classifyRetentionBeats(
  segments: Segment[],
  words: { start: number }[],
  emotionEvents: EmotionEvent[],
  energyCurve: EnergyPoint[] | undefined,
  silences: Span[],
  duration: number,
  boundaries: number[] = []
): RetentionBeat[] {
  const cuts = boundaries.length
    ? [...new Set([0, ...boundaries, duration])].sort((a, b) => a - b)
    : [];

  if (cuts.length < 3) {
    const segCount = 8;
    for (let i = 0; i < segCount - 1; i++) {
      cuts.push((duration * (i + 1)) / segCount);
    }
    cuts.sort((a, b) => a - b);
    cuts.unshift(0);
    cuts.push(duration);
  }

  const beats: RetentionBeat[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const s = cuts[i];
    const e = cuts[i + 1];
    if (e - s < 1) continue;
    beats.push(classifyBeat(i, cuts.length - 1, s, e, segments, emotionEvents, words, energyCurve, duration));
  }
  return beats;
}

export function scoreRetentionArchitecture(
  beats: RetentionBeat[],
  trajectory: EmotionTrajectory | undefined,
  segments: Segment[],
  words: { start: number }[],
  energyCurve: EnergyPoint[] | undefined,
  silences: Span[],
  duration: number
): RetentionPlan {
  const curve = buildRetentionCurve(segments, words, energyCurve, silences, 0, duration);

  const architectures = {
    'problem-solution': ['crisis', 'payoff', 'resolution'],
    'curiosity-payoff': ['hook', 'curiosity', 'payoff', 'closer'],
    'emotional-arc': ['teaser', 'crisis', 'revelation', 'recovery', 'payoff', 'closer'],
    'energy-sustain': ['hook', 'narrative', 'bridge', 'payoff', 'closer'],
  };

  let bestArch = 'curiosity-payoff';
  let bestMatch = 0;
  for (const [arch, roles] of Object.entries(architectures)) {
    let match = 0;
    for (const beat of beats) {
      const beatRoles = roles as string[];
      if (beatRoles.includes(beat.role) || beatRoles.includes(beat.signals.find((s) => s.startsWith('emotion:'))?.replace('emotion:', '') || '')) {
        match++;
      }
    }
    if (match > bestMatch) {
      bestMatch = match;
      bestArch = arch;
    }
  }

  const trajLabel = trajectory?.label || 'stable';
  if (trajLabel.includes('escalating') && bestArch !== 'emotional-arc') {
    bestArch = 'emotional-arc';
  }

  const teaser: RetentionTeaser | undefined =
    beats.length > 0 && beats[0].role === 'teaser'
      ? { text: beats[0].label, duration: beats[0].end - beats[0].start }
      : undefined;

  const summary = `Architecture: ${bestArch} | ${beats.length} beats | trajectory: ${trajLabel}`;

  return {
    architecture: bestArch,
    teaser,
    beats,
    curve,
    summary,
  };
}
