import path from 'node:path';
import fs from 'node:fs';
import { run } from '../../lib/ffmpeg.js';
import { probeMedia } from '../probe.js';
import type { FaceTrack, BRollCue } from '../../types.js';
import { ensureDir, sourceDir } from '../../lib/paths.js';
import { EXPORT_SPEC } from './index.js';
import { randomUUID } from 'node:crypto';

export interface FaceDetectionResult {
  faceTrack: FaceTrack[];
  faceCount: number;
  hasFace: boolean;
}

const FACE_DETECT_SCRIPT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  'face_detect.py'
);

function getFrameDir(projectId: string): string {
  return ensureDir(path.join(sourceDir(projectId), 'frames'));
}

export async function detectFaces(
  videoPath: string,
  projectId: string,
  filename: string,
  onProgress: (frac: number, msg: string) => void = () => undefined
): Promise<FaceDetectionResult> {
  const frameDir = getFrameDir(projectId);
  const framePattern = path.join(frameDir, 'frame-%03d.jpg');

  try {
    onProgress(0.2, 'Extracting frames for face detection');
    await run('ffmpeg', [
      '-hide_banner', '-y',
      '-i', videoPath,
      '-vf', 'fps=1,scale=320:-1',
      '-q:v', '2',
      framePattern,
    ]);
  } catch {
    return { faceTrack: [], faceCount: 0, hasFace: false };
  }

  const frames = fs.readdirSync(frameDir).filter((f) => f.endsWith('.jpg')).sort();
  if (frames.length === 0) {
    return { faceTrack: [], faceCount: 0, hasFace: false };
  }

  // Frames are extracted with `scale=320:-1` (aspect ratio preserved) for speed.
  // Rescale detected coordinates back to the source video's native resolution so
  // the renderer can map them to the export spec via decision.media dimensions.
  let rescale = 1;
  try {
    const probe = await probeMedia(videoPath);
    if (probe.width && probe.width > 0) rescale = probe.width / 320;
  } catch {
    // fall back to 1:1 if probing the source fails
  }

  const faceTrack: FaceTrack[] = [];
  let totalFaces = 0;
  let frameWithFaces = 0;

  onProgress(0.4, `Analyzing ${frames.length} frames for faces`);

  for (let i = 0; i < frames.length; i++) {
    const frame = path.join(frameDir, frames[i]);
    try {
      const result = await run('python3', [FACE_DETECT_SCRIPT, frame, '--min_confidence', '0.2']);
      const data = JSON.parse(result.stdout.trim() || '{"faces":[]}');
      const faces = data.faces || [];

      if (faces.length > 0) {
        totalFaces += faces.length;
        frameWithFaces++;
        for (const face of faces) {
          faceTrack.push({
            start: i,
            end: i + 1,
            x: Math.round(face.x * rescale),
            y: Math.round(face.y * rescale),
            width: Math.round(face.width * rescale),
            height: Math.round(face.height * rescale),
            confidence: face.confidence,
          });
        }
      }
    } catch {
      // Continue on error for this frame
    }

    onProgress(0.4 + (i / frames.length) * 0.5, `Frame ${i + 1}/${frames.length}`);
  }

  const hasFace = faceTrack.length > 0;
  const result: FaceDetectionResult = {
    faceTrack,
    faceCount: totalFaces,
    hasFace,
  };

  onProgress(1, `Face detection complete: ${faceTrack.length} faces in ${frameWithFaces} frames`);

  return result;
}

// --- Visual Effects ---

export interface VisualEffectOptions {
  faceHighlight?: number;
  faceHighlightColor?: string;
  backgroundBlur?: number;
  smartCrop?: boolean;
  stabilize?: boolean;
}

export interface EffectResult {
  filters: string[];
  keyframes: Array<{ t: number; type: string }>;
}

