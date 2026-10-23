// Syntheniq — shared engine types.

export interface Word {
  start: number;
  end: number;
  word: string;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface TranscriptResult {
  segments: Segment[];
  language: string | null;
  provider: string;
  hasText: boolean;
  attempts?: string[];
}

export interface ProbeResult {
  duration: number;
  sizeBytes: number;
  bitrate: number;
  formatName: string;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  audioCodec: string;
  pixFmt: string;
}

export interface Span {
  start: number;
  end: number;
}

export interface EnergyPoint {
  t: number;
  rms: number;
}

export interface FaceTrack {
  start: number;
  end: number;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

/**
 * A B-roll (cutaway) overlay cue. Describes a supplementary clip composited on
 * top of the main video for a time window, with optional Ken Burns zoom/pan,
 * fade transitions, opacity, and z-order layering. Drives the `?broll=true`
 * compositing toggle on the export endpoint.
 */
export interface BRollCue {
  /** Stable cue id. */
  id: string;
  /** B-roll source filename, resolved relative to the b-roll asset directory. */
  source: string;
  /** In/out points (seconds) on the source b-roll clip. */
  clipStart: number;
  clipEnd: number;
  /** Placement on the main timeline — when the overlay is visible. */
  outStart: number;
  outDuration: number;
  /**
   * Overlay geometry as a fraction of the export frame (0..1). Omitted =
   * full-frame cutaway (fills the 9:16 frame).
   */
  size?: { width: number; height: number };
  /** Top-left corner as a fraction of the available placement area (0..1). Omitted = centered. */
  position?: { x: number; y: number };
  /** Ken Burns: zoom (scale) range applied to the source. Defaults 1.15 -> 1.4. */
  kenBurns?: { zoomStart?: number; zoomEnd?: number };
  /** Ken Burns: normalized pan start/end (0..1) within the source frame. */
  panStart?: { x: number; y: number };
  panEnd?: { x: number; y: number };
  /** Fade in/out durations (seconds) on the overlay alpha. */
  fade?: { in: number; out: number };
  /** Opacity 0..1 (1 = fully opaque). Default 1. */
  opacity?: number;
  /** Z-order layer; higher renders on top. Default 0. */
  layer?: number;
}

export interface StructureData {
  sceneCuts: number[];
  speechActive: Span[];
  energyCurve: EnergyPoint[];
  faceTrack?: FaceTrack[];
  stats: {
    cutCount?: number;
    speechRatio?: number;
    meanEnergy?: number;
    faceCount?: number;
    hasFace?: boolean;
    [k: string]: unknown;
  };
}

export interface Scores {
  hook: number;
  curiosity: number;
  payoff: number;
  standalone: number;
  emotion: number;
  visual: number;
}

export interface ClipExport {
  file: string;
  bytes: number;
  verified: Record<string, unknown>;
  exportedAt: string;
}

export interface Clip {
  id: string;
  rank: number;
  start: number;
  end: number;
  duration: number;
  title: string;
  excerpt: string;
  scores: Scores;
  /** Deterministic heuristic scores — always present as the safety layer. */
  heuristicScores: Scores;
  /** Which layer produced `scores`: the LLM editorial pass or the heuristic. */
  decidedBy: 'heuristic' | 'llm';
  total: number;
  reasons: string[];
  captions?: { file: string | null; events: number };
  poster?: boolean;
  exported: ClipExport | null;
}

export interface AnalysisData {
  version: number;
  projectId: string;
  createdAt: string;
  provider: string;
  language: string | null;
  coverage: { ratio: number; coveredSeconds: number; durationSeconds: number } | null;
  structure: StructureData;
  transcript: Segment[];
  clips: Clip[];
  stats: Record<string, unknown>;
  notes: string[];
}

export interface ProjectMedia {
  filename: string;
  /** Durable object key when STORAGE_DRIVER=r2. */
  r2Key?: string;
  originalName?: string;
  bytes?: number;
  mime?: string;
  probe?: ProbeResult;
  uploadedAt?: string;
}

export interface ActiveJob {
  id: string;
  type: string;
  clipId?: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  media: ProjectMedia | null;
  analysis: Record<string, unknown> | null;
  activeJob?: ActiveJob | null;
  notes: string[];
}

export type JobStatus = 'queued' | 'running' | 'done' | 'error';

export interface JobPublic {
  id: string;
  type: string;
  label: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
  meta: Record<string, unknown>;
}
