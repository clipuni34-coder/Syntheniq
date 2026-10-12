// Syntheniq — quality control and repair hooks for the render pipeline.
// Provides:
//   - VerifyExportOptions: configurable safety checks on rendered output
//   - repairExport: attempt to fix common render failures
//   - buildSafeRenderFilters: wraps filter chains with safety guards
//   - ExportVerification: comprehensive result type
import fs from 'node:fs';
import path from 'node:path';
import { ffprobe, run } from '../../lib/ffmpeg.js';
import { EXPORT_SPEC } from '../render/index.js';
import type { MotionCue, MediaInfo } from './motion.js';

export interface VerifyExportOptions {
  minDuration?: number;
  expectedSize?: number;
  tolerance?: number;
  checkFaststart?: boolean;
  requireAudio?: boolean;
}

export interface ExportVerification {
  ok: boolean;
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
  issues: string[];
}

export interface RepairAttempt {
  success: boolean;
  method?: string;
  output?: string;
  issues: string[];
}

const DEFAULTS: Required<VerifyExportOptions> = {
  minDuration: 0.5,
  expectedSize: 0,
  tolerance: 0.9,
  checkFaststart: true,
  requireAudio: true,
};

function hasFaststart(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const scanBytes = Math.min(stat.size, 128 * 1024 * 1024);
    const buf = Buffer.alloc(Math.min(scanBytes, 64 * 1024 * 1024));
    let moovAt = -1;
    let mdatAt = -1;
    let offset = 0;
    while (offset < scanBytes) {
      const toRead = Math.min(buf.length, scanBytes - offset);
      const n = fs.readSync(fd, buf, 0, toRead, offset);
      if (n < 8) break;
      let pos = 0;
      while (pos + 8 <= n) {
        let size: number = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        if (size === 1 && pos + 16 <= n) {
          size = Number(buf.readBigUInt64BE(pos + 8));
        }
        if (type === 'moov' && moovAt < 0) moovAt = offset + pos;
        if (type === 'mdat' && mdatAt < 0) mdatAt = offset + pos;
        if (moovAt >= 0 && mdatAt >= 0) return moovAt < mdatAt;
        if (!Number.isFinite(size) || size < 8) break;
        if (pos + size > n) {
          offset = offset + pos + size;
          pos = -1;
          break;
        }
        pos += size;
      }
      if (pos === -1) continue;
      break;
    }
    if (moovAt >= 0 && mdatAt < 0) return true;
    return moovAt >= 0 && mdatAt >= 0 && moovAt < mdatAt;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // ignore
    }
  }
}

function evalFps(value: string): number {
  const m = String(value).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return 0;
  const den = m[2] !== undefined ? parseFloat(m[2]) : 1;
  return den ? parseFloat(m[1]) / den : 0;
}

export async function verifyExport(
  file: string,
  options: VerifyExportOptions = {}
): Promise<ExportVerification> {
  const opts = { ...DEFAULTS, ...options };
  const issues: string[] = [];
  const details: Record<string, unknown> = {};

  if (!fs.existsSync(file)) {
    return {
      ok: false,
      checks: {},
      details: { error: 'File does not exist' },
      issues: ['Exported file does not exist'],
    };
  }

  const stat = fs.statSync(file);
  details.bytes = stat.size;
  details.path = file;

  let info: any;
  try {
    info = await ffprobe(file);
  } catch (err) {
    return {
      ok: false,
      checks: { fileReadable: false },
      details: { error: (err as Error).message },
      issues: [`Cannot probe file: ${(err as Error).message}`],
    };
  }

  const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = info.format || {};
  const duration = parseFloat(format.duration) || 0;
  const fps = video && video.avg_frame_rate ? evalFps(video.avg_frame_rate) : 0;

  details.duration = duration;
  details.fps = Math.round(fps * 100) / 100;
  details.width = video ? video.width : 0;
  details.height = video ? video.height : 0;
  details.videoCodec = video ? video.codec_name : null;
  details.audioCodec = audio ? audio.codec_name : null;
  details.pixFmt = video ? video.pix_fmt : null;

  const checks: Record<string, boolean> = {
    fileReadable: true,
    hasVideo: Boolean(video),
    videoCodec: video ? video.codec_name === EXPORT_SPEC.videoCodec : false,
    resolution: Boolean(video && video.width === EXPORT_SPEC.width && video.height === EXPORT_SPEC.height),
    fps: Math.abs(fps - EXPORT_SPEC.fps) < 1,
    pixFmt: video ? video.pix_fmt === EXPORT_SPEC.pixFmt : false,
    duration: duration >= opts.minDuration,
  };

  if (opts.checkFaststart) {
    checks.faststart = hasFaststart(file);
  }
  if (opts.requireAudio) {
    checks.hasAudio = Boolean(audio);
    if (audio) {
      checks.audioCodec = audio.codec_name === EXPORT_SPEC.audioCodec;
    }
  }

  if (opts.expectedSize > 0) {
    const minSize = Math.round(opts.expectedSize * opts.tolerance);
    checks.fileSize = stat.size >= minSize;
    details.fileSizeMin = minSize;
    if (stat.size < minSize) {
      issues.push(`File size ${stat.size} below ${minSize} (${Math.round(opts.tolerance * 100)}% of expected)`);
    }
  }

  if (!checks.hasVideo) issues.push('No video stream found');
  if (!checks.videoCodec) issues.push(`Video codec mismatch: expected ${EXPORT_SPEC.videoCodec}`);
  if (!checks.resolution) issues.push(`Resolution mismatch: expected ${EXPORT_SPEC.width}x${EXPORT_SPEC.height}`);
  if (!checks.fps) issues.push(`FPS mismatch: expected ${EXPORT_SPEC.fps}`);
  if (!checks.pixFmt) issues.push(`Pixel format mismatch: expected ${EXPORT_SPEC.pixFmt}`);
  if (!checks.duration) issues.push(`Duration ${duration}s below minimum ${opts.minDuration}s`);
  if (opts.checkFaststart && !checks.faststart) issues.push('Missing faststart (moov atom not at beginning)');
  if (opts.requireAudio && !checks.hasAudio) issues.push('Missing audio stream');
  if (opts.requireAudio && audio && !checks.audioCodec) issues.push(`Audio codec mismatch: expected ${EXPORT_SPEC.audioCodec}`);

  const ok = Object.values(checks).every(Boolean);
  return { ok, checks, details, issues };
}

