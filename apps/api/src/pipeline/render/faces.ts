import path from 'node:path';
import fs from 'node:fs';
import { run } from '../../lib/ffmpeg.js';
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
            x: face.x,
            y: face.y,
            width: face.width,
            height: face.height,
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

  const color = opts.faceHighlightColor || '#00FF00@0.5';
  const filters: string[] = [];
  const keyframes: Array<{ t: number; type: string }> = [];

  // Scale face coordinates from detection resolution to export resolution
  const scaleX = EXPORT_SPEC.width / width;
  const scaleY = EXPORT_SPEC.height / height;

  for (const face of faces.slice(0, 3)) {
    const x = Math.round(face.x * scaleX);
    const y = Math.round(face.y * scaleY);
    const w = Math.max(1, Math.round(face.width * scaleX));
    const h = Math.max(1, Math.round(face.height * scaleY));

    filters.push(`drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill:enable='between(t,0,3)'`);
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
  // Scale coordinates to export resolution
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

  const firstFace = faces[0];
  // Scale face coordinates from detection resolution to export resolution
  const scaleX = EXPORT_SPEC.width / width;
  const scaleY = EXPORT_SPEC.height / height;

  const centerX = (firstFace.x + firstFace.width / 2) * scaleX;
  const centerY = (firstFace.y + firstFace.height / 2) * scaleY;

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
