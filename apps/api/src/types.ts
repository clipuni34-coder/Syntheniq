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

export interface StructureData {
  sceneCuts: number[];
  speechActive: Span[];
  energyCurve: EnergyPoint[];
  stats: {
    cutCount?: number;
    speechRatio?: number;
    meanEnergy?: number;
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

export type JobStatus = 'running' | 'done' | 'error';

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
