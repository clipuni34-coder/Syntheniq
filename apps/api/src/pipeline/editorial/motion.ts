// Syntheniq — motion-graphics engine for Phase 11 visual treatments.
// Generates deterministic FFmpeg drawtext/drawbox/drawline filters for:
//   - Emphasis cues: underline, box, circle, arrow
//   - Impact cues: flash, camera shake (zoom + slight offset)
//   - Lower-third cues: animated topic bars
//   - Punch-in cues: smooth zoom from wide to tight
//   - Transition cues: flash, wipe, pulse
//
// Everything is pure function: inputs (cues + media info) -> filter strings.
// No Math.random, no Date.now — variants chosen by index and signal values.
import type { EmotionEvent } from './emotion.js';
import type { RetentionBeat } from './retention.js';
import { EXPORT_SPEC } from '../render/index.js';

export type CueKind =
  | 'emphasis'
  | 'impact'
  | 'lower_third'
  | 'punch_in'
  | 'transition'
  | 'pulse'
  | 'settle';

export type EmphasisVariant = 'underline' | 'box' | 'circle' | 'arrow';
export type TransitionVariant = 'flash' | 'wipe' | 'pulse';

export interface MotionCue {
  kind: CueKind;
  t: number;
  duration: number;
  intensity?: number;
  label: string;
  variant?: string;
  target?: { x: number; y: number };
  word?: string;
}

export interface MotionPlan {
  cues: MotionCue[];
  summary: string;
}

