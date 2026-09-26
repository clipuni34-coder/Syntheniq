// Syntheniq — visual treatment rendering engine.
// Integrates emotion → retention → motion → edit-decision → FFmpeg filters.
import fs from 'node:fs';
import path from 'node:path';
import type { Segment, Word, EnergyPoint, Span } from '../../types.js';
import type { AnalysisData } from '../../types.js';
import { analyzeEmotion } from '../editorial/emotion.js';
import { scoreRetentionArchitecture, type RetentionBeat } from '../editorial/retention.js';
import { planMotion } from '../editorial/motion.js';
import { buildEditDecision, type EditDecision } from '../editorial/plan.js';
import { buildCaptionEvents, buildKineticCaptions, writeASS, type KineticCaptionEvent } from './captions.js';
import { validateCaptions, repairCaptions, checkCaptionReadability, type CaptionQCResult } from './caption-qc.js';
import { buildTreatment, buildRenderCommand, type TreatmentOptions, type TreatmentResult } from './treatments.js';
import { EXPORT_SPEC, escapeFilterPath } from './index.js';
import { run, ffprobe } from '../../lib/ffmpeg.js';
import type { MediaInfo } from '../editorial/motion.js';

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

export interface VisualTreatmentResult {
  decision: EditDecision;
  treatment: TreatmentResult;
  captionQC: CaptionQCResult;
  renderArgs: string[];
  outFile: string;
  assFile: string | null;
  kineticAssFile: string | null;
  bytes: number;
  verified: boolean;
  warnings: string[];
}

export interface BuildTreatmentInput {
  input: string;
  clip: {
    start: number;
    end: number;
    id: string;
    title: string;
    scores: { emotion: number };
  };
  analysis: AnalysisData;
  outDir: string;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

function deriveMediaInfo(probe: { width: number; height: number; fps: number }): MediaInfo {
  return {
    width: probe.width,
    height: probe.height,
    fps: probe.fps,
  };
}

function mergeSilences(silences: Span[]): Span[] {
  if (!silences.length) return [];
  const sorted = [...silences].sort((a, b) => a.start - b.start);
  const merged: Span[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.5) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push(sorted[i]);
    }
  }
  return merged;
}

