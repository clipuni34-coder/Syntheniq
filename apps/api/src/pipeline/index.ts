// Syntheniq — pipeline orchestrator: analysis + export.
import fs from 'node:fs';
import path from 'node:path';
import * as db from '../lib/db.js';
import * as jobs from '../lib/jobs.js';
import * as p from '../lib/paths.js';
import { CLIPS_DEFAULT, CLIPS_MAX } from '../config.js';
import { probeMedia } from './probe.js';
import { ensureWav } from './transcribe/audio.js';
import { transcribeWav, transcribeRange } from './transcribe/index.js';
import { analyzeCoverage, mergeSegments } from './transcribe/coverage.js';
import { analyzeStructure, detectSceneCuts } from './structure.js';
import { rankClips } from './editorial/index.js';
import { buildCaptionEvents, writeASS } from './render/captions.js';
import { renderClip, verifyExport, extractPoster } from './render/index.js';
import type { AnalysisData, Project, Segment, StructureData, TranscriptResult } from '../types.js';

export const MSG = {
  UNDERSTAND: 'Understanding your video',
  LISTEN: 'Listening for the strongest moments',
  RECOVER: 'Finding the missing moments',
  STORY: 'Finding the story',
  BUILD: 'Building your clips',
  FINISH: 'Finishing your edits',
};

function sourcePathOf(project: Project): string {
  if (!project.media || !project.media.filename) {
    throw new Error('This project has no uploaded video yet');
  }
  const full = p.sourceFile(project.id, project.media.filename);
  if (!fs.existsSync(full)) throw new Error('Source video file is missing from storage');
  return full;
}

