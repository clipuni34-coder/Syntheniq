// Syntheniq — pipeline orchestrator: analysis + export.
//
// Runs inside a worker (embedded or standalone). Every artifact it writes is
// mirrored to R2 in production so any worker/API replica can serve it.
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../lib/db.js';
import * as jobs from '../lib/jobs.js';
import * as p from '../lib/paths.js';
import { CLIPS_DEFAULT, CLIPS_MAX, LLM_TOP_K } from '../config.js';
import { getStorage, isR2, keys } from '../storage/index.js';
import { probeMedia } from './probe.js';
import { ensureWav } from './transcribe/audio.js';
import { transcribeWav, transcribeLong, transcribeRange } from './transcribe/index.js';
import { analyzeCoverage, mergeSegments } from './transcribe/coverage.js';
import { analyzeStructure, detectSceneCuts } from './structure.js';
import { rankClips } from './editorial/index.js';
import {
  applyLlmEvaluations,
  buildTranscriptContext,
  selectLlmProvider,
  type LlmCandidateSignals,
  type LlmProvider,
} from './editorial/llm.js';
import { buildCaptionEvents, writeASS } from './render/captions.js';
import { extractPoster } from './render/index.js';
import { renderWithTreatment, type BuildTreatmentInput } from './render/render.js';
import { verifyExport } from './editorial/qc.js';
import type {
  AnalysisData,
  JobPublic,
  Project,
  Segment,
  StructureData,
  TranscriptResult,
} from '../types.js';

export const MSG = {
  UNDERSTAND: 'Understanding your video',
  LISTEN: 'Listening for the strongest moments',
  RECOVER: 'Finding the missing moments',
  STORY: 'Finding the story',
  BUILD: 'Building your clips',
  FINISH: 'Finishing your edits',
};

// Local working copy first; in R2 mode restore from durable storage when the
// local file is gone (another worker, fresh deploy, restarted disk).
async function ensureSource(project: Project): Promise<string> {
  if (!project.media || !project.media.filename) {
    throw new Error('This project has no uploaded video yet');
  }
  const full = p.sourceFile(project.id, project.media.filename);
  if (fs.existsSync(full)) return full;
  const key = project.media.r2Key;
  if (key && isR2()) {
    await getStorage().fetch(key, full);
    return full;
  }
  throw new Error('Source video file is missing from storage');
}

export async function readAnalysis(projectId: string): Promise<AnalysisData> {
  const file = p.analysisPath(projectId);
  if (!fs.existsSync(file) && isR2()) {
    try {
      await getStorage().fetch(keys.analysis(projectId), file);
    } catch {
      // fall through to the 409 below
    }
  }
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error('No analysis found — run analysis first'), { statusCode: 409 });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface RecoverGapsInput {
  input: string;
  projectId: string;
  duration: number;
  segments: Segment[];
  coverage: ReturnType<typeof analyzeCoverage>;
  language: string | null;
  notes: string[];
  transcribeRangeFn?: typeof transcribeRange;
  onProgress?: (fraction: number) => void;
}

// Coverage repair: re-transcribe the largest gaps with the language pinned.
// Extracted (and injectable) so the recovery policy is unit-testable.
export async function recoverGaps(input: RecoverGapsInput): Promise<{
  segments: Segment[];
  coverage: ReturnType<typeof analyzeCoverage>;
}> {
  const gaps = [...input.coverage.gaps]
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, 3);
  const transcribeFn = input.transcribeRangeFn || transcribeRange;
  let segments = input.segments;
  for (let i = 0; i < gaps.length; i++) {
    const gap = gaps[i];
    const sliceWav = p.audioPath(input.projectId, `gap${i}`);
    try {
      const extra = await transcribeFn(input.input, gap.start, gap.end, sliceWav, {
        language: input.language || undefined,
      });
      segments = mergeSegments(segments, extra.segments);
    } catch (err) {
      input.notes.push(
        `Could not recover ${formatClock(gap.start)}–${formatClock(gap.end)}: ${(err as Error).message}`
      );
    } finally {
      try {
        fs.unlinkSync(sliceWav);
      } catch {
        // ignore
      }
    }
    if (input.onProgress) {
      try {
        input.onProgress((i + 1) / gaps.length);
      } catch {
        // ignore progress listener errors
      }
    }
  }
  return { segments, coverage: analyzeCoverage(segments, input.duration) };
}

