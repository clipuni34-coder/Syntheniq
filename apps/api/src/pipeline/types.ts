// Shared pipeline data structures (persisted as JSON under the project dir).
import type { Graphic } from './graphics.js';

export interface MediaInfo {
  path: string;
  duration: number; // seconds
  fps: number; // 30 or 60 (rounded source rate)
  width: number;
  height: number;
  hasAudio: boolean;
  codec: string;
}

export interface Word {
  start: number;
  end: number;
  word: string;
  isFiller: boolean;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface Transcript {
  duration: number;
  language: string;
  segments: Segment[];
}

export interface Silence {
  start: number;
  end: number;
}

export interface EnergyBucket {
  t: number;
  rms: number; // 0..1 normalized
}

export interface MediaSignals {
  silences: Silence[];
  energy: EnergyBucket[];
}

export interface Topic {
  start: number;
  end: number;
  title: string;
  summary: string;
  energy: number;
  emotion: string;
  importance: number;
}

export interface Analysis {
  language: string;
  tone: string;
  topics: Topic[];
  keyphrases: { text: string; times: number[] }[];
  deadAir: { start: number; end: number; reason: string }[];
  fillerNotes: string;
  moments: {
    start: number;
    end: number;
    hook: number;
    curiosity: number;
    payoff: number;
    standalone: number;
    emotion: number;
    visual: number;
    reason: string;
  }[];
  visualNotes?: string;
}

export interface PunchIn {
  time: number; // source timeline seconds
  zoom: number; // 1.05 .. 1.4
  reason: string;
}

// ── motion-graphics engine ────────────────────────────────────────────────
// Cues are source-timeline (inside ClipPlan) and are mapped to composition
// time when the spec is built (inside CompSpec.motion).

export type MotionKind =
  | 'emphasis'   // keyphrase treatment on the caption word: underline | box | circle | arrow
  | 'impact'     // flash + camera shake + shape accent at an emotional peak
  | 'lowerThird' // animated topic bar (text required)
  | 'pulse'      // audio-reactive accent pulse (beat grid / energy onsets)
  | 'transition' // segment-boundary treatment: flash | wipe | pulse (structural)
  | 'drift'      // slow camera push per segment (structural)
  | 'settle';    // end-of-clip gentle zoom (structural)

export interface MotionCue {
  kind: MotionKind;
  t: number; // seconds (source timeline in ClipPlan, comp time in CompSpec)
  variant?: string;
  text?: string;
  dur?: number;
  intensity?: number; // 0..1
  reason?: string;
}

export interface MotionStyle {
  tempo: 'calm' | 'steady' | 'energetic';
  emotion?: string; // dominant emotion tag driving entrance variants
}

export interface MotionPlan {
  cues: MotionCue[];
  style: MotionStyle;
}

export interface Cutaway {
  sourceTime: number;
  duration: number;
  reason: string;
}

// ── retention architecture ────────────────────────────────────────────────
// The retention principle: optimize for CONTINUOUS reasons to keep watching,
// not just an impressive opening or a delayed payoff. The AI analyzes the
// sequence of information / emotion / curiosity / payoff and picks a structure
// per clip. The only element that may break strict chronology is a short
// cold-open teaser from later footage; the main narrative stays chronological.

export const RETENTION_ARCHITECTURES = [
  'payoff-teaser-story-payoff',
  'open-loop-progressive-reveal-resolution',
  'escalating-revelations',
  'consequence-first-explanation',
  'question-investigation-answer',
  'emotional-context-emotional-payoff',
  'transformation',
  'pattern-break-explanation',
  'chronological-hook-escalation-final-revelation',
] as const;
export type RetentionArchitecture = (typeof RETENTION_ARCHITECTURES)[number] | (string & {});

export type RetentionBeatRole =
  | 'hook'
  | 'curiosity'
  | 'micro-payoff'
  | 'escalation'
  | 'major-payoff'
  | 'satisfaction';

export interface RetentionBeat {
  t: number; // source-timeline seconds
  role: RetentionBeatRole;
  note: string; // what the viewer knows / still wants to know here
}

export interface RetentionTeaser {
  sourceStart: number; // later moment, cold-opened at the top
  sourceEnd: number;
  reason: string; // why it creates curiosity without spoiling the payoff
}

export interface Retention {
  architecture: RetentionArchitecture;
  rationale: string; // why this structure fits this specific material
  beats: RetentionBeat[];
  teaser?: RetentionTeaser;
}

export interface Callout {
  time: number;
  text: string;
  style: 'label' | 'stat' | 'quote';
}

export interface ClipVariant {
  hookText?: string;
  title?: string;
  note?: string;
}

export interface ClipPlan {
  id: string;
  sourceStart: number;
  sourceEnd: number;
  hookText: string;
  segments: { start: number; end: number }[]; // kept ranges (source timeline)
  punchIns: PunchIn[];
  cutaways: Cutaway[];
  callouts: Callout[];
  cta: { text: string; style: string };
  music: 'chill' | 'drive' | 'none';
  energy: number;
  thumbnail: { sourceTime: number; text: string };
  title: string;
  variants: ClipVariant[];
  motion?: MotionPlan; // motion-graphics cues (source timeline)
  retention?: Retention; // retention architecture (beats + optional cold-open teaser)
  graphics?: Graphic[]; // editorial visual-storytelling graphics (source timeline)
}

export interface Plan {
  clipCount: number;
  clips: ClipPlan[];
  notes?: string;
}

export interface ClipMeta {
  title: string;
  /** The narrative angle: 'Mistake → Fix', 'List / how-to', 'Progression', 'Personal story', … */
  angle: string;
  caption: string; // generic
  tiktokCaption: string;
  instagramCaption: string;
  youtubeDescription: string;
  description: string;
  hashtags: string[];
  cta: string;
  variants: ClipVariant[];
}

/** Full publish package written per clip (spec §13). */
export interface ClipPackage {
  title: string;
  angle: string;
  captions: { tiktok: string; instagram: string; youtube: string };
  description: string;
  hashtags: string[];
  cta: string;
  source: { start: number; end: number };
  rationale: string;
  variants: ClipVariant[];
  generatedBy: string;
}

export type StageName =
  | 'media-check'
  | 'audio'
  | 'transcribe'
  | 'analyze'
  | 'plan'
  | 'prep-media'
  | 'render'
  | 'package'
  | 'qc'
  | 'complete';

export const STAGES: StageName[] = [
  'media-check',
  'audio',
  'transcribe',
  'analyze',
  'plan',
  'prep-media',
  'render',
  'package',
  'qc',
  'complete',
];

export interface ClipState {
  id: string;
  title: string;
  status: 'pending' | 'rendering' | 'done' | 'error';
  files: {
    mp4?: string; // filename in project files dir
    thumb?: string;
    meta?: string;
  };
  error?: string;
  duration?: number;
  fps?: number;
  variant?: {
    hookText: string;
    title: string;
    status: 'rendering' | 'done' | 'error';
    mp4?: string;
    thumb?: string;
  };
}

export interface JobState {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelling' | 'cancelled' | 'interrupted';
  stage: StageName | null;
  progress: number; // 0..1 overall
  stages: Partial<Record<StageName, { status: 'pending' | 'running' | 'done' | 'error' | 'skipped'; progress: number; detail?: string }>>;
  media?: MediaInfo;
  transcript?: { words: number; segments: number; coverage: number; model: string };
  analysis?: Analysis;
  plan?: Plan;
  clips: ClipState[];
  providers: {
    transcribe: string;
    analyze: string;
    plan: string;
    package: string;
    video?: string;
    review?: string;
  };
  logs: { t: string; level: 'info' | 'warn' | 'error'; msg: string }[];
  error?: string;
  cancelRequested?: boolean;
}