export async function buildVisualTreatment(
  input: BuildTreatmentInput,
  options: TreatmentOptions = {}
): Promise<VisualTreatmentResult> {
  const { input: videoPath, clip, analysis, outDir } = input;
  const { start: clipStart, end: clipEnd, id: clipId, title: clipTitle } = clip;
  const clipDuration = clipEnd - clipStart;
  const warnings: string[] = [];

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Source video not found: ${videoPath}`);
  }

  const probe = await ffprobe(videoPath);
  const media = deriveMediaInfo({
    width: probe.width || 1080,
    height: probe.height || 1920,
    fps: probe.r_frame_rate ? evalFps(probe.r_frame_rate) : 30,
  });

  const structure = analysis.structure || {
    sceneCuts: [],
    speechActive: [],
    energyCurve: [],
    stats: {},
  };

  const segments = analysis.transcript || [];
  const words: Word[] = segments.flatMap((s) => s.words || []);
  const silences = mergeSilences(structure.speechActive ? [] : []);
  const allWords = words;

  const energyEvents = analysis.transcript
    ? segments.map((s) => ({ t: (s.start + s.end) / 2, type: 'revelation' as const, intensity: 0.5, label: s.text.slice(0, 20) }))
    : [];

  const emotion = analyzeEmotion(
    segments,
    allWords,
    silences,
    clipStart,
    clipEnd,
    segments
      .flatMap((s) => s.text.toLowerCase().split(/\W+/).filter(Boolean))
      .filter((w) => w.length > 3)
      .slice(0, 20)
  );

  const retentionBeats: RetentionBeat[] = [
    { role: 'teaser', start: clipStart, end: clipStart + 1, confidence: 0.7, label: 'opening', signals: [] },
    { role: 'narrative', start: clipStart + 1, end: clipEnd - 1, confidence: 0.5, label: 'body', signals: [] },
    { role: 'payoff', start: clipEnd - 1, end: clipEnd, confidence: 0.8, label: 'closing', signals: [] },
  ];

  const retention = scoreRetentionArchitecture(
    retentionBeats,
    emotion.trajectory,
    segments,
    allWords,
    structure.energyCurve || [],
    silences,
    clipDuration
  );

  const motion = planMotion(emotion.events, retention.beats, media, clipDuration);

  const decision = buildEditDecision(
    {
      startTime: clipStart,
      endTime: clipEnd,
      segments,
      words: allWords,
      energyCurve: structure.energyCurve || [],
      silences,
      media,
    },
    {
      emotion,
      retention,
      motion,
    }
  );

  if (decision.segments.length === 0) {
    decision.segments.push({
      id: 'seg-1',
      start: 0,
      end: round3(clipDuration),
      duration: round3(clipDuration),
      source: 'main',
      title: clipTitle,
      purpose: 'narrative',
      transitions: { in: null, out: null },
      cues: [],
      notes: ['Fallback single-segment edit'],
    });
  }

  fs.mkdirSync(outDir, { recursive: true });
  const assFile = path.join(outDir, 'captions.ass');
  const kineticAssFile = path.join(outDir, 'kinetic.ass');
  const outFile = path.join(outDir, 'export.mp4');

  const baseEvents = buildCaptionEvents(allWords, clipStart, clipEnd);
  writeASS(assFile, baseEvents, { title: clipTitle });

  const kineticEvents = buildKineticCaptions(
    allWords,
    clipStart,
    clipEnd,
    decision.motion.cues
  );

  const captionQC = validateCaptions(kineticEvents, decision.motion.cues);

  if (!captionQC.ok) {
    const repair = repairCaptions(kineticEvents, decision.motion.cues);
    if (repair.fixed) {
      warnings.push(`Caption QC repaired ${repair.changes.length} issue(s)`);
      for (const change of repair.changes) warnings.push(`  - ${change}`);
    }
  }

  const readability = checkCaptionReadability(kineticEvents);
  if (!readability.ok) {
    warnings.push(`Readability issues: ${readability.issues.length} word(s) read too fast`);
  }

  if (kineticEvents.length > 0) {
    const { buildKineticASS } = await import('./captions.js');
    const content = buildKineticASS(kineticEvents, { title: clipTitle });
    fs.writeFileSync(kineticAssFile, content, 'utf8');
  } else {
    fs.rmSync(kineticAssFile, { force: true });
  }

  const treatment = buildTreatment(decision, {
    ...options,
    assFile,
    kineticAssFile: fs.existsSync(kineticAssFile) ? kineticAssFile : null,
  });

  warnings.push(...treatment.warnings);
  warnings.push(`Treatment: ${treatment.videoFilters.length} video filters, ${treatment.motionCues.length} motion cues`);

  const renderArgs = buildRenderCommand(videoPath, outFile, treatment, {
    start: clipStart,
    duration: clipDuration,
  });

  const totalMotionDuration = treatment.motionCues.reduce((sum, c) => sum + c.duration, 0);
  if (totalMotionDuration > 30) {
    warnings.push(`High total motion duration (${totalMotionDuration.toFixed(1)}s) — render may take longer`);
  }

  return {
    decision,
    treatment,
    captionQC,
    renderArgs,
    outFile,
    assFile,
    kineticAssFile: fs.existsSync(kineticAssFile) ? kineticAssFile : null,
    bytes: 0,
    verified: false,
    warnings,
  };
}

export async function renderWithTreatment(
  input: BuildTreatmentInput,
  options: TreatmentOptions = {},
  onProgress?: (frac: number) => void
): Promise<VisualTreatmentResult> {
  const result = await buildVisualTreatment(input, options);

  const total = Math.max(0.1, result.decision.duration);
  await run('ffmpeg', result.renderArgs, {
    onStdoutLine: (line: string) => {
      if (!onProgress) return;
      let m = line.match(/^out_time_ms=(\d+)/);
      if (m) {
        onProgress(Math.max(0, Math.min(1, parseInt(m[1], 10) / 1e6 / total)));
        return;
      }
      m = line.match(/^out_time=(\d+):(\d+):([\d.]+)/) as RegExpMatchArray | null;
      if (m) {
        const t = parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]);
        onProgress(Math.max(0, Math.min(1, t / total)));
      }
    },
  });

  const stat = fs.statSync(result.outFile);
  if (!stat.size) {
    throw new Error('Render produced an empty output file');
  }

  result.bytes = stat.size;

  const { verifyExport } = await import('../editorial/qc.js');
  const verification = await verifyExport(result.outFile);
  result.verified = verification.ok;

  if (!verification.ok) {
    result.warnings.push(`Export verification failed: ${verification.issues.join(', ')}`);
  }

  return result;
}

function evalFps(value: string): number {
  const m = String(value).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return 0;
  const den = m[2] !== undefined ? parseFloat(m[2]) : 1;
  return den ? parseFloat(m[1]) / den : 0;
}