function windowSignals(structure: StructureData, start: number, end: number): LlmCandidateSignals {
  const sceneCuts = (structure.sceneCuts || []).filter((t) => t >= start && t <= end).length;
  let speech = 0;
  for (const s of structure.speechActive || []) {
    const lo = Math.max(s.start, start);
    const hi = Math.min(Number.isFinite(s.end) ? s.end : end, end);
    if (hi > lo) speech += hi - lo;
  }
  const dur = Math.max(0.001, end - start);
  const curve = (structure.energyCurve || []).filter((pt) => pt.t >= start && pt.t <= end).map((pt) => pt.rms);
  let energyVariance = 0;
  if (curve.length > 1) {
    const mean = curve.reduce((a, v) => a + v, 0) / curve.length;
    energyVariance = curve.reduce((a, v) => a + (v - mean) * (v - mean), 0) / curve.length;
  }
  return { sceneCuts, speechRatio: Math.min(1, speech / dur), energyVariance };
}

function clipWindowText(segments: Segment[] | undefined, start: number, end: number, fallback: string): string {
  const text = (segments || [])
    .filter((s) => s.end > start && s.start < end && s.text && s.text.trim())
    .map((s) => s.text.trim())
    .join(' ');
  return text || fallback;
}

export interface AnalysisOptions {
  maxClips?: number;
  /**
   * Editorial provider override. `undefined` (default) auto-selects from the
   * environment; pass `null` to force heuristic-only; pass a provider to
   * inject a fake in tests.
   */
  llm?: LlmProvider | null;
}