export function readAnalysis(projectId: string): AnalysisData {
  const file = p.analysisPath(projectId);
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error('No analysis found — run analysis first'), { statusCode: 409 });
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export async function runAnalysis(
  projectId: string,
  jobId: string,
  { maxClips = CLIPS_DEFAULT }: { maxClips?: number } = {}
): Promise<unknown> {
  const notes: string[] = [];
  try {
    const project = db.getProject(projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const input = sourcePathOf(project);

    jobs.updateJob(jobId, { progress: 4, message: MSG.UNDERSTAND });
    await db.updateProject(projectId, { status: 'analyzing', notes: [] });

    const probe = await probeMedia(input);
    if (!probe.hasVideo) throw new Error('The uploaded file has no video stream');
    if (!(probe.duration > 0)) throw new Error('Could not determine the video duration');
    await db.updateProject(projectId, { media: { ...project.media, filename: project.media!.filename, probe } });

    p.ensureDir(p.workDir(projectId));
    const wavFull = p.audioPath(projectId, 'full');

    let structure: StructureData = { sceneCuts: [], speechActive: [], energyCurve: [], stats: {} };
    if (probe.hasAudio) {
      jobs.updateJob(jobId, { progress: 10, message: MSG.UNDERSTAND });
      await ensureWav(input, wavFull);
      structure = await analyzeStructure(input, wavFull, probe.duration);
    } else {
      notes.push('The video has no audio track — analysis ran on visuals only.');
      structure.sceneCuts = await detectSceneCuts(input).catch(() => []);
    }
    fs.writeFileSync(p.structurePath(projectId), JSON.stringify(structure));
    jobs.updateJob(jobId, { progress: 32, message: MSG.LISTEN });

    let transcript: TranscriptResult = { segments: [], language: null, provider: 'none', hasText: false };
    let coverage: ReturnType<typeof analyzeCoverage> | null = null;
    if (probe.hasAudio) {
      transcript = await transcribeWav(wavFull);
      jobs.updateJob(jobId, { progress: 48, message: MSG.LISTEN });

      // EDITORIAL RULE: measure the transcript against the video itself.
      coverage = analyzeCoverage(transcript.segments, probe.duration);
      if (transcript.hasText && coverage.needsWork) {
        for (const reason of coverage.reasons) notes.push(reason);
        jobs.updateJob(jobId, { progress: 52, message: MSG.RECOVER, meta: { coverage: round3(coverage.coverage) } });
        const gaps = [...coverage.gaps]
          .sort((a, b) => b.end - b.start - (a.end - a.start))
          .slice(0, 3);
        for (let i = 0; i < gaps.length; i++) {
          const gap = gaps[i];
          const sliceWav = p.audioPath(projectId, `gap${i}`);
          try {
            const extra = await transcribeRange(input, gap.start, gap.end, sliceWav, {
              language: transcript.language || undefined,
            });
            transcript.segments = mergeSegments(transcript.segments, extra.segments);
          } catch (err) {
            notes.push(`Could not recover ${formatClock(gap.start)}–${formatClock(gap.end)}: ${(err as Error).message}`);
          } finally {
            try {
              fs.unlinkSync(sliceWav);
            } catch {
              // ignore
            }
          }
          jobs.updateJob(jobId, { progress: 52 + Math.round(((i + 1) / gaps.length) * 10) });
        }
        coverage = analyzeCoverage(transcript.segments, probe.duration);
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
    }
    jobs.updateJob(jobId, { progress: 64, message: MSG.STORY });

    const { clips, stats } = rankClips({
      segments: transcript.segments,
      structure,
      duration: probe.duration,
      hasText: transcript.hasText,
      maxClips: Math.max(1, Math.min(CLIPS_MAX, maxClips)),
    });
    if (!clips.length) throw new Error('No clip-worthy moments found in this video');

    jobs.updateJob(jobId, { progress: 82, message: MSG.BUILD });
    const allWords = (transcript.segments || []).flatMap((s: Segment) => s.words || []);
    for (const clip of clips) {
      const dir = p.ensureDir(p.clipDir(projectId, clip.id));
      const events = transcript.hasText ? buildCaptionEvents(allWords, clip.start, clip.end) : [];
      if (events.length > 0) {
        const assFile = path.join(dir, 'captions.ass');
        writeASS(assFile, events, { title: `Syntheniq — ${clip.title}` });
        clip.captions = { file: 'captions.ass', events: events.length };
      } else {
        clip.captions = { file: null, events: 0 };
      }
      try {
        await extractPoster(input, (clip.start + clip.end) / 2, p.posterPath(projectId, clip.id));
        clip.poster = true;
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

    jobs.updateJob(jobId, { progress: 96, message: MSG.FINISH });
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

export async function runExport(projectId: string, clipId: string, jobId: string): Promise<unknown> {
  try {
    const project = db.getProject(projectId);
    if (!project) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const input = sourcePathOf(project);
    const analysis = readAnalysis(projectId);
    const clip = analysis.clips.find((c) => c.id === clipId);
    if (!clip) throw Object.assign(new Error('Clip not found'), { statusCode: 404 });

    jobs.updateJob(jobId, { progress: 6, message: MSG.BUILD });
    const dir = p.ensureDir(p.clipDir(projectId, clipId));
    const assFile = clip.captions && clip.captions.file ? path.join(dir, clip.captions.file) : null;
    const outFile = p.exportPath(projectId, clipId);

    await renderClip({
      input,
      start: clip.start,
      duration: clip.end - clip.start,
      assFile: assFile && fs.existsSync(assFile) ? assFile : null,
      outFile,
      onProgress: (frac: number) => {
        jobs.updateJob(jobId, { progress: 6 + Math.round(frac * 82), message: MSG.BUILD });
      },
    });

    jobs.updateJob(jobId, { progress: 92, message: MSG.FINISH });
    const verification = await verifyExport(outFile);
    if (!verification.ok) {
      throw new Error(`Export failed verification: ${JSON.stringify(verification.checks)}`);
    }

    const stat = fs.statSync(outFile);
    clip.exported = {
      file: 'export.mp4',
      bytes: stat.size,
      verified: verification.details,
      exportedAt: new Date().toISOString(),
    };
    fs.writeFileSync(p.analysisPath(projectId), JSON.stringify(analysis));
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

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