export async function repairExport(
  badFile: string,
  input: string,
  start: number,
  duration: number,
  outFile: string,
  assFile?: string | null
): Promise<RepairAttempt> {
  const issues: string[] = [];

  if (fs.existsSync(badFile)) {
    const stat = fs.statSync(badFile);
    if (stat.size === 0) {
      issues.push('Original export was empty file');
    } else {
      issues.push(`Original export had issues, size=${stat.size}`);
    }
    try {
      fs.rmSync(badFile, { force: true });
    } catch {
      // ignore
    }
  }

  try {
    const filters = [
      `scale=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:force_original_aspect_ratio=increase`,
      `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}`,
      'setsar=1',
      `fps=${EXPORT_SPEC.fps}`,
    ];

    if (assFile && fs.existsSync(assFile)) {
      const { escapeFilterPath } = await import('../render/index.js');
      const { ROOT } = await import('../../config.js');
      const fontsDir = path.join(ROOT, 'assets', 'fonts');
      filters.push(`subtitles=filename='${escapeFilterPath(assFile)}':fontsdir='${escapeFilterPath(fontsDir)}'`);
    }

    filters.push('format=yuv420p');

    await run('ffmpeg', [
      '-hide_banner', '-y',
      '-ss', String(start),
      '-t', String(duration),
      '-i', input,
      '-vf', filters.join(','),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-preset', 'slow',
      '-crf', '18',
      '-r', String(EXPORT_SPEC.fps),
      '-pix_fmt', EXPORT_SPEC.pixFmt,
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ar', '48000',
      '-ac', '2',
      '-movflags', '+faststart',
      '-shortest',
      outFile,
    ]);

    const stat = fs.statSync(outFile);
    if (!stat.size) {
      return { success: false, issues: [...issues, 'Repair produced empty file'], method: 're-encode-slow' };
    }

    const verification = await verifyExport(outFile);
    if (!verification.ok) {
      return { success: false, issues: [...issues, ...verification.issues], method: 're-encode-slow' };
    }

    return { success: true, issues, method: 're-encode-slow', output: outFile };
  } catch (err) {
    return { success: false, issues: [...issues, (err as Error).message], method: 're-encode-slow' };
  }
}

export interface SafeFilterOptions {
  maxTotalDuration?: number;
  maxFilterLength?: number;
  warnOnLargeInput?: boolean;
}

const DEFAULT_FILTER_OPTIONS: Required<SafeFilterOptions> = {
  maxTotalDuration: 120,
  maxFilterLength: 32768,
  warnOnLargeInput: true,
};

export function validateMotionCues(cues: MotionCue[], duration: number, media: MediaInfo): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  let totalDuration = 0;

  for (const cue of cues) {
    if (cue.t < 0 || cue.t > duration) {
      warnings.push(`Cue at ${cue.t}s is outside clip bounds [0, ${duration}]`);
    }
    totalDuration += cue.duration;
    if (cue.duration > 10) {
      warnings.push(`Cue "${cue.label}" has very long duration (${cue.duration}s)`);
    }
    if (cue.kind === 'impact' && (cue.intensity || 0.5) > 0.9) {
      warnings.push(`High-intensity impact cue at ${cue.t}s may be visually jarring`);
    }
  }

  if (totalDuration > DEFAULT_FILTER_OPTIONS.maxTotalDuration) {
    warnings.push(`Total motion cue duration (${totalDuration}s) exceeds recommended max (${DEFAULT_FILTER_OPTIONS.maxTotalDuration}s)`);
  }

  const density = cues.length / Math.max(0.1, duration);
  if (density > 0.5) {
    warnings.push(`High cue density (${cues.length} cues in ${duration}s) — may cause visual overload`);
  }

  return { valid: warnings.length < 3, warnings };
}

export function buildSafeRenderFilters(
  baseFilters: string[],
  cues: MotionCue[],
  media: MediaInfo,
  duration: number,
  options: SafeFilterOptions = {}
): { filters: string[]; warnings: string[] } {
  const opts = { ...DEFAULT_FILTER_OPTIONS, ...options };
  const warnings: string[] = [];
  const allFilters: string[] = [];

  for (const f of baseFilters) {
    if (f.length > opts.maxFilterLength) {
      warnings.push(`Filter exceeds max length (${f.length} > ${opts.maxFilterLength})`);
    }
    allFilters.push(f);
  }

  const validation = validateMotionCues(cues, duration, media);
  for (const w of validation.warnings) {
    warnings.push(w);
  }

  return { filters: allFilters, warnings };
}
