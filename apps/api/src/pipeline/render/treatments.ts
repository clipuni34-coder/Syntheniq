// Syntheniq — visual treatment layer: assembles FFmpeg filter chains
// from EditDecision + MotionPlan + kinetic captions.
import fs from 'node:fs';
import path from 'node:path';
import { EXPORT_SPEC, escapeFilterPath } from './index.js';
import { ROOT } from '../../config.js';
import type { EditDecision, EditSegment } from '../editorial/plan.js';
import type { MotionCue, MotionPlan, MediaInfo } from '../editorial/motion.js';
import type { KineticCaptionEvent } from './captions.js';
import type { SoundEffect } from './sfx.js';
import type { FaceTrack, BRollCue } from '../../types.js';
import {
  applyVisualEffects,
  buildFaceHighlightFilters,
  buildBackgroundBlurFilters,
  buildSmartCropFilters,
  buildBRollFilters,
  type BRollFilterResult,
  type VisualEffectOptions,
} from './faces.js';

export interface TreatmentResult {
  videoFilters: string[];
  audioFilters: string[];
  captionFilter: string | null;
  captionFilters: string[];
  motionCues: MotionCue[];
  keyframes: Array<{ t: number; type: string }>;
  brollCues: BRollCue[];
  brollNotes: string[];
  warnings: string[];
}

export interface TreatmentOptions {
  assFile?: string | null;
  kineticAssFile?: string | null;
  outDir?: string;
  maxMotionIntensity?: number;
  avoidTransitionsAtEdges?: boolean;
  faces?: FaceTrack[];
  visualEffects?: VisualEffectOptions;
  /** Resolved B-roll overlay cues (injected for tests / loaded from cues.json in production). */
  brollCues?: BRollCue[];
}

const DEFAULT_OPTIONS: Required<TreatmentOptions> = {
  assFile: null,
  kineticAssFile: null,
  outDir: '',
  maxMotionIntensity: 0.85,
  avoidTransitionsAtEdges: true,
  faces: [],
  visualEffects: {},
  brollCues: [],
};

function buildScaleCropFilters(media: MediaInfo): string[] {
  return [
    `scale=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:force_original_aspect_ratio=increase`,
    `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}`,
    'setsar=1',
    `fps=${EXPORT_SPEC.fps}`,
    'format=yuv420p',
  ];
}

function fontsDir(): string {
  return path.join(ROOT, 'assets', 'fonts');
}

function buildColorGradeFilters(): string[] {
  return [
    `eq=contrast=1.2:saturation=1.5:brightness=0.05:gamma=1.0:gamma_r=1.05:gamma_g=1.0:gamma_b=0.95`,
  ];
}

function buildVintageOverlayFilters(): string[] {
  return [
    `vignette=angle=PI/4`,
  ];
}

function buildCaptionFilters(options: Required<TreatmentOptions>): string[] {
  const filters: string[] = [];
  if (options.assFile) {
    filters.push(`subtitles=filename='${escapeFilterPath(options.assFile)}':fontsdir='${escapeFilterPath(fontsDir())}'`);
  }
  return filters;
}

function buildKineticCaptionFilter(options: Required<TreatmentOptions>): string | null {
  if (!options.kineticAssFile) return null;
  return `subtitles=filename='${escapeFilterPath(options.kineticAssFile)}':fontsdir='${escapeFilterPath(fontsDir())}'`;
}

function mergeASSFiles(baseFile: string | null, kineticFile: string | null, outDir: string): string | null {
  if (!baseFile || !kineticFile) return null;
  if (!fs.existsSync(baseFile) || !fs.existsSync(kineticFile)) return null;

  const mergePath = path.join(outDir, 'merged-captions.ass');
  const baseContent = fs.readFileSync(baseFile, 'utf8');
  const kineticContent = fs.readFileSync(kineticFile, 'utf8');

  const baseEvents = extractASSDialogue(baseContent);
  const kineticEvents = extractASSDialogue(kineticContent);

  const kineticLines = kineticContent.split('\n');
  const eventsIdx = kineticLines.findIndex((l) => l.trim().toLowerCase().startsWith('[events]'));
  if (eventsIdx < 0) return null;
  const formatLine = kineticLines[eventsIdx + 1];
  const header = kineticLines.slice(0, eventsIdx).join('\n');

  const merged = `${header}\n[Events]\n${formatLine}\n${baseEvents.join('\n')}${kineticEvents.length > 0 ? '\n' + kineticEvents.join('\n') : ''}\n`;
  fs.writeFileSync(mergePath, merged, 'utf8');
  return mergePath;
}