export function buildFaceHighlightFilters(
  faces: FaceTrack[],
  opts: VisualEffectOptions,
  width: number,
  height: number
): EffectResult {
  if (faces.length === 0) return { filters: [], keyframes: [] };

  const color = opts.faceHighlightColor || '#00FF00@0.2';
  const filters: string[] = [];
  const keyframes: Array<{ t: number; type: string }> = [];

  // Face coords from detectFaces are already in the source video's native
  // resolution (rescaled from the 320px detection frame). Scale media-native
  // -> export resolution. (Previously this re-scaled from the 320px detection
  // frame a second time, pushing face boxes off-canvas.)
  const scaleX = EXPORT_SPEC.width / width;
  const scaleY = EXPORT_SPEC.height / height;
  // Merge consecutive faces with similar coordinates to avoid excessive drawbox filters
  const merged: FaceTrack[] = [];
  for (const face of faces) {
    const last = merged[merged.length - 1];
    if (last &&
        Math.abs(face.x - last.x) < 10 &&
        Math.abs(face.y - last.y) < 10 &&
        Math.abs(face.width - last.width) < 10 &&
        Math.abs(face.height - last.height) < 10 &&
        face.start === last.end) {
      last.end = face.end;
      last.confidence = Math.max(last.confidence, face.confidence);
    } else {
      merged.push({ ...face });
    }
  }

  for (const face of merged) {
    const x = Math.round(face.x * scaleX);
    const y = Math.round(face.y * scaleY);
    const w = Math.max(1, Math.round(face.width * scaleX));
    const h = Math.max(1, Math.round(face.height * scaleY));

    filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='between(t,${face.start},${face.end})'`);
    keyframes.push({ t: face.start, type: 'face_highlight' });
  }

  return { filters, keyframes };
}

export function buildBackgroundBlurFilters(
  faces: FaceTrack[],
  opts: VisualEffectOptions,
  width: number,
  height: number
): EffectResult {
  if (!opts.backgroundBlur || opts.backgroundBlur <= 0 || faces.length === 0) {
    return { filters: [], keyframes: [] };
  }

  const blurRadius = opts.backgroundBlur;
  const firstFace = faces[0];
  // Face coords from detectFaces are in source-native resolution; scale to export.
  const scaleX = EXPORT_SPEC.width / width;
  const scaleY = EXPORT_SPEC.height / height;
  const x = Math.round(firstFace.x * scaleX);
  const y = Math.round(firstFace.y * scaleY);
  const w = Math.max(1, Math.round(firstFace.width * scaleX));
  const h = Math.max(1, Math.round(firstFace.height * scaleY));

  return {
    filters: [
      `gblur=sigma=${blurRadius}:steps=3`,
    ],
    keyframes: [],
  };
}

export function buildSmartCropFilters(
  faces: FaceTrack[],
  width: number,
  height: number
): EffectResult {
  if (faces.length === 0) return { filters: [], keyframes: [] };

  // Only apply smart crop if the video isn't already 9:16 portrait.
  // If the video matches the export aspect ratio, cropping just zooms in unnecessarily.
  const exportAspect = EXPORT_SPEC.width / EXPORT_SPEC.height;
  const mediaAspect = width / height;
  if (Math.abs(exportAspect - mediaAspect) < 0.1) {
    return { filters: [], keyframes: [] };
  }

  const firstFace = faces[0];
  // Face coords from detectFaces are in source-native resolution; scale to export.
  const exportScaleX = EXPORT_SPEC.width / width;
  const exportScaleY = EXPORT_SPEC.height / height;

  const centerX = (firstFace.x + firstFace.width / 2) * exportScaleX;
  const centerY = (firstFace.y + firstFace.height / 2) * exportScaleY;

  // Clamp to valid range
  const cropW = EXPORT_SPEC.width;
  const cropH = EXPORT_SPEC.height;
  const x = Math.max(0, Math.round(centerX - cropW / 2));
  const y = Math.max(0, Math.round(centerY - cropH / 2));

  return {
    filters: [`crop=${cropW}:${cropH}:x=${x}:y=${y}`],
    keyframes: [{ t: 0, type: 'smart_crop_center' }],
  };
}

export async function applyVisualEffects(
  faces: FaceTrack[],
  opts: VisualEffectOptions,
  width: number,
  height: number
): Promise<EffectResult> {
  const result: EffectResult = { filters: [], keyframes: [] };

   if (faces.length > 0) {
    if (opts.backgroundBlur && opts.backgroundBlur > 0) {
      const bb = buildBackgroundBlurFilters(faces, opts, width, height);
      result.filters.push(...bb.filters);
      result.keyframes.push(...bb.keyframes);
    }

    if (opts.smartCrop !== false) {
      const sc = buildSmartCropFilters(faces, width, height);
      result.filters.push(...sc.filters);
      result.keyframes.push(...sc.keyframes);
    }

    if (opts.faceHighlight) {
      const hl = buildFaceHighlightFilters(faces, opts, width, height);
      result.filters.push(...hl.filters);
      result.keyframes.push(...hl.keyframes);
    }
  }

  return result;
}

// --- B-roll compositing ---

/** Result of building the B-roll overlay subgraph. */
export interface BRollFilterResult {
  /**
   * Filter-complex chains that consume `baseLabel` and end at `[outv]`.
   * Append these to the existing filter_complex graph (after the base chain,
   * which must already emit `baseLabel`).
   */
  chains: string[];
  /** B-roll source file paths to append as additional `-i` inputs (ordered). */
  inputs: string[];
  /** Number of b-roll input files (= inputs.length). */
  inputCount: number;
  /** Human-readable notes for logging / warnings. */
  notes: string[];
}

function brNum(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Build the ffmpeg filter_complex overlay subgraph for a set of B-roll cues.
 *
 * Patterns follow the ffmpeg overlay cookbook: one labeled input per cue,
 * prepped with `trim` + `setpts=PTS-STARTPTS` + Ken Burns `scale`/`crop` + an
 * alpha `fade`, then composed with `overlay` gated by `enable='between(t,..)'`
 * and `eof_action=repeat` (a short clip freezes instead of dropping the window).
 * Cues layer by ascending `layer` then `outStart`. B-roll is silent — base
 * audio is left untouched.
 */
export function buildBRollFilters(
  cues: BRollCue[],
  opts: {
    /** Label the already-treated main video ends with (e.g. '[base]'). */
    baseLabel: string;
    /** First input index to reserve for b-roll (after main + SFX inputs). */
    startInputIndex: number;
    /** Export frame (used for sizing/positioning). */
    exportWidth: number;
    exportHeight: number;
    /** Export fps (b-roll is fps-locked to this). */
    fps?: number;
  },
): BRollFilterResult {
  const result: BRollFilterResult = { chains: [], inputs: [], inputCount: 0, notes: [] };
  const W = opts.exportWidth || EXPORT_SPEC.width;
  const H = opts.exportHeight || EXPORT_SPEC.height;
  const fps = opts.fps || EXPORT_SPEC.fps;
  const base = opts.baseLabel || '[base]';

  if (!Array.isArray(cues) || cues.length === 0) return result;

  const valid = cues.filter(
    (c) => c && c.outDuration > 0 && c.clipEnd > c.clipStart && typeof c.source === 'string' && c.source.length > 0
  );
  if (valid.length !== cues.length) {
    result.notes.push(`Skipped ${cues.length - valid.length} invalid b-roll cue(s)`);
  }

  // Layer low->high, then by outStart so equal layers stack in timeline order.
  const ordered = [...valid].sort(
    (a, b) => (a.layer ?? 0) - (b.layer ?? 0) || a.outStart - b.outStart
  );

  let curLabel = base;
  for (let i = 0; i < ordered.length; i++) {
    const c = ordered[i];
    const inputIndex = opts.startInputIndex + i;
    result.inputs.push(c.source);

    const isFull = !(c.size && c.size.width > 0 && c.size.height > 0);
    const ow = isFull ? W : Math.max(2, Math.round((c.size as NonNullable<typeof c.size>).width * W));
    const oh = isFull ? H : Math.max(2, Math.round((c.size as NonNullable<typeof c.size>).height * H));
    // guard against zero-dimension crops
    if (ow < 2 || oh < 2) {
      result.notes.push(`Skipped cue ${c.id}: overlay size ${ow}x${oh} too small`);
      continue;
    }

    // Ken Burns: overscan the source (zoomEnd) then crop the target window.
    const zStart = Math.max(0.01, Math.min(8, brNum(c.kenBurns?.zoomStart, 1.15)));
    const zEnd = Math.max(zStart, Math.min(8, brNum(c.kenBurns?.zoomEnd, 1.4)));
    const sw = Math.max(ow, Math.ceil(ow * zEnd));
    const sh = Math.max(oh, Math.ceil(oh * zEnd));

    const clipDur = Math.max(0.001, c.clipEnd - c.clipStart);

    // Crop-window top-left in the *oversized* frame. With pan, animate from
    // panStart->panEnd (normalized 0..1 over the sw-ow / sh-oh travel range).
    const px0 = c.panStart ? c.panStart.x * (sw - ow) : (sw - ow) / 2;
    const py0 = c.panStart ? c.panStart.y * (sh - oh) : (sh - oh) / 2;
    const px1 = c.panEnd ? c.panEnd.x * (sw - ow) : px0;
    const py1 = c.panEnd ? c.panEnd.y * (sh - oh) : py0;
    const maxX = Math.max(0, sw - ow);
    const maxY = Math.max(0, sh - oh);
    const cx = panExpr(px0, px1, maxX, clipDur);
    const cy = panExpr(py0, py1, maxY, clipDur);

    const prepLab = `[br${i}_src]`;
    const scaleFilter =
      `scale=${sw}:${sh}:force_original_aspect_ratio=decrease,` +
      `pad=${sw}:${sh}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
      `crop=${ow}:${oh}:${cx}:${cy}`;

    // Alpha chain: optional opacity then in/out fades (alpha).
    const alphaParts: string[] = [];
    if (typeof c.opacity === 'number' && c.opacity < 1) {
      alphaParts.push(`eq=alpha=${Math.max(0, Math.min(1, c.opacity))}`);
    }
    if (c.fade && c.fade.in > 0) {
      alphaParts.push(`fade=t=in:st=0:d=${Math.max(0, c.fade.in)}:alpha=1`);
    }
    if (c.fade && c.fade.out > 0) {
      const outStart = Math.max(0, clipDur - Math.max(0, c.fade.out));
      alphaParts.push(`fade=t=out:st=${outStart}:d=${Math.max(0, c.fade.out)}:alpha=1`);
    }
    const alphaChain = alphaParts.length ? `,${alphaParts.join(',')}` : '';

    const prep =
      `[${inputIndex}:v]trim=${c.clipStart}:${c.clipEnd},setpts=PTS-STARTPTS,` +
      `${scaleFilter},fps=${fps},setsar=1,format=rgba${alphaChain}${prepLab}`;
    result.chains.push(prep);

    const isLast = i === ordered.length - 1;
    const outLab = isLast ? '[outv]' : `[br${i}_ov]`;
    // Final overlay gets a fresh pixel format; intermediates pass through.
    const tail = isLast ? ',setsar=1,format=yuv420p' : '';
    const pos = brPosition(c, ow, oh, W, H);
    const es = c.outStart;
    const ee = c.outStart + c.outDuration;
    const ov =
      `${curLabel}${prepLab}overlay=${pos.x}:${pos.y}` +
      `:enable='between(t,${es.toFixed(3)},${ee.toFixed(3)})'` +
      `:eof_action=repeat${tail}[${isLast ? 'outv' : `br${i}_ov`}]`;
    result.chains.push(ov);
    curLabel = `[${isLast ? 'outv' : `br${i}_ov`}]`;

    result.notes.push(`cue ${c.id}: overlay ${ow}x${oh} at (${pos.x},${pos.y}) [${es.toFixed(2)}→${ee.toFixed(2)}s]`);
  }

  result.inputCount = result.inputs.length;
  return result;
}

/** Linear-interpolated, clamped crop-window expression for Ken Burns pan. */
function panExpr(start: number, end: number, max: number, dur: number): string {
  const s = Math.max(0, start);
  const e = Math.max(0, end);
  if (Math.abs(e - s) < 1e-6) return String(s);
  const d = Math.max(0.001, dur);
  return `clamp(${s}+(${e}-${s})*(t/${d}),0,${max})`;
}

/** Resolve an overlay's (x,y) top-left in export pixels. */
function brPosition(
  c: BRollCue,
  ow: number,
  oh: number,
  W: number,
  H: number
): { x: number; y: number } {
  const px = typeof c.position?.x === 'number' ? c.position.x : 0.5;
  const py = typeof c.position?.y === 'number' ? c.position.y : 0.5;
  const x = Math.max(0, Math.round(px * (W - ow)));
  const y = Math.max(0, Math.round(py * (H - oh)));
  return { x, y };
}
