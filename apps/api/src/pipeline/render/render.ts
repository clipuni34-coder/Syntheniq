// Syntheniq — visual treatment rendering engine.
// Integrates emotion → retention → motion → edit-decision → FFmpeg filters.
import fs from 'node:fs';
import path from 'node:path';
import type { Segment, Word, EnergyPoint, Span } from '../../types.js';
import type { AnalysisData, BRollCue } from '../../types.js';
import { analyzeEmotion } from '../editorial/emotion.js';
import { scoreRetentionArchitecture, type RetentionBeat } from '../editorial/retention.js';
import { planMotion } from '../editorial/motion.js';
import { buildEditDecision, type EditDecision } from '../editorial/plan.js';
import { generateKeywordBRollCues, isSyntheticBroll } from './broll.js';
import { buildCaptionEvents, buildKineticCaptions, writeASS, type KineticCaptionEvent } from './captions.js';
import { validateCaptions, repairCaptions, checkCaptionReadability, type CaptionQCResult } from './caption-qc.js';
import { buildTreatment, buildRenderCommand, type TreatmentOptions, type TreatmentResult } from './treatments.js';
import { applySoundEffects, type SoundEffect, type SfxContext } from './sfx.js';
import { EXPORT_SPEC, escapeFilterPath } from './index.js';
import { run, ffprobe } from '../../lib/ffmpeg.js';
import type { MediaInfo } from '../editorial/motion.js';
import { verifyExport } from '../editorial/qc.js';
import { buildSafeRenderFilters } from '../editorial/qc.js';
import { ensureDir } from '../../lib/paths.js';
const BROLL_ASSETS_DIR = path.resolve(import.meta.dirname, '../../assets/broll');

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

async function normalizeInput(
  input: string,
  start: number,
  duration: number,
  outFile: string,
  hasAudio: boolean
): Promise<void> {
  const scaleFilter = `scale=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:force_original_aspect_ratio=decrease,pad=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:(ow-iw)/2:(oh-ih)/2,setsar=1`;
  const videoFilters = `fps=${EXPORT_SPEC.fps},${scaleFilter},format=${EXPORT_SPEC.pixFmt}`;
  const args = [
    '-hide_banner', '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', input,
    '-vf', videoFilters,
    '-c:v', 'libx264',
    '-preset', 'superfast',
    '-crf', '18',
  ];
  if (hasAudio) {
    args.push('-c:a', 'copy');
  } else {
    args.push('-an');
  }
  args.push(outFile);
  await run('ffmpeg', args);
}