function extractASSDialogue(content: string): string[] {
  const lines = content.split('\n');
  const eventsIdx = lines.findIndex((l) => l.trim().toLowerCase().startsWith('[events]'));
  if (eventsIdx < 0) return [];
  const events: string[] = [];
  for (let i = eventsIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().toLowerCase().startsWith('[')) break;
    if (line.trim().length > 0 && !line.trim().toLowerCase().startsWith('format')) events.push(line);
  }
  return events;
}

function buildMotionFilters(
  cues: MotionCue[],
  media: MediaInfo,
  options: Required<TreatmentOptions>,
  segmentStart: number
): { filters: string[]; keyframes: Array<{ t: number; type: string }> } {
  const filters: string[] = [];
  const keyframes: Array<{ t: number; type: string }> = [];

  const safeCues = cues.filter((c) => {
    if ((c.intensity || 0.5) > options.maxMotionIntensity) return false;
    if (options.avoidTransitionsAtEdges) {
      if (c.t < segmentStart + 0.5 || c.t > segmentStart + media.width / 100) return false;
    }
    return true;
  });

  for (const cue of safeCues) {
    const t = r2(cue.t - segmentStart);
    const dur = cue.duration;

    switch (cue.kind) {
      case 'emphasis': {
        const intensity = clamp01(cue.intensity || 0.6);
        const zoom = 1 + intensity * 0.15;
        const scaledW = Math.round(EXPORT_SPEC.width * zoom);
        const scaledH = Math.round(EXPORT_SPEC.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:(iw-${EXPORT_SPEC.width})/2:(ih-${EXPORT_SPEC.height})/2`
        );
        keyframes.push({ t, type: 'emphasis_zoom' });
        break;
      }

      case 'impact': {
        const alpha = clamp01((cue.intensity || 0.7) * 0.4);
        filters.push(
          `drawbox=x=0:y=0:w=iw:h=ih:color=white@${alpha.toFixed(2)}:t=fill:enable='between(t,${t},${r2(t + dur)})'`
         );
         keyframes.push({ t, type: 'impact_flash' });
        break;
      }

      case 'punch_in': {
        const zoom = 1.5 + (cue.intensity || 0.7) * 1.5;
        const scaledW = Math.round(EXPORT_SPEC.width * zoom);
        const scaledH = Math.round(EXPORT_SPEC.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:(iw-${EXPORT_SPEC.width})/2:(ih-${EXPORT_SPEC.height})/2`
        );
        keyframes.push({ t, type: 'punch_in' });
        break;
      }

      case 'transition': {
        const variant = cue.variant || 'flash';
        const alpha = clamp01((cue.intensity || 0.6) * 0.3);
        if (variant === 'flash') {
           filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@${alpha.toFixed(2)}:t=fill:enable='between(t,${t},${r2(t + dur)})'`);
        }
        keyframes.push({ t, type: `transition_${variant}` });
        break;
      }

      case 'settle': {
        const zoom = 1.05;
        const scaledW = Math.round(EXPORT_SPEC.width * zoom);
        const scaledH = Math.round(EXPORT_SPEC.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:(iw-${EXPORT_SPEC.width})/2:(ih-${EXPORT_SPEC.height})/2`
        );
        keyframes.push({ t, type: 'settle_zoom' });
        break;
      }

      case 'lower_third': {
        if (cue.variant === 'action_text') {
          const text = (cue.word || cue.label).replace(/:/g, '');
          filters.push(
            `drawbox=x=0:y=0:w=iw:h=80:color=black@0.7:t=fill:enable='between(t,${t},${r2(t + dur)})',` +
            `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${text}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=20:enable='between(t,${t},${r2(t + dur)})'`
          );
          keyframes.push({ t, type: 'action_text' });
        }
        break;
      }

      case 'action_overlay': {
        const text = (cue.word || cue.label).replace(/:/g, '');
        const fontSize = 48 + Math.floor((cue.intensity || 0.6) * 24);
        const alpha = clamp01((cue.intensity || 0.6) * 0.7);
        filters.push(
          `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${text}':fontsize=${fontSize}:fontcolor=white:box=1:boxcolor=black@${alpha.toFixed(2)}:boxborderw=6:x=(w-text_w)/2:y=(h-text_h)/3:enable='between(t,${t},${r2(t + dur)})'`
        );
        keyframes.push({ t, type: 'action_overlay' });
        break;
      }

      case 'text_card': {
        const text = (cue.word || cue.label).replace(/:/g, '');
        const bgColor = cue.variant || '0x8B4513@0.8';
        filters.push(
          `drawbox=x=0:y=0:w=iw:h=ih:color=${bgColor}:t=fill:enable='between(t,${t},${r2(t + dur)})',` +
          `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${text}':fontsize=64:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:enable='between(t,${t},${r2(t + dur)})'`
        );
        keyframes.push({ t, type: 'text_card' });
        break;
      }
    }
  }

  return { filters, keyframes };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function buildSegmentFilters(
  seg: EditSegment,
  decision: EditDecision,
  options: Required<TreatmentOptions>
): { videoFilters: string[]; keyframes: Array<{ t: number; type: string }> } {
  const media = decision.media;
  const segmentStart = seg.start;

  const scaleCrop = buildScaleCropFilters(media);
  const allFilters: string[] = [...scaleCrop];
  const allKeyframes: Array<{ t: number; type: string }> = [];

  const segCues = decision.motion.cues.filter(
    (c) => c.t >= seg.start && c.t <= seg.end
  );

  if (segCues.length > 0) {
    const motionFilters = buildMotionFilters(segCues, media, options, segmentStart);
    allFilters.push(...motionFilters.filters);
    allKeyframes.push(...motionFilters.keyframes);
  }

  if (seg.transitions.in) {
    allKeyframes.push({ t: seg.start, type: `transition_in_${seg.transitions.in}` });
    const fadeDur = 0.5;
    if (seg.transitions.in === 'flash') {
      allFilters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@0.6:t=fill:enable='between(t,0,${fadeDur})'`);
    } else if (seg.transitions.in === 'wipe') {
      allFilters.push(`fade=t=in:st=0:d=${fadeDur}:alpha=1`);
    } else {
      allFilters.push(`fade=t=in:st=0:d=${fadeDur}:alpha=1`);
    }
  }
  if (seg.transitions.out) {
    allKeyframes.push({ t: seg.end, type: `transition_out_${seg.transitions.out}` });
    const fadeDur = 0.5;
    const segDur = seg.end - seg.start;
    if (seg.transitions.out === 'flash') {
      allFilters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@0.6:t=fill:enable='between(t,0,${fadeDur})'`);
    } else if (seg.transitions.out === 'wipe') {
      allFilters.push(`fade=t=out:st=${segDur - fadeDur}:d=${fadeDur}:alpha=1`);
    } else {
      allFilters.push(`fade=t=out:st=${segDur - fadeDur}:d=${fadeDur}:alpha=1`);
    }
  }

  return { videoFilters: allFilters, keyframes: allKeyframes };
}

