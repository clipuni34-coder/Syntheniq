import path from 'node:path';
import fs from 'node:fs';
import { run } from '../../lib/ffmpeg.js';
import { probeMedia } from '../probe.js';
import type { FaceTrack } from '../../types.js';
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

  // Face tracking data is used for attention mapping and smart framing, but
  // drawing visible boxes on the final video is distracting. Use a nearly
  // transparent color so faces are tracked but not visible to the viewer.
  const color = opts.faceHighlightColor || '#FFFFFFFF@0.02';
  const filters: string[] = [];
  const keyframes: Array<{ t: number; type: string }> = [];

  // Scale face coordinates from detection frame (320px width) to export resolution
  const DETECTION_WIDTH = 320;
  const DETECTION_HEIGHT = Math.round(DETECTION_WIDTH * height / width);
  const scaleX = EXPORT_SPEC.width / DETECTION_WIDTH;
  const scaleY = EXPORT_SPEC.height / DETECTION_HEIGHT;

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
  // Scale coordinates from detection frame (320px width) to export resolution
  const DETECTION_WIDTH = 320;
  const DETECTION_HEIGHT = Math.round(DETECTION_WIDTH * height / width);
  const scaleX = EXPORT_SPEC.width / DETECTION_WIDTH;
  const scaleY = EXPORT_SPEC.height / DETECTION_HEIGHT;
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
  // Scale face coordinates from detection frame (320px width) to export resolution
  const DETECTION_WIDTH = 320;
  const DETECTION_HEIGHT = Math.round(DETECTION_WIDTH * height / width);
  const exportScaleX = EXPORT_SPEC.width / DETECTION_WIDTH;
  const exportScaleY = EXPORT_SPEC.height / DETECTION_HEIGHT;

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