export interface MediaInfo {
  width: number;
  height: number;
  fps: number;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function safeNum(v: unknown, d = 0): number {
  return typeof v === 'number' && isFinite(v) ? v : d;
}

function wordToFilter(word: string, variant: EmphasisVariant): string {
  switch (variant) {
    case 'underline':
      return 'drawtext=text={TEXT}:fontsize={SIZE}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4:line_spacing=-10:y=h-th-20:x=(w-text_w)/2';
    case 'box':
      return 'drawtext=text={TEXT}:fontsize={SIZE}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=6:line_spacing=4:y=h-th-30:x=(w-text_w)/2';
    case 'circle':
      return 'drawtext=text={TEXT}:fontsize={SIZE}:fontcolor=white:box=1:boxcolor=black@0.5:boxborderw=8:line_spacing=4:y=h-th-30:x=(w-text_w)/2';
    case 'arrow':
      return 'drawtext=text={TEXT}:fontsize={SIZE}:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=4:line_spacing=4:y=h-th-20:x=(w-text_w)/2,';
  }
}

function emphasisFilters(cue: MotionCue, media: MediaInfo): string[] {
  const word = cue.word || cue.label;
  const variant = (cue.variant as EmphasisVariant) || 'underline';
  const fontSize = 64 + Math.floor((safeNum(cue.intensity) || 0.5) * 32);
  const base = wordToFilter(word, variant);
  const filter = base
    .replace('{TEXT}', word.replace(/:/g, ''))
    .replace('{SIZE}', String(fontSize));

  if (variant === 'arrow') {
    const tx = safeNum(cue.target?.x, media.width / 2) | 0;
    const ty = safeNum(cue.target?.y, media.height / 2) | 0;
    return [
      filter,
      `drawline=x1=${tx - 20}:y1=${ty - 20}:x2=${tx + 20}:y2=${ty + 20}:color=yellow@0.8:thickness=3`,
      `drawline=x1=${tx + 20}:y1=${ty - 20}:x2=${tx - 20}:y2=${ty + 20}:color=yellow@0.8:thickness=3`,
    ];
  }
  if (variant === 'circle') {
    const radius = 30 + Math.floor((safeNum(cue.intensity) || 0.5) * 20);
    const tx = safeNum(cue.target?.x, media.width / 2) | 0;
    const ty = safeNum(cue.target?.y, media.height / 2) | 0;
    return [filter, `drawbox=x=${tx - radius}:y=${ty - radius}:w=${radius * 2}:h=${radius * 2}:radius=${radius}:color=yellow@0.6:thickness=3`];
  }
  if (variant === 'box') {
    const tx = safeNum(cue.target?.x, media.width / 2) | 0;
    const ty = safeNum(cue.target?.y, media.height / 2) | 0;
    return [filter, `drawbox=x=${tx - 40}:y=${ty - 20}:w=80:h=40:color=yellow@0.5:thickness=2`];
  }
  return [filter];
}

function impactFilters(cue: MotionCue, media: MediaInfo): string[] {
  const intensity = safeNum(cue.intensity, 0.5);
  const flashAlpha = String(clamp(intensity * 0.5, 0.1, 0.5));
  const shakePixels = Math.floor(intensity * 30 + 10);
  const scaleFactor = 1 + intensity * 0.1;
  const scaledW = Math.round(media.width * scaleFactor);
  const scaledH = Math.round(media.height * scaleFactor);
  const offsetX = shakePixels;
  const offsetY = shakePixels;

  return [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease,pad=${media.width}:${media.height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    `crop=${media.width - offsetX}:${media.height - offsetX}:${offsetX}:${offsetX}`,
    `drawbox=x=0:y=0:w=iw:h=ih:color=white@${flashAlpha}:t=fill`,
  ];
}

function lowerThirdFilters(cue: MotionCue, media: MediaInfo): string[] {
  const text = cue.word || cue.label;
  const fontSize = 48;
  const barHeight = 80;
  const barY = media.height - barHeight;
  const slideFromY = barY + barHeight;

  return [
    `drawbox=x=0:y=${slideFromY}:w=iw:h=${barHeight}:color=black@0.8:t=fill`,
    `drawtext=text=${text}:fontsize=${fontSize}:fontcolor=white:x=20:y=${barY + 20}`,
  ];
}

function punchInFilters(cue: MotionCue, media: MediaInfo): string[] {
  const intensity = safeNum(cue.intensity, 0.5);
  const zoomLevels = [1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0];
  const idx = Math.floor(intensity * (zoomLevels.length - 1));
  const targetScale = zoomLevels[idx];
  const scaledW = Math.round(media.width * targetScale);
  const scaledH = Math.round(media.height * targetScale);

  return [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease`,
    `crop=${media.width}:${media.height}:(iw-${media.width})/2:(ih-${media.height})/2`,
  ];
}

function transitionFilters(cue: MotionCue, media: MediaInfo): string[] {
  const variant = (cue.variant as TransitionVariant) || 'flash';
  const intensity = safeNum(cue.intensity, 0.5);

  switch (variant) {
    case 'flash': {
      const alpha = clamp(intensity * 0.6, 0.1, 0.6);
      return [`drawbox=x=0:y=0:w=iw:h=ih:color=white@${alpha}:t=fill:d=${r2(cue.duration)}`];
    }
    case 'wipe':
      return [`wipe=horizontal:1:${r2(cue.duration)}:0x000000`];
    case 'pulse': {
      const alpha = clamp(intensity * 0.3, 0.05, 0.3);
      return [`drawbox=x=0:y=0:w=iw:h=ih:color=yellow@${alpha}:t=fill:d=${r2(cue.duration)}:nb=2`];
    }
    default:
      return [];
  }
}

function settleFilters(cue: MotionCue, media: MediaInfo): string[] {
  const zoom = 1.05;
  const scaledW = Math.round(media.width * zoom);
  const scaledH = Math.round(media.height * zoom);
  return [
    `scale=${scaledW}:${scaledH}:force_original_aspect_ratio=decrease`,
    `crop=${media.width}:${media.height}:(iw-${media.width})/2:(ih-${media.height})/2`,
  ];
}

const FILTER_BUILDERS: Record<CueKind, (cue: MotionCue, media: MediaInfo) => string[]> = {
  emphasis: emphasisFilters,
  impact: impactFilters,
  lower_third: lowerThirdFilters,
  punch_in: punchInFilters,
  transition: transitionFilters,
  pulse: transitionFilters,
  settle: settleFilters,
};

export function buildCueFilters(cue: MotionCue, media: MediaInfo): string[] {
  const builder = FILTER_BUILDERS[cue.kind];
  if (!builder) return [];
  return builder(cue, media);
}

export function selectEmphasisVariant(word: string, intensity: number): EmphasisVariant {
  if (!word) return 'underline';
  const hash = Array.from(word).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const variants: EmphasisVariant[] = ['underline', 'box', 'circle', 'arrow'];
  const idx = Math.floor(hash % variants.length);
  if (intensity > 0.8) return 'box';
  if (intensity > 0.6) return 'circle';
  if (intensity > 0.4) return 'arrow';
  return variants[idx];
}

export function selectTransitionVariant(intensity: number): TransitionVariant {
  if (intensity > 0.7) return 'flash';
  if (intensity > 0.4) return 'wipe';
  return 'pulse';
}

function deriveCuesFromEmotion(
  events: EmotionEvent[],
  media: MediaInfo,
  duration: number
): MotionCue[] {
  const cues: MotionCue[] = [];
  for (const e of events) {
    if (e.type === 'revelation' || e.type === 'payoff') {
      cues.push({
        kind: 'impact',
        t: e.t,
        duration: 1.5,
        intensity: e.intensity,
        label: e.label,
        variant: 'flash',
      });
    } else if (e.type === 'crisis') {
      cues.push({
        kind: 'punch_in',
        t: e.t,
        duration: 2,
        intensity: e.intensity * 0.8,
        label: 'crash in',
      });
    } else if (e.type === 'recovery') {
      cues.push({
        kind: 'settle',
        t: e.t,
        duration: 2,
        intensity: e.intensity,
        label: 'recenter',
      });
    }
  }
  return cues;
}

function deriveCuesFromRetention(
  beats: RetentionBeat[],
  media: MediaInfo,
  duration: number
): MotionCue[] {
  const cues: MotionCue[] = [];
  for (const beat of beats) {
    if (beat.role === 'teaser') {
      cues.push({
        kind: 'impact',
        t: beat.start,
        duration: 1,
        intensity: 0.6,
        label: 'hook',
        variant: 'flash',
      });
    } else if (beat.role === 'payoff') {
      cues.push({
        kind: 'punch_in',
        t: beat.start,
        duration: 2,
        intensity: 0.7,
        label: 'payoff highlight',
      });
      cues.push({
        kind: 'transition',
        t: beat.end,
        duration: 1.5,
        intensity: Math.min(1, 0.6 + beat.confidence * 0.3),
        label: 'payoff transition',
        variant: selectTransitionVariant(Math.min(1, 0.6 + beat.confidence * 0.3)),
      });
    } else if (beat.role === 'curiosity') {
      cues.push({
        kind: 'emphasis',
        t: beat.start,
        duration: 2,
        intensity: 0.75,
        label: 'question',
        word: '?',
        variant: selectEmphasisVariant(beat.label, 0.75),
      });
    } else if (beat.role === 'closer') {
      cues.push({
        kind: 'settle',
        t: beat.start,
        duration: 2,
        intensity: 0.5,
        label: 'closing',
      });
    }
  }
  return cues;
}

export function planMotion(
  emotionEvents: EmotionEvent[],
  retentionBeats: RetentionBeat[],
  media: MediaInfo,
  duration: number
): MotionPlan {
  const emotionCues = deriveCuesFromEmotion(emotionEvents, media, duration);
  const retentionCues = deriveCuesFromRetention(retentionBeats, media, duration);

  const allCues = [...emotionCues, ...retentionCues];
  allCues.sort((a, b) => a.t - b.t);

  const deduped: MotionCue[] = [];
  const sameTypeWindow = 1.5;
  for (const cue of allCues) {
    const recent = deduped.filter((d) => d.kind === cue.kind);
    if (recent.length && cue.t - recent[recent.length - 1].t < sameTypeWindow) continue;
    deduped.push({ ...cue });
  }

  const counts: Record<string, number> = {};
  for (const c of deduped) {
    counts[c.kind] = (counts[c.kind] || 0) + 1;
  }

  const summary = `${deduped.length} cues planned | ${Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(', ')}`;

  return { cues: deduped, summary };
}