export async function buildTreatment(
  decision: EditDecision,
  options: TreatmentOptions = {}
): Promise<TreatmentResult> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];
  const allKeyframes: Array<{ t: number; type: string }> = [];
  const allCues: MotionCue[] = [];

  const baseScaleCrop = [...buildScaleCropFilters(decision.media), ...buildColorGradeFilters(), ...buildVintageOverlayFilters()];

  // Apply visual effects (face highlighting, background blur, per-segment smart crop, stabilization)
  const faces = opts.faces || [];

  const clipStart = decision.segments[0]?.start || 0;
  const isMultiSegment = decision.segments.length > 1;

  for (const seg of decision.segments) {
    const { videoFilters: segFilters, keyframes } = buildSegmentFilters(seg, decision, opts);
    allCues.push(...seg.cues);
    allKeyframes.push(...keyframes.map((k) => ({ t: k.t, type: k.type })));

    if (faces.length > 0) {
      const relSegStart = seg.start - clipStart;
      const relSegEnd = seg.end - clipStart;
      const segFaces = faces.filter(
        (f) => f.start >= relSegStart && f.start <= relSegEnd
      );
      // In single-segment case, face timestamps stay clip-relative (no trim reset).
      // In multi-segment case, subtract segment start since trim resets timestamps to 0.
      const faceOffset = isMultiSegment ? relSegStart : 0;
      const relFaces = segFaces.map((f) => ({
        ...f,
        start: f.start - faceOffset,
        end: f.end - faceOffset,
      }));
       if (relFaces.length > 0) {
         if (opts.visualEffects?.backgroundBlur && opts.visualEffects.backgroundBlur > 0) {
           const bb = buildBackgroundBlurFilters(relFaces, opts.visualEffects, decision.media.width, decision.media.height);
           segFilters.push(...bb.filters);
         }
         if (opts.visualEffects?.smartCrop !== false) {
           const sc = buildSmartCropFilters(relFaces, decision.media.width, decision.media.height);
           segFilters.push(...sc.filters);
           allKeyframes.push(...sc.keyframes);
         }
         if (opts.visualEffects?.faceHighlight) {
           const hl = buildFaceHighlightFilters(relFaces, opts.visualEffects, decision.media.width, decision.media.height);
           segFilters.push(...hl.filters);
           allKeyframes.push(...hl.keyframes);
         }
      }
    }

    if (isMultiSegment) {
      const relStart = seg.start - clipStart;
      const relEnd = seg.end - clipStart;
      const trimFilter = `trim=start=${relStart}:end=${relEnd},setpts=PTS-STARTPTS,setsar=1`;
      const chain = [trimFilter, ...segFilters, 'setsar=1'].join(',');
      videoFilters.push(`[0:v]${chain}[${seg.id}]`);
    } else {
      // Single segment: no labels, chain filters directly (uses -vf, not -filter_complex)
      videoFilters.push(...segFilters);
    }
  }

  if (isMultiSegment) {
    const concatInputs = decision.segments.map((s) => `[${s.id}]`).join('');
    videoFilters.push(`${concatInputs}concat=n=${decision.segments.length}:v=1:a=0,setsar=1[v]`);
    videoFilters.push(`[v]${baseScaleCrop.join(',')}`);
  } else {
    videoFilters.push(...baseScaleCrop);
  }

  if (allCues.length > 8) {
    warnings.push(`High cue density (${allCues.length} cues) — may cause visual overload`);
  }

  const totalMotion = allCues.reduce((sum, c) => sum + c.duration, 0);
  if (totalMotion > 30) {
    warnings.push(`Total motion cue duration (${totalMotion.toFixed(1)}s) is high`);
  }

  const captionFilter = buildKineticCaptionFilter(opts);

  // Only use kinetic captions (middle position) - do NOT merge with base captions
  // Base captions appear at the bottom (MarginV=420) and cause overlap/conflict
  // Kinetic captions appear in the middle band (optimal TikTok position)
  // Previously: mergedAssFile = mergeASSFiles(opts.assFile, opts.kineticAssFile, ...)
  // which combined BOTH base (bottom) and kinetic (middle) captions on screen
  let mergedAssFile: string | null = null;
  // Skip merge entirely - kinetic captions contain full phrase text with animations

  // Use kinetic-only captions (middle position), or fall back to base if no kinetic
  const baseCaptionFilters = captionFilter
    ? [captionFilter]
    : buildCaptionFilters(opts);

  return {
    videoFilters,
    audioFilters,
    captionFilter: null, // Always null — all caption filters are in captionFilters array
    captionFilters: baseCaptionFilters,
    motionCues: allCues,
    keyframes: allKeyframes,
    brollCues: opts.brollCues ?? [],
    brollNotes: [],
    warnings,
  };
}