export interface VisualTreatmentResult {
  decision: EditDecision;
  treatment: TreatmentResult;
  captionQC: CaptionQCResult;
  renderArgs: string[];
  outFile: string;
  assFile: string | null;
  kineticAssFile: string | null;
  soundEffects: SoundEffect[];
  sfxAudioFiles: string[];
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
  broll?: boolean;
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

function computeSilences(speechActive: Span[] | undefined, start: number, end: number): Span[] {
  const active = (speechActive || [])
    .filter((s) => s.end > start && s.start < end)
    .sort((a, b) => a.start - b.start);
  if (!active.length) return [];
  const silences: Span[] = [];
  if (active[0].start > start + 0.1) silences.push({ start, end: active[0].start });
  for (let i = 1; i < active.length; i++) {
    if (active[i].start - active[i - 1].end > 0.1) {
      silences.push({ start: active[i - 1].end, end: active[i].start });
    }
  }
  if (active[active.length - 1].end < end - 0.1) {
    silences.push({ start: active[active.length - 1].end, end });
  }
  return mergeSilences(silences);
}

/** Load committed B-roll cues from cues.json. */
function loadBRollCues(): BRollCue[] {
  try {
    const cuesPath = path.join(BROLL_ASSETS_DIR, 'cues.json');
    if (!fs.existsSync(cuesPath)) return [];
    const data = JSON.parse(fs.readFileSync(cuesPath, 'utf8'));
    return data.cues || [];
  } catch {
    return [];
  }
}

/** Result of resolving B-roll source URLs to local files. */
interface BRollResolveResult {
  cues: BRollCue[];
  notes: string[];
}

/** Resolve B-roll source URLs to local files (download if needed,
 * generate synthetic fallback for remote URLs, keep local as-is).
 */
async function resolveBRollSources(
  cues: BRollCue[],
  assetsDir: string,
  outDir: string
): Promise<BRollResolveResult> {
  const notes: string[] = [];
  const cacheDir = path.join(outDir, 'broll_cache');
  ensureDir(cacheDir);

  const resolved: BRollCue[] = [];
  for (const cue of cues) {
    const source = cue.source;
    if (isSyntheticBroll(source)) {
      resolved.push(cue);
      continue;
    }
    if (source.startsWith('http')) {
      // Remote URL — download or use a local static asset
      const ext = path.extname(source).split('?')[0] || '.mp4';
      const filename = `${cue.id}${ext}`;
      const localPath = path.join(cacheDir, filename);
      if (!fs.existsSync(localPath)) {
        try {
          const res = await fetch(source);
          if (res.ok) {
            const buffer = await res.arrayBuffer();
            fs.writeFileSync(localPath, Buffer.from(buffer));
            notes.push(`Downloaded B-roll: ${cue.id}`);
          } else {
            notes.push(`Failed to download B-roll: ${cue.id} (status ${res.status})`);
          }
        } catch (err) {
          notes.push(`Error downloading B-roll: ${cue.id} — using synthetic fallback`);
          resolved.push({ ...cue, source: `synthetic:broll:0x2196F3` });
          continue;
        }
      }
      resolved.push({ ...cue, source: localPath });
    } else if (fs.existsSync(source)) {
      resolved.push(cue);
    } else {
      const localPath = path.join(assetsDir, source);
      if (fs.existsSync(localPath)) {
        resolved.push({ ...cue, source: localPath });
      } else {
        notes.push(`Missing B-roll asset: ${source} — using synthetic fallback`);
        resolved.push({ ...cue, source: `synthetic:broll:0x2196F3` });
      }
    }
  }
  return { cues: resolved, notes };
}

/** Generate a synthetic B-roll clip using ffmpeg color source. */
async function generateSyntheticBRoll(
  cue: BRollCue,
  outDir: string,
  index: number
): Promise<string> {
  ensureDir(outDir);
  const outPath = path.join(outDir, `synth-broll-${index}.mp4`);

  // Parse color from synthetic source: "synthetic:broll:0x2196F3"
  const parts = cue.source.split(':');
  const colorCode = parts[parts.length - 1] || '0x2196F3';
  const color = colorCode.startsWith('0x') ? colorCode.replace('0x', '') : colorCode;

  const width = 720;
  const height = 1280;
  const duration = Math.max(1, cue.outDuration);

  // Generate a simple color-based synthetic B-roll with subtle zoom
  await run('ffmpeg', [
    '-f', 'lavfi', '-i', `color=c=${color}:s=${width}x${height}:d=${duration}`,
    '-vf', `scale=${width}:${height},zoompan=z='if(gte(zoom,1.2),1.2,zoom+0.002)':d=${width}/10:s=${width}x${height}`,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-t', String(duration),
    '-y',
    outPath,
  ]);

  return outPath;
}

/** Build B-roll cues based on the `broll` option and transcript keywords. */
async function getBRollCues(
  input: BuildTreatmentInput,
  allWords: Word[],
  clipStart: number,
  clipEnd: number,
  outDir: string,
  warnings: string[]
): Promise<BRollCue[]> {
  if (!input.broll) return [];

  // Generate content-aware B-roll cues based on transcript keywords
  const apiKey = process.env.PIXABAY_API_KEY || '';
  const keywordCues = await generateKeywordBRollCues(allWords, clipStart, clipEnd, apiKey);

  // Also load any committed cues from cues.json
  const committedCues = loadBRollCues();
  const clipDuration = clipEnd - clipStart;

  // Adjust committed cues to clip-relative timing
  const adjustedCommitted = committedCues
    .filter((cue) => cue.outStart < clipDuration || cue.outStart + cue.outDuration > 0)
    .map((cue): BRollCue => {
      const start = Math.max(0, Math.min(clipDuration, cue.outStart));
      const end = Math.min(clipDuration, start + cue.outDuration);
      const outDuration = Math.max(0.5, end - start);
      return { ...cue, outStart: start, outDuration };
    })
    .filter((cue) => cue.outDuration > 0.5);

  // Merge keyword-based cues with committed cues (keyword cues take priority)
  let brollCues: BRollCue[] = [...keywordCues, ...adjustedCommitted];
  warnings.push(`[broll] Content-aware: ${keywordCues.length} keyword cues, ${adjustedCommitted.length} committed cues`);

  // Resolve B-roll sources (download URLs or generate synthetic)
  const resolved = await resolveBRollSources(brollCues, BROLL_ASSETS_DIR, outDir);
  brollCues = resolved.cues;
  for (const n of resolved.notes) warnings.push(`[broll] ${n}`);

  // Handle synthetic fallbacks - generate actual files for synthetic: sources
  const realBroll = brollCues.filter((c) => !isSyntheticBroll(c.source));
  const syntheticBroll = brollCues.filter((c) => isSyntheticBroll(c.source));

  if (syntheticBroll.length > 0) {
    warnings.push(`[broll] ${syntheticBroll.length} synthetic B-roll generated (keyword-based fallback)`);
    const syntheticCues: BRollCue[] = [];
    for (let i = 0; i < brollCues.length; i++) {
      const cue = brollCues[i];
      if (isSyntheticBroll(cue.source)) {
        const synthFile = await generateSyntheticBRoll(cue, outDir, i);
        syntheticCues.push({ ...cue, source: synthFile });
      }
    }
    brollCues = [...realBroll, ...syntheticCues];
  }

  warnings.push(`[broll] Final: ${brollCues.length} cutaway cues (${realBroll.length} downloaded, ${brollCues.length - realBroll.length} synthetic)`);
  return brollCues;
}

export async function buildVisualTreatment(
  input: BuildTreatmentInput,
  options: TreatmentOptions = {}
): Promise<VisualTreatmentResult> {
  const { input: videoPath, clip, analysis, outDir } = input;
  const { start: clipStart, end: clipEnd, id: clipIdStr, title: clipTitle } = clip;
  const clipDuration = clipEnd - clipStart;
  const warnings: string[] = [];

  if (!fs.existsSync(videoPath)) {
    throw new Error(`Source video not found: ${videoPath}`);
  }

  const probe = await ffprobe(videoPath);
  const hasAudio = (probe.streams || []).some((s: any) => s.codec_type === 'audio');
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
  const silences = computeSilences(structure.speechActive, clipStart, clipEnd);
  const allWords = words;

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

  // Auto-adapt caption style based on video content (brightness + content type)
  // Falls back to 'hormozi' if analysis fails or file is missing
  let activeStyleId = 'hormozi';
  try {
    const { autoAdaptCaptionStyle } = await import('./captions.js');
    const videoInput = input.input;
    const adaptation = await autoAdaptCaptionStyle(videoInput);
    activeStyleId = adaptation.styleId;
  } catch {
    // Continue with default style
  }

  const kineticEvents = buildKineticCaptions(
    allWords,
    clipStart,
    clipEnd,
    decision.motion.cues
  );

  const captionQC = validateCaptions(kineticEvents, decision.motion.cues);

  let eventsForAss = kineticEvents;

  if (!captionQC.ok) {
    const repair = repairCaptions(kineticEvents, decision.motion.cues);
    if (repair.fixed) {
      eventsForAss = repair.events;
      warnings.push(`Caption QC repaired ${repair.changes.length} issue(s)`);
      for (const change of repair.changes) warnings.push(`  - ${change}`);
    }
  }

  const readability = checkCaptionReadability(kineticEvents);
  if (!readability.ok) {
    warnings.push(`Readability issues: ${readability.issues.length} word(s) read too fast`);
  }

  if (eventsForAss.length > 0) {
    const { buildKineticASS } = await import('./captions.js');
    const content = buildKineticASS(eventsForAss, { title: clipTitle, styleId: activeStyleId });
    fs.writeFileSync(kineticAssFile, content, 'utf8');
  } else {
    fs.rmSync(kineticAssFile, { force: true });
   }

   const treatment = await buildTreatment(decision, {
     ...options,
     assFile,
     kineticAssFile: fs.existsSync(kineticAssFile) ? kineticAssFile : null,
     outDir: input.outDir,
     faces: (input.analysis.structure?.faceTrack || []).map((f) => ({
       ...f,
       start: f.start - clipStart,
       end: f.end - clipStart,
     })),
     brollCues: await getBRollCues(input, allWords, clipStart, clipEnd, outDir, warnings),
    visualEffects: input.analysis.structure?.stats?.hasFace ? {
      faceHighlight: 0.2,
      backgroundBlur: 0,
      smartCrop: false,
    } : {},
  });

  warnings.push(...treatment.warnings);
  warnings.push(`Treatment: ${treatment.videoFilters.length} video filters, ${treatment.motionCues.length} motion cues`);

  const safeFilters = buildSafeRenderFilters(treatment.videoFilters, decision.motion.cues, media, clipDuration);
  for (const w of safeFilters.warnings) warnings.push(`[filter QC] ${w}`);

   // Sound effects
  const clipId = clipIdStr;
  const sfxCtx: SfxContext = {
    clipDir: path.join(path.dirname(videoPath), clipId),
    clipDuration,
  };
  const sfxResult = await applySoundEffects(decision, treatment.motionCues, clipId, sfxCtx, (frac, msg) => {
    warnings.push(`[SFX] ${msg} ${Math.round(frac * 100)}%`);
  });
  warnings.push(`[SFX] ${sfxResult.notes.join(' ')}`);

  const renderArgs = buildRenderCommand(videoPath, outFile, treatment, {
    start: clipStart,
    duration: clipDuration,
  }, sfxResult.effects, sfxResult.audioFiles, hasAudio);


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
    soundEffects: sfxResult.effects,
    sfxAudioFiles: sfxResult.audioFiles,
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
  let renderArgs = result.renderArgs;
  let normalizedInput: string | null = null;

  if (renderArgs.includes('-filter_complex')) {
    normalizedInput = path.join(path.dirname(result.outFile), 'normalized-input.mp4');
    await normalizeInput(
      input.input,
      input.clip.start,
      input.clip.end - input.clip.start,
      normalizedInput,
      result.sfxAudioFiles.length > 0
    );
    renderArgs = renderArgs.map((a, i, arr) => {
      if (a === input.input) return normalizedInput!;
      if (a === '-ss') { arr[i + 1] = '0'; return a; }
      return a;
    });
  }

  await run('ffmpeg', renderArgs, {
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

  if (normalizedInput) fs.rmSync(normalizedInput, { force: true });

  const stat = fs.statSync(result.outFile);
  if (!stat.size) {
    throw new Error('Render produced an empty output file');
  }

  result.bytes = stat.size;

  const verification = await verifyExport(result.outFile, { requireAudio: false });
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