export async function runAnalysis(
  projectId: string,
  jobId: string,
  { maxClips = CLIPS_DEFAULT, llm }: AnalysisOptions = {}
): Promise<unknown> {
  const notes: string[] = [];
  try {
    const project = await db.getProject(projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const input = await ensureSource(project);

    await jobs.updateJob(jobId, { progress: 4, message: MSG.UNDERSTAND });
    await db.updateProject(projectId, { status: 'analyzing', notes: [] });

    const probe = await probeMedia(input);
    if (!probe.hasVideo) throw new Error('The uploaded file has no video stream');
    if (!(probe.duration > 0)) throw new Error('Could not determine the video duration');
    await db.updateProject(projectId, { media: { ...project.media, filename: project.media!.filename, probe } });

    p.ensureDir(p.workDir(projectId));
    const wavFull = p.audioPath(projectId, 'full');

    let structure: StructureData = { sceneCuts: [], speechActive: [], energyCurve: [], stats: {} };
    if (probe.hasAudio) {
      await jobs.updateJob(jobId, { progress: 10, message: MSG.UNDERSTAND });
      await ensureWav(input, wavFull);
      structure = await analyzeStructure(input, wavFull, probe.duration);
    } else {
      notes.push('The video has no audio track — analysis ran on visuals only.');
      structure.sceneCuts = await detectSceneCuts(input).catch(() => []);
    }
    fs.writeFileSync(p.structurePath(projectId), JSON.stringify(structure));
    await jobs.updateJob(jobId, { progress: 32, message: MSG.LISTEN });

    let transcript: TranscriptResult = { segments: [], language: null, provider: 'none', hasText: false };
    let coverage: ReturnType<typeof analyzeCoverage> | null = null;
    if (probe.hasAudio) {
      // Long videos transcribe in overlapping chunks (bounded memory, steady progress).
      transcript = await transcribeLong(input, wavFull, probe.duration, {
        onProgress: (fraction: number) => {
          jobs
            .updateJob(jobId, { progress: 32 + Math.round(fraction * 14), message: MSG.LISTEN })
            .catch(() => undefined);
        },
      });
      await jobs.updateJob(jobId, { progress: 48, message: MSG.LISTEN });

      // EDITORIAL RULE: measure the transcript against the video itself.
      coverage = analyzeCoverage(transcript.segments, probe.duration);
      if (transcript.hasText && coverage.needsWork) {
        for (const reason of coverage.reasons) notes.push(reason);
        await jobs.updateJob(jobId, {
          progress: 52,
          message: MSG.RECOVER,
          meta: { coverage: round3(coverage.coverage) },
        });
        const recovered = await recoverGaps({
          input,
          projectId,
          duration: probe.duration,
          segments: transcript.segments,
          coverage,
          language: transcript.language,
          notes,
          onProgress: (fraction: number) => {
            jobs
              .updateJob(jobId, { progress: 52 + Math.round(fraction * 10) })
              .catch(() => undefined);
          },
        });
        transcript.segments = recovered.segments;
        coverage = recovered.coverage;
        notes.push(
          `After recovery the transcript covers ${Math.round(coverage.coveredSeconds)}s of ` +
            `${Math.round(probe.duration)}s (${Math.round(coverage.coverage * 100)}%).`
        );
      } else if (!transcript.hasText) {
        notes.push(
          'No speech-to-text engine transcribes words in this environment — ' +
            'clips were found from the measured audio and visual structure instead.'
        );
      }
      fs.writeFileSync(p.transcriptPath(projectId), JSON.stringify(transcript));
      if (isR2()) {
        await getStorage().mirror(p.transcriptPath(projectId), keys.transcript(projectId));
      }
    }
    await jobs.updateJob(jobId, { progress: 64, message: MSG.STORY });

    const { clips, stats } = rankClips({
      segments: transcript.segments,
      structure,
      duration: probe.duration,
      hasText: transcript.hasText,
      maxClips: Math.max(1, Math.min(CLIPS_MAX, maxClips)),
    });
    if (!clips.length) throw new Error('No clip-worthy moments found in this video');

    // LLM editorial pass: re-score the top candidates with full context.
    // Any failure (or no API key) keeps the deterministic heuristic ranking.
    const provider: LlmProvider | null = llm === undefined ? selectLlmProvider() : llm;
    if (provider && clips.length > 0) {
      await jobs.updateJob(jobId, { progress: 70, message: MSG.STORY });
      try {
        const top = [...clips].sort((a, b) => b.total - a.total).slice(0, Math.max(1, LLM_TOP_K));
        const evals = await provider.evaluate({
          transcriptContext: buildTranscriptContext(transcript.segments),
          candidates: top.map((c) => ({
            id: c.id,
            start: c.start,
            end: c.end,
            text: clipWindowText(transcript.segments, c.start, c.end, c.excerpt),
            signals: windowSignals(structure, c.start, c.end),
          })),
        });
        const { applied, skipped } = applyLlmEvaluations(clips, evals);
        clips.sort((a, b) => b.total - a.total);
        clips.forEach((c, i) => {
          c.id = `clip-${i + 1}`;
          c.rank = i + 1;
        });
        notes.push(
          `Editorial pass (${provider.name}): ${applied} clip${applied === 1 ? '' : 's'} scored by the ` +
            `LLM editor${skipped ? `, ${skipped} kept deterministic scores` : ''}.`
        );
      } catch (err) {
        notes.push(`Editorial pass unavailable (${(err as Error).message}) — kept deterministic scores.`);
      }
    }

    await jobs.updateJob(jobId, { progress: 82, message: MSG.BUILD });
    const allWords = (transcript.segments || []).flatMap((s: Segment) => s.words || []);
    for (const clip of clips) {
      const dir = p.ensureDir(p.clipDir(projectId, clip.id));
      const events = transcript.hasText ? buildCaptionEvents(allWords, clip.start, clip.end) : [];
      if (events.length > 0) {
        const assFile = path.join(dir, 'captions.ass');
        writeASS(assFile, events, { title: `Syntheniq — ${clip.title}` });
        clip.captions = { file: 'captions.ass', events: events.length };
        await mirrorBestEffort(assFile, keys.captions(projectId, clip.id), notes);
      } else {
        clip.captions = { file: null, events: 0 };
      }
      try {
        const posterFile = p.posterPath(projectId, clip.id);
        await extractPoster(input, (clip.start + clip.end) / 2, posterFile);
        clip.poster = true;
        await mirrorBestEffort(posterFile, keys.poster(projectId, clip.id), notes);
      } catch (err) {
        clip.poster = false;
        notes.push(`Poster for ${clip.id} could not be rendered: ${(err as Error).message}`);
      }
    }

    const analysis: AnalysisData = {
      version: 1,
      projectId,
      createdAt: new Date().toISOString(),
      provider: transcript.provider,
      language: transcript.language,
      coverage: coverage
        ? {
            ratio: round3(coverage.coverage),
            coveredSeconds: Math.round(coverage.coveredSeconds),
            durationSeconds: Math.round(probe.duration),
          }
        : null,
      structure: {
        sceneCuts: structure.sceneCuts,
        speechActive: structure.speechActive,
        energyCurve: structure.energyCurve,
        stats: structure.stats,
      },
      transcript: transcript.segments,
      clips,
      stats,
      notes,
    };
    fs.writeFileSync(p.analysisPath(projectId), JSON.stringify(analysis));
    if (isR2()) {
      // Durability is load-bearing in production (any replica must read it).
      await getStorage().mirror(p.analysisPath(projectId), keys.analysis(projectId));
    }

    await db.updateProject(projectId, {
      status: 'clips-ready',
      activeJob: null,
      notes,
      analysis: {
        clipCount: clips.length,
        provider: transcript.provider,
        language: transcript.language,
        coverage: analysis.coverage,
        topScore: stats.topScore,
        analyzedAt: analysis.createdAt,
      },
    });

    await jobs.updateJob(jobId, { progress: 96, message: MSG.FINISH });
    return jobs.finishJob(jobId, {
      projectId,
      clipCount: clips.length,
      clips: clips.map((c) => c.id),
    });
  } catch (err) {
    try {
      await db.updateProject(projectId, { status: 'error', activeJob: null, notes: [...notes, (err as Error).message] });
    } catch {
      // ignore
    }
    return jobs.failJob(jobId, err);
  }
}

async function mirrorBestEffort(localPath: string, key: string, notes: string[]): Promise<void> {
  if (!isR2()) return;
  try {
    await getStorage().mirror(localPath, key);
  } catch (err) {
    notes.push(`Durable backup of ${key} failed (local copy kept): ${(err as Error).message}`);
  }
}

export async function runExport(projectId: string, clipId: string, jobId: string): Promise<unknown> {
  try {
    const project = await db.getProject(projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const input = await ensureSource(project);
    const analysis = await readAnalysis(projectId);
    const clip = analysis.clips.find((c) => c.id === clipId);
    if (!clip) throw Object.assign(new Error('Clip not found'), { statusCode: 404 });

    await jobs.updateJob(jobId, { progress: 6, message: MSG.BUILD });
    const dir = p.ensureDir(p.clipDir(projectId, clipId));
    const assFile = clip.captions && clip.captions.file ? path.join(dir, clip.captions.file) : null;
    const outFile = p.exportPath(projectId, clipId);

    const treatmentInput: BuildTreatmentInput = {
      input,
      clip: {
        start: clip.start,
        end: clip.end,
        id: clip.id,
        title: clip.title,
        scores: { emotion: clip.scores.emotion },
      },
      analysis,
      outDir: dir,
    };

    const treatmentResult = await renderWithTreatment(treatmentInput, { assFile }, (frac: number) => {
      jobs.updateJob(jobId, { progress: 6 + Math.round(frac * 82), message: MSG.BUILD }).catch(() => undefined);
    });

    if (!treatmentResult.verified) {
      jobs.updateJob(jobId, { progress: 90, message: 'Retrying render with repair mode' }).catch(() => undefined);
      const { repairExport } = await import('./editorial/qc.js');
      const repair = await repairExport(outFile, input, clip.start, clip.end - clip.start, outFile, assFile);
      if (!repair.success) {
        throw new Error(`Export repair failed: ${repair.issues.join(', ')}`);
      }
    }

    await jobs.updateJob(jobId, { progress: 92, message: MSG.FINISH });
    const verification = await verifyExport(outFile, { requireAudio: false });
    if (!verification.ok) {
      throw new Error(`Export failed verification: ${JSON.stringify(verification.checks)}`);
    }

    if (isR2()) {
      // Downloads are presigned R2 URLs — the object must exist.
      await getStorage().mirror(outFile, keys.exportFile(projectId, clipId));
    }

    const stat = fs.statSync(outFile);
    clip.exported = {
      file: 'export.mp4',
      bytes: stat.size,
      verified: verification.details,
      exportedAt: new Date().toISOString(),
    };
    fs.writeFileSync(p.analysisPath(projectId), JSON.stringify(analysis));
    if (isR2()) {
      await getStorage().mirror(p.analysisPath(projectId), keys.analysis(projectId));
    }
    await db.updateProject(projectId, { status: 'clips-ready', activeJob: null });

    return jobs.finishJob(jobId, {
      projectId,
      clipId,
      downloadUrl: `/v1/projects/${projectId}/clips/${clipId}/file?download=1`,
      bytes: stat.size,
      verification: verification.details,
    });
  } catch (err) {
    try {
      await db.updateProject(projectId, { activeJob: null });
    } catch {
      // ignore
    }
    return jobs.failJob(jobId, err);
  }
}

// Handlers shared by the embedded worker (dev/single-node) and the
// standalone worker processes (production scale-out).
export function jobHandlers(): Record<string, (job: JobPublic) => Promise<unknown>> {
  return {
    analyze: async (job: JobPublic) => {
      const meta = (job.meta || {}) as { projectId?: unknown; maxClips?: unknown };
      if (typeof meta.projectId !== 'string' || !meta.projectId) {
        throw new Error('analyze job is missing meta.projectId');
      }
      const maxClips = typeof meta.maxClips === 'number' ? meta.maxClips : CLIPS_DEFAULT;
      await runAnalysis(meta.projectId, job.id, { maxClips });
    },
    export: async (job: JobPublic) => {
      const meta = (job.meta || {}) as { projectId?: unknown; clipId?: unknown };
      if (typeof meta.projectId !== 'string' || !meta.projectId) {
        throw new Error('export job is missing meta.projectId');
      }
      if (typeof meta.clipId !== 'string' || !meta.clipId) {
        throw new Error('export job is missing meta.clipId');
      }
      await runExport(meta.projectId, meta.clipId, job.id);
    },
  };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