export function buildRenderCommand(
  input: string,
  outFile: string,
  treatment: TreatmentResult,
  { start, duration }: { start: number; duration: number },
  sfxEffects: SoundEffect[] = [],
  sfxAudioFiles: string[] = [],
  hasAudio: boolean = true
): string[] {
  const hasLabels = treatment.videoFilters.some((f) => f.includes('['));
  const allVideoFilters = [...treatment.videoFilters];
  const captionFilters = [...treatment.captionFilters, treatment.captionFilter].filter(Boolean) as string[];
  const hasSfx = sfxAudioFiles.length > 0 && sfxEffects.length > 0;
  const canMixAudio = hasSfx && hasAudio;

  const brollCues = treatment.brollCues ?? [];
  // Build the B-roll overlay subgraph up front so we only force -filter_complex
  // when at least one valid cue survives validation (invalid/missing sources
  // degrade out instead of leaving an unmapped [outv] pad).
  const br: BRollFilterResult = buildBRollFilters(brollCues, {
    baseLabel: '[base]',
    startInputIndex: 1 + sfxAudioFiles.length,
    exportWidth: EXPORT_SPEC.width,
    exportHeight: EXPORT_SPEC.height,
    fps: EXPORT_SPEC.fps,
  });
  const hasBroll = br.inputCount > 0;

  if (hasLabels || hasSfx || hasBroll) {
    // Complex filtergraph with intermediate labels — must use -filter_complex
    const inputs: string[] = ['-hide_banner', '-y', '-ss', String(start), '-t', String(duration), '-i', input];
    
    // Add caption filters to the last video filter chain
    if (captionFilters.length > 0) {
      if (allVideoFilters.length === 0) {
        // No existing video filters, create a new chain starting from main input
        allVideoFilters.push(`[0:v]${captionFilters.join(',')},setsar=1,format=yuv420p`);
      } else if (allVideoFilters[0].startsWith('[0:v]')) {
        // Chain already starts with [0:v], append captions to first filter
        allVideoFilters[0] = allVideoFilters[0].replace(/(\[0:v\])/, `[0:v]${captionFilters.join(',')},`);
      } else {
        const lastIdx = allVideoFilters.length - 1;
        if (lastIdx >= 0 && allVideoFilters[lastIdx].includes('[') && allVideoFilters[lastIdx].includes(']')) {
          // Already has input label, append captions
          allVideoFilters[lastIdx] = `${allVideoFilters[lastIdx]},${captionFilters.join(',')}`;
        } else {
          // No input label: just append captions (the [0:v] input label is handled
          // by the singleChain builder on line ~462 when hasLabels is false,
          // or is already present at the head of the labeled chain).
          allVideoFilters[lastIdx] = `${allVideoFilters[lastIdx]},${captionFilters.join(',')}`;
        }
      }
    }
    
    // When using filter_complex, ensure video filters have proper input/output labels.
    // When SFX are present without multi-segment labels, join all video filters into a
    // single chain and force yuv420p to pass QC (input may be yuvj420p).
    // The base video pad must terminate at a known label so B-roll overlays can
    // consume it: with B-roll it ends at [base] (overlays then emit [outv]);
    // otherwise it ends at [outv] directly.
    const outLabel = hasBroll ? 'base' : 'outv';
    let videoChains: string[];
    if (!hasLabels && allVideoFilters.length > 0 && !allVideoFilters[0].includes('[0:v]')) {
      // Join all filters into a single chain with [0:v] input and [outLabel] output
      const singleChain = `[0:v]${allVideoFilters.join(',')},setsar=1,setparams=range=tv,format=yuv420p[${outLabel}]`;
      videoChains = [singleChain];
    } else {
      videoChains = allVideoFilters;
      // Ensure output label exists on the last video chain
      const lastVidIdx = videoChains.length - 1;
      if (!videoChains[lastVidIdx].includes(`[${outLabel}]`)) {
        videoChains[lastVidIdx] = `${videoChains[lastVidIdx]},setsar=1,setparams=range=tv,format=yuv420p[${outLabel}]`;
      }
    }
    
    // Add SFX input files (indices 1..N after the main input 0)
    if (hasSfx) {
      for (const sfxFile of sfxAudioFiles) {
        inputs.push('-i', sfxFile);
      }
    }

    // B-roll video inputs come after SFX inputs, so their ffmpeg input index is
    // 1 (main) + sfxAudioFiles.length + cueIndex. B-roll is silent: base audio
    // is left untouched. (br was built up front from treatment.brollCues.)
    for (const src of br.inputs) {
      inputs.push('-i', src);
    }

    // Build audio filter chains (separate from video chains in filter_complex)
    const audioChains: string[] = [];

    if (hasSfx) {
      // Delay each SFX and label output
      const sfxLabels: string[] = [];
      for (let i = 0; i < sfxAudioFiles.length; i++) {
        const effect = sfxEffects[i];
        const delayMs = Math.round(effect.start * 1000);
        audioChains.push(`[${i + 1}:a]adelay=delays=${delayMs}|${delayMs}[a${i}]`);
        sfxLabels.push(`[a${i}]`);
      }

      if (hasAudio) {
        // Audio ducking: compress background audio when SFX plays
        // First create a sidechain trigger signal from all SFX
        const sfxMixLabel = '[sfx_mix]';
        if (sfxLabels.length > 1) {
          audioChains.push(`${sfxLabels.join('')}amix=inputs=${sfxLabels.length}:normalize=0,asetrate=48000${sfxMixLabel}`);
        } else {
           audioChains.push(`${sfxLabels[0]}asetrate=48000${sfxMixLabel}`);
        }
        // Duck background audio when SFX plays using sidechain compression
        // Sidechain input is the SFX mix trigger, main input is original audio
        // threshold=0.02, ratio=4, attack=5ms, release=150ms
        audioChains.push(`[0:a]${sfxMixLabel}sidechaincompress=threshold=0.02:ratio=4:attack=5:release=150:makeup=1[ducked]`);
        // Mix ducked background with the SFX mix for final output
        audioChains.push(`[ducked]${sfxMixLabel}amix=inputs=2:dropout_transition=2,atrim=duration=${duration}[outa]`);
      } else {
        // No original audio, just mix the SFX files together
        const allAudioInputs = sfxLabels.join('');
        audioChains.push(`${allAudioInputs}amix=inputs=${sfxLabels.length}:dropout_transition=2,atrim=duration=${duration}[outa]`);
      }
    }
    
     // Combine all filter chains with semicolons. B-roll chains consume
      // [base] and the final overlay emits [outv], which we map as the output.
      const allChains = [...videoChains, ...br.chains, ...audioChains];
     inputs.push('-filter_complex', allChains.join(';'));
    
     inputs.push('-map', '[outv]');
     if (hasSfx) {
       inputs.push('-map', '[outa]');
     } else {
       inputs.push('-map', '0:a:0?');
     }
  
     inputs.push('-progress', 'pipe:1', '-nostats');
    inputs.push(
      '-c:v', EXPORT_SPEC.videoCodec,
      '-profile:v', 'high',
      '-preset', 'veryfast',
      '-crf', '20',
      '-r', String(EXPORT_SPEC.fps),
      '-pix_fmt', EXPORT_SPEC.pixFmt,
      '-c:a', EXPORT_SPEC.audioCodec,
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-shortest',
      outFile,
  );
    
    return inputs;
  }

  const args = [
    '-hide_banner', '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', input,
    '-vf', [...allVideoFilters, ...captionFilters, 'setsar=1,setparams=range=tv,format=yuv420p'].filter(Boolean).join(','),
  ];

  if (treatment.audioFilters.length > 0) {
    args.push('-af', treatment.audioFilters.join(','));
  }

  args.push(
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', EXPORT_SPEC.videoCodec,
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', '20',
    '-progress', 'pipe:1',
    '-nostats',
    '-r', String(EXPORT_SPEC.fps),
    '-pix_fmt', EXPORT_SPEC.pixFmt,
    '-c:a', EXPORT_SPEC.audioCodec,
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    outFile,
  );

  return args;
}
