// Syntheniq — visual treatment layer: assembles FFmpeg filter chains
// from EditDecision + MotionPlan + kinetic captions.
import { EXPORT_SPEC } from './index.js';
import type { EditDecision, EditSegment } from '../editorial/plan.js';
import type { MotionCue, MotionPlan, MediaInfo } from '../editorial/motion.js';
import type { KineticCaptionEvent } from './captions.js';

export interface TreatmentResult {
  videoFilters: string[];
  audioFilters: string[];
  captionFilter: string | null;
  captionFilters: string[];
  motionCues: MotionCue[];
  keyframes: Array<{ t: number; type: string }>;
  warnings: string[];
}

export interface TreatmentOptions {
  assFile?: string | null;
  kineticAssFile?: string | null;
  maxMotionIntensity?: number;
  avoidTransitionsAtEdges?: boolean;
}

const DEFAULT_OPTIONS: Required<TreatmentOptions> = {
  assFile: null,
  kineticAssFile: null,
  maxMotionIntensity: 0.85,
  avoidTransitionsAtEdges: true,
};

function buildScaleCropFilters(media: MediaInfo): string[] {
  return [
    `scale=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:force_original_aspect_ratio=increase`,
    `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}`,
    'setsar=1',
    `fps=${EXPORT_SPEC.fps}`,
  ];
}

function buildCaptionFilters(options: Required<TreatmentOptions>): string[] {
  const filters: string[] = [];
  if (options.assFile) {
    filters.push(`subtitles=filename='${options.assFile}'`);
  }
  return filters;
}

function buildKineticCaptionFilter(options: Required<TreatmentOptions>): string | null {
  if (!options.kineticAssFile) return null;
  return `ass=filename='${options.kineticAssFile}'`;
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
    const t = cue.t;
    const dur = cue.duration;

    switch (cue.kind) {
      case 'emphasis': {
        const intensity = clamp01(cue.intensity || 0.6);
        const zoom = 1 + intensity * 0.15;
        const scaledW = Math.round(media.width * zoom);
        const scaledH = Math.round(media.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${media.width}:${media.height}:(iw-${media.width})/2:(ih-${media.height})/2`
        );
        keyframes.push({ t, type: 'emphasis_zoom' });
        break;
      }

      case 'impact': {
        const alpha = clamp01((cue.intensity || 0.7) * 0.4);
        filters.push(
          `drawbox=x=0:y=0:w=iw:h=ih:color=white@${alpha.toFixed(2)}:t=fill:d=${dur.toFixed(1)}`
        );
        keyframes.push({ t, type: 'impact_flash' });
        break;
      }

      case 'punch_in': {
        const zoom = 1.5 + (cue.intensity || 0.7) * 1.5;
        const scaledW = Math.round(media.width * zoom);
        const scaledH = Math.round(media.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${media.width}:${media.height}:(iw-${media.width})/2:(ih-${media.height})/2`
        );
        keyframes.push({ t, type: 'punch_in' });
        break;
      }

      case 'transition': {
        const variant = cue.variant || 'flash';
        const alpha = clamp01((cue.intensity || 0.6) * 0.3);
        if (variant === 'flash') {
          filters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@${alpha.toFixed(2)}:t=fill:d=${dur.toFixed(1)}`);
        }
        keyframes.push({ t, type: `transition_${variant}` });
        break;
      }

      case 'settle': {
        const zoom = 1.05;
        const scaledW = Math.round(media.width * zoom);
        const scaledH = Math.round(media.height * zoom);
        filters.push(
          `scale=${scaledW}:${scaledH},` +
          `crop=${media.width}:${media.height}:(iw-${media.width})/2:(ih-${media.height})/2`
        );
        keyframes.push({ t, type: 'settle_zoom' });
        break;
      }
    }
  }

  return { filters, keyframes };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
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
      allFilters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@0.6:t=fill:d=${fadeDur}`);
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
      allFilters.push(`drawbox=x=0:y=0:w=iw:h=ih:color=white@0.6:t=fill:d=${fadeDur}`);
    } else if (seg.transitions.out === 'wipe') {
      allFilters.push(`fade=t=out:st=${segDur - fadeDur}:d=${fadeDur}:alpha=1`);
    } else {
      allFilters.push(`fade=t=out:st=${segDur - fadeDur}:d=${fadeDur}:alpha=1`);
    }
  }

  return { videoFilters: allFilters, keyframes: allKeyframes };
}

export function buildTreatment(
  decision: EditDecision,
  options: TreatmentOptions = {}
): TreatmentResult {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const warnings: string[] = [];

  const videoFilters: string[] = [];
  const audioFilters: string[] = [];
  const allKeyframes: Array<{ t: number; type: string }> = [];
  const allCues: MotionCue[] = [];

  const baseScaleCrop = buildScaleCropFilters(decision.media);

  const clipStart = decision.segments[0]?.start || 0;
  const isMultiSegment = decision.segments.length > 1;

  for (const seg of decision.segments) {
    const { videoFilters: segFilters, keyframes } = buildSegmentFilters(seg, decision, opts);
    allCues.push(...seg.cues);
    allKeyframes.push(...keyframes.map((k) => ({ t: k.t, type: k.type })));

    if (isMultiSegment) {
      const relStart = seg.start - clipStart;
      const relEnd = seg.end - clipStart;
      const trimFilter = `trim=start=${relStart}:end=${relEnd},setpts=PTS-STARTPTS`;
      const chain = [trimFilter, ...segFilters].join(',');
      videoFilters.push(`[0:v]${chain}[${seg.id}]`);
    } else {
      // Single segment: no labels, chain filters directly (uses -vf, not -filter_complex)
      videoFilters.push(...segFilters);
    }
  }

  if (isMultiSegment) {
    const concatInputs = decision.segments.map((s) => `[${s.id}]`).join('');
    videoFilters.push(`${concatInputs}concat=n=${decision.segments.length}:v=1:a=0[v]`);
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

  const baseCaptionFilters = buildCaptionFilters(opts);

  return {
    videoFilters,
    audioFilters,
    captionFilter,
    captionFilters: baseCaptionFilters,
    motionCues: allCues,
    keyframes: allKeyframes,
    warnings,
  };
}

export function buildRenderCommand(
  input: string,
  outFile: string,
  treatment: TreatmentResult,
  { start, duration }: { start: number; duration: number }
): string[] {
  const hasLabels = treatment.videoFilters.some((f) => f.includes('['));
  const allVideoFilters = [...treatment.videoFilters];
  const captionFilters = [...treatment.captionFilters, treatment.captionFilter].filter(Boolean) as string[];

  if (hasLabels) {
    // Complex filtergraph with intermediate labels — must use -filter_complex
    // and map the final output label. Caption filters append to the last chain.
    if (captionFilters.length > 0) {
      const lastIdx = allVideoFilters.length - 1;
      allVideoFilters[lastIdx] = `${allVideoFilters[lastIdx]},${captionFilters.join(',')}`;
    }
    // Add output label to the final chain so -map can reference it
    const lastIdx = allVideoFilters.length - 1;
    allVideoFilters[lastIdx] = `${allVideoFilters[lastIdx]}[outv]`;
    return [
      '-hide_banner', '-y',
      '-ss', String(start),
      '-t', String(duration),
      '-i', input,
      '-filter_complex', allVideoFilters.join(';'),
      '-map', '[outv]',
      '-map', '0:a:0?',
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
    ];
  }

  const args = [
    '-hide_banner', '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', input,
    '-vf', [...allVideoFilters, ...captionFilters].filter(Boolean).join(','),
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
