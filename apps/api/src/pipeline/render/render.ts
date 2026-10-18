// Syntheniq — visual treatment rendering engine.
// Integrates emotion → retention → motion → edit-decision → FFmpeg filters.
import fs from 'node:fs';
import path from 'node:path';
import type { Segment, Word, EnergyPoint, Span, Clip, Scores, StructureData } from '../../types.js';
import type { AnalysisData } from '../../types.js';
import { analyzeEmotion } from '../editorial/emotion.js';
import { scoreRetentionArchitecture, type RetentionBeat } from '../editorial/retention.js';
import { planMotion } from '../editorial/motion.js';
import { buildEditDecision, type EditDecision } from '../editorial/plan.js';
import { buildCaptionEvents, buildKineticCaptions, writeASS, type KineticCaptionEvent } from './captions.js';
import { validateCaptions, repairCaptions, checkCaptionReadability, type CaptionQCResult } from './caption-qc.js';
import { buildTreatment, buildRenderCommand, type TreatmentOptions, type TreatmentResult } from './treatments.js';
import { applySoundEffects, type SoundEffect, type SfxContext } from './sfx.js';
import { EXPORT_SPEC, escapeFilterPath } from './index.js';
import { run, ffprobe } from '../../lib/ffmpeg.js';
import type { MediaInfo, MotionCue } from '../editorial/motion.js';
import { verifyExport } from '../editorial/qc.js';
import { buildSafeRenderFilters } from '../editorial/qc.js';
import { themeEditingProfile, type ContentTheme } from '../editorial/themes.js';

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
  soundEffects: SoundEffect[];
  sfxAudioFiles: string[];
  bytes: number;
  verified: boolean;
  warnings: string[];
  enhancements: ViralEnhancement;
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
  theme?: ContentTheme;
  dopamineMoments?: Array<{ time: number; type: string; intensity: number; rationale: string }>;
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

  // Theme-aware enhancement: adjust segment count and cue density to match
  // the content theme's viral editing profile.
  const theme = input.theme || 'general';
  const profile = themeEditingProfile(theme);
  const themeStats = structure.stats || {};
  const sceneCuts = structure.sceneCuts || [];

  if (decision.segments.length < profile.targetSegmentCount && profile.targetSegmentCount > 2) {
    const cutsInClip = sceneCuts
      .filter((t) => t >= clipStart && t <= clipEnd)
      .sort((a, b) => a - b);

    const extraCuts = cutsInClip.slice(0, profile.targetSegmentCount - decision.segments.length);
    for (const cutT of extraCuts) {
      const segStart = round3(cutT - clipStart);
      if (segStart > 0.5 && segStart < clipDuration - 0.5) {
        const existing = decision.segments.find((s) => Math.abs(s.start - segStart) < 1 || Math.abs(s.end - segStart) < 1);
        if (!existing) {
          decision.segments.push({
            id: `seg-theme-${cutT.toFixed(1)}`,
            start: segStart,
            end: round3(segStart + 1),
            duration: 1,
            source: 'main',
            title: 'theme-break',
            purpose: 'transition',
            transitions: { in: 'flash', out: 'flash' },
            cues: [],
            notes: [`[${theme}] Dynamic cut at ${cutT.toFixed(1)}s for segment variety`],
          });
        }
      }
    }
    decision.segments.sort((a, b) => a.start - b.start);
    const segIds = decision.segments.map((s, i) => `seg-${i + 1}`);
    decision.segments.forEach((s, i) => { s.id = segIds[i]; });
  }

  if (themeStats.sfxDensity !== undefined && profile.sfxDensity > 0.7 && decision.motion.cues.length < Math.ceil(clipDuration * profile.sfxDensity)) {
    const targetCues = Math.ceil(clipDuration * profile.sfxDensity);
    const spacing = clipDuration / targetCues;
    for (let i = 0; i < targetCues - decision.motion.cues.length; i++) {
      const t = round3(spacing * (i + 1));
      const existing = decision.motion.cues.find((c) => Math.abs(c.t - t) < 2);
      if (!existing) {
        decision.motion.cues.push({
          kind: 'impact',
          t,
          duration: 1,
          intensity: profile.sfxDensity * 0.5,
          label: `[${theme}] viral SFX cue`,
        });
      }
    }
    decision.motion.cues.sort((a, b) => a.t - b.t);
    decision.summary = `${decision.segments.length} segments | ${decision.motion.cues.length} cues | theme: ${theme}`;
  }

  // Addiction-aware hook placement: strategic engagement spikes that combat
  // the "scroll zombie" effect — hooks every 3-5s, peak at 70%, payoff at 90%.
  const existingCueTimes = decision.motion.cues.map((c) => c.t);
  const hookCues: Array<{ t: number; kind: MotionCue['kind']; intensity: number; label: string; variant?: string }> = [];

  // Immediate hook at 0.3-0.5s
  if (!existingCueTimes.some((t) => t < 1.5)) {
    hookCues.push({ t: 0.3, kind: 'impact', intensity: 0.6, label: 'instant hook', variant: 'flash' });
  }

  // Retention hooks at 3-4s intervals
  const retentionInterval = profile.sfxDensity > 0.7 ? 3 : 4;
  for (let t = retentionInterval; t < clipDuration - 2; t += retentionInterval) {
    if (existingCueTimes.some((et) => Math.abs(et - t) < 1.5)) continue;
    const cueTypes: Array<MotionCue['kind']> = ['emphasis', 'impact', 'pulse', 'transition', 'lower_third'];
    const cueType = cueTypes[Math.floor(t / retentionInterval) % cueTypes.length];
    const intensity = 0.4 + (t / clipDuration) * 0.3;
    hookCues.push({ t: round3(t), kind: cueType, intensity, label: `retention @${t.toFixed(0)}s` });
  }

  // Peak energy at ~70%
  const peakT = round3(clipDuration * 0.7);
  if (!existingCueTimes.some((t) => Math.abs(t - peakT) < 2)) {
    hookCues.push({ t: peakT, kind: 'punch_in', intensity: 0.8, label: 'viral peak', variant: 'flash' });
  }

  // Payoff/cliffhanger at ~90%
  const payoffT = round3(clipDuration * 0.9);
  if (!existingCueTimes.some((t) => Math.abs(t - payoffT) < 2)) {
    hookCues.push({ t: payoffT, kind: 'impact', intensity: 0.9, label: 'payoff punch', variant: 'flash' });
  }

  // Guaranteed enhanced effects: sliding lower-third and wipe transition.
  // These are core requirements — place them at strategic mid-clip positions,
  // pushing past existing cues rather than skipping so the enhanced treatment
  // always ships with sliding lower-thirds and wipe transitions.
  const lowerThirdT = round3(clipDuration * 0.22);
  decision.motion.cues.push({
    kind: 'lower_third',
    t: lowerThirdT,
    duration: 1.5,
    intensity: 0.5,
    label: 'stay curious',
  });

  const wipeT = round3(clipDuration * 0.6);
  decision.motion.cues.push({
    kind: 'transition',
    t: wipeT,
    duration: 1.5,
    intensity: 0.6,
    label: 'scene shift',
    variant: 'wipe',
   });

  for (const hc of hookCues) {
    decision.motion.cues.push({
      kind: hc.kind,
      t: hc.t,
      duration: hc.kind === 'impact' ? 1 : 1.5,
      intensity: hc.intensity,
      label: hc.label,
      variant: hc.variant,
    });
  }
  decision.motion.cues.sort((a, b) => a.t - b.t);

  // Ensure segment transitions exist at key hook points for maximum cut variety
  const hookTimes = hookCues.map((hc) => hc.t);
  for (const ht of hookTimes) {
    const relT = round3(ht);
    const hasSegment = decision.segments.find((s) => Math.abs(s.start - relT) < 1.5 || Math.abs(s.end - relT) < 1.5);
    if (!hasSegment && relT > 1 && relT < clipDuration - 1) {
      decision.segments.push({
        id: `seg-hook-${relT}`,
        start: relT,
        end: round3(Math.min(clipDuration, relT + 2)),
        duration: 2,
        source: 'main',
        title: 'hook-break',
        purpose: 'transition',
        transitions: { in: profile.preferredTransitions[0] || 'flash', out: null },
        cues: [],
        notes: [`[${theme}] Addiction hook segment at ${relT}s`],
      });
    }
  }
  decision.segments.sort((a, b) => a.start - b.start);
  decision.segments.forEach((s, i) => { s.id = `seg-${i + 1}`; });
  decision.summary = `${decision.segments.length} segments | ${decision.motion.cues.length} cues | theme: ${theme} | ${hookCues.length} hook cues`;

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
    decision.motion.cues,
    analysis
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
    const content = buildKineticASS(eventsForAss, { title: clipTitle });
    fs.writeFileSync(kineticAssFile, content, 'utf8');
  } else {
    fs.rmSync(kineticAssFile, { force: true });
  }

  const treatment = await buildTreatment(decision, {
    ...options,
    assFile,
    kineticAssFile: fs.existsSync(kineticAssFile) ? kineticAssFile : null,
    faces: input.analysis.structure?.faceTrack || [],
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
     clipDir: outDir,
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

  const enhancements = recommendEnhancements(clip, decision, structure);
  for (const rec of enhancements.recommendations) {
    warnings.push(`[Viral] ${rec}`);
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
    enhancements,
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

  const verification = await verifyExport(result.outFile, { requireAudio: false });
  result.verified = verification.ok;

  if (!verification.ok) {
    result.warnings.push(`Export verification failed: ${verification.issues.join(', ')}`);
  }

  return result;
}

export function predictViralScore(
  clip: Pick<Clip, 'start' | 'end' | 'scores'>,
  decision: EditDecision,
  structure: AnalysisData['structure']
): number {
  const duration = Math.max(0.1, clip.end - clip.start);

  const sceneCuts = structure.sceneCuts || [];
  const energyCurve = structure.energyCurve || [];
  const speechActive = structure.speechActive || [];

  const cutsInRange = sceneCuts.filter((t) => t >= clip.start && t <= clip.end).length;
  const cutDensity = cutsInRange / duration;

  const energyPoints = energyCurve.filter((p) => p.t >= clip.start && p.t <= clip.end);
  let energyVariance = 0;
  let meanEnergy = 0;
  if (energyPoints.length > 1) {
    meanEnergy = energyPoints.reduce((a, p) => a + p.rms, 0) / energyPoints.length;
    energyVariance = energyPoints.reduce((a, p) => a + (p.rms - meanEnergy) ** 2, 0) / energyPoints.length;
  }

  let speechCovered = 0;
  for (const s of speechActive) {
    speechCovered += Math.max(0, Math.min(clip.end, s.end) - Math.max(clip.start, s.start));
  }
  const speechRatio = Math.min(1, speechCovered / duration);
  const silenceRatio = 1 - speechRatio;

  const cueIntensitySum = decision.motion.cues.reduce((sum, c) => sum + (c.intensity || 0.5), 0);
  const cueCount = decision.motion.cues.length;
  const avgCueIntensity = cueCount > 0 ? cueIntensitySum / cueCount : 0;

  const segCount = decision.segments.length;
  const transitionCount = decision.segments.filter((s) => s.transitions.in || s.transitions.out).length;

  const hookPosition = clip.start / duration;
  const payoffPosition = 1 - (clip.end - clip.start) / duration;

  const hookScore = Math.max(0, 1 - Math.abs(hookPosition - 0.1) * 5);
  const payoffScore = Math.max(0, 1 - Math.abs(payoffPosition - 0.1) * 5);
  const varietyScore = clampV(0.3 + segCount * 0.1 + cutDensity * 2 + avgCueIntensity * 0.5);
  const energyScore = clampV(0.3 + energyVariance * 15);
  const dynamicScore = clampV(0.3 + (1 - Math.abs(speechRatio - 0.6)) * 0.4);

  const baseScore = (
    clip.scores.hook * 0.25 +
    clip.scores.emotion * 0.2 +
    clip.scores.payoff * 0.2 +
    clip.scores.curiosity * 0.15 +
    clip.scores.visual * 0.1 +
    clip.scores.standalone * 0.1
  );

  const multipliers = {
    hook: hookScore,
    payoff: payoffScore,
    variety: varietyScore,
    energy: energyScore,
    dynamic: dynamicScore,
    transitions: clampV(1 + transitionCount * 0.05),
    cues: clampV(1 + cueCount * 0.03),
  };

  let viralScore = baseScore;
  viralScore *= multipliers.hook;
  viralScore *= multipliers.payoff;
  viralScore *= multipliers.variety;
  viralScore *= multipliers.energy;
  viralScore *= multipliers.dynamic;
  viralScore *= multipliers.transitions;
  viralScore *= multipliers.cues;

  if (silenceRatio > 0.15 && silenceRatio < 0.4) viralScore *= 1.15;
  if (segCount > 1) viralScore *= 1.1;
  if (cueCount > 3) viralScore *= 1.05;

  const stats = structure.stats || {};
  const theme = (stats.theme as ContentTheme) || 'general';
  const profile = themeEditingProfile(theme);
  const themeMatch = Math.abs((profile.energyTarget || 0.5) - meanEnergy) < 0.1 ? 1.1 : 1;
  viralScore *= themeMatch;

  return clampV(viralScore);
}

export interface ViralEnhancement {
  needsBgMusic: boolean;
  musicIntensity: number;
  needsMoreTransitions: boolean;
  targetTransitionCount: number;
  needsMoreSfx: boolean;
  targetSfxCount: number;
  needsTextOverlay: boolean;
  needsEmphasis: boolean;
  dynamicCuts: number;
  recommendations: string[];
}

export function recommendEnhancements(
  clip: Pick<Clip, 'start' | 'end' | 'predictedSfxCount' | 'predictedTransitions'> & {
    scores: Partial<Scores> & { emotion: number };
  },
  decision: EditDecision,
  structure: AnalysisData['structure']
): ViralEnhancement {
  const duration = Math.max(0.1, clip.end - clip.start);
  const sceneCuts = structure.sceneCuts || [];
  const energyCurve = structure.energyCurve || [];
  const speechActive = structure.speechActive || [];

  const stats = structure.stats || {};
  const theme = (stats.theme as ContentTheme) || 'general';
  const profile = themeEditingProfile(theme);

  const cutsInRange = sceneCuts.filter((t) => t >= clip.start && t <= clip.end).length;
  const cutDensity = cutsInRange / duration;

  const energyPoints = energyCurve.filter((p) => p.t >= clip.start && p.t <= clip.end);
  let energyVariance = 0;
  let meanEnergy = 0;
  if (energyPoints.length > 1) {
    meanEnergy = energyPoints.reduce((a, p) => a + p.rms, 0) / energyPoints.length;
    energyVariance = energyPoints.reduce((a, p) => a + (p.rms - meanEnergy) ** 2, 0) / energyPoints.length;
  }

  let speechCovered = 0;
  for (const s of speechActive) {
    speechCovered += Math.max(0, Math.min(clip.end, s.end) - Math.max(clip.start, s.start));
  }
  const speechRatio = Math.min(1, speechCovered / duration);
  const silenceRatio = 1 - speechRatio;

  const segCount = decision.segments.length;
  const transitionCount = decision.segments.filter((s) => s.transitions.in || s.transitions.out).length;
  const cueCount = decision.motion.cues.length;
  const predictedSfx = clip.predictedSfxCount || 0;
  const predictedTrans = clip.predictedTransitions || 0;

  const recommendations: string[] = [];

  const needsBgMusic = speechRatio < 0.5 && meanEnergy < 0.02 && profile.sfxDensity < 0.7;
  let musicIntensity = profile.sfxDensity * 0.4;
  if (speechRatio > 0.7) {
    musicIntensity = 0.15;
  } else if (meanEnergy < 0.005) {
    musicIntensity = Math.min(0.6, profile.sfxDensity * 0.5 + 0.2);
    recommendations.push(`[${theme}] Low energy (${meanEnergy.toFixed(3)}) — add ${musicIntensity > 0.4 ? 'rhythmic' : 'ambient'} background music`);
  } else if (silenceRatio > 0.3) {
    musicIntensity = Math.min(0.5, profile.sfxDensity * 0.4 + 0.2);
    recommendations.push(`[${theme}] Silent passage (${Math.round(silenceRatio * 100)}% silence) — add background track`);
  }

  const themeTargetTrans = profile.targetSegmentCount;
  const dynamicTargetTrans = Math.max(themeTargetTrans, Math.ceil(cutDensity * duration * 1.5));
  const targetTransitionCount = Math.min(dynamicTargetTrans, Math.ceil(duration / 6));
  const needsMoreTransitions = transitionCount < targetTransitionCount;
  if (needsMoreTransitions) {
    recommendations.push(
      `[${theme}] Only ${transitionCount} transitions — add ${targetTransitionCount - transitionCount} more (${profile.preferredTransitions.join(', ')} preferred)`
    );
  }

  const targetSfxCount = Math.max(2, Math.round(duration * profile.sfxDensity));
  const needsMoreSfx = predictedSfx < targetSfxCount;
  if (needsMoreSfx) {
    recommendations.push(
      `[${theme}] Predicted ${predictedSfx} SFX — increase to ${targetSfxCount} (density: ${profile.sfxDensity})`
    );
  }

  const needsTextOverlay = silenceRatio > 0.15 && profile.textDensity > 0.4;
  if (needsTextOverlay) {
    recommendations.push(`[${theme}] ${Math.round(silenceRatio * 100)}% silence — add text overlays to retain viewers`);
  }

  const hookScore = clip.scores.hook || 0;
  const payoffScore = clip.scores.payoff || 0;
  const needsEmphasis = hookScore < 0.5 || payoffScore < 0.5;
  if (needsEmphasis) {
    recommendations.push(
      `[${theme}] Weak hook(${hookScore.toFixed(2)})/payoff(${payoffScore.toFixed(2)}) — add emphasis effects (${profile.emphasisPoints} points)`
    );
  }

  const dynamicCuts = Math.max(0, segCount - profile.targetSegmentCount);
  if (dynamicCuts > 0 && theme === 'shock') {
    recommendations.push(`[${theme}] High energy variance — add ${dynamicCuts} dynamic cut points`);
  }

  if (profile.energyTarget > 0.6 && meanEnergy < profile.energyTarget) {
    recommendations.push(`[${theme}] Target energy ${profile.energyTarget.toFixed(1)} not met (${meanEnergy.toFixed(3)}) — boost with impact SFX`);
  }

  return {
    needsBgMusic,
    musicIntensity: clampV(musicIntensity),
    needsMoreTransitions,
    targetTransitionCount,
    needsMoreSfx,
    targetSfxCount,
    needsTextOverlay,
    needsEmphasis,
    dynamicCuts,
    recommendations,
  };
}

function clampV(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function evalFps(value: string): number {
  const m = String(value).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return 0;
  const den = m[2] !== undefined ? parseFloat(m[2]) : 1;
  return den ? parseFloat(m[1]) / den : 0;
}
