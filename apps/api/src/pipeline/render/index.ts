// Syntheniq — vertical render + export verification.
// Delivery spec: 1080×1920 · 30fps · H.264 High · yuv420p · AAC 128k · faststart.
import fs from 'node:fs';
import path from 'node:path';
import { run, ffprobe } from '../../lib/ffmpeg.js';
import { ROOT } from '../../config.js';

export const EXPORT_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixFmt: 'yuv420p',
};

export function escapeFilterPath(p: string): string {
  return String(p).replace(/\\/g, '\\\\').replace(/'/g, "'\\''").replace(/:/g, '\\:');
}

function fontsDir(): string {
  return path.join(ROOT, 'assets', 'fonts');
}

export interface RenderInput {
  input: string;
  start: number;
  duration: number;
  assFile?: string | null;
  outFile: string;
  onProgress?: ((frac: number) => void) | null;
}

export async function renderClip({ input, start, duration, assFile = null, outFile, onProgress = null }: RenderInput): Promise<{ outFile: string; bytes: number }> {
  if (!fs.existsSync(input)) throw new Error(`Source video not found: ${input}`);
  const filters = [
    `scale=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}:force_original_aspect_ratio=increase`,
    `crop=${EXPORT_SPEC.width}:${EXPORT_SPEC.height}`,
    'setsar=1',
    `fps=${EXPORT_SPEC.fps}`,
    'format=yuv420p',
  ];
  if (assFile) {
    filters.push(`subtitles=filename='${escapeFilterPath(assFile)}':fontsdir='${escapeFilterPath(fontsDir())}'`);
  }
  const args = [
    '-hide_banner', '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', input,
    '-vf', filters.join(','),
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-preset', 'veryfast',
    '-crf', '20',
    '-r', String(EXPORT_SPEC.fps),
    '-pix_fmt', EXPORT_SPEC.pixFmt,
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-movflags', '+faststart',
    '-shortest',
    '-progress', 'pipe:1',
    '-nostats',
    outFile,
  ];

  const total = Math.max(0.1, duration);
  await run('ffmpeg', args, {
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

  const stat = fs.statSync(outFile);
  if (!stat.size) throw new Error('Render produced an empty file');
  return { outFile, bytes: stat.size };
}

export interface Verification {
  ok: boolean;
  checks: Record<string, boolean>;
  details: Record<string, unknown>;
}

export async function verifyExport(file: string): Promise<Verification> {
  const info = await ffprobe(file);
  const streams: any[] = Array.isArray(info.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const fps = video && video.avg_frame_rate ? evalFps(video.avg_frame_rate) : 0;
  const checks: Record<string, boolean> = {
    hasVideo: Boolean(video),
    videoCodec: video ? video.codec_name === EXPORT_SPEC.videoCodec : false,
    resolution: Boolean(video && video.width === EXPORT_SPEC.width && video.height === EXPORT_SPEC.height),
    fps: Math.abs(fps - EXPORT_SPEC.fps) < 1,
    pixFmt: video ? video.pix_fmt === EXPORT_SPEC.pixFmt : false,
    audioCodec: audio ? audio.codec_name === EXPORT_SPEC.audioCodec : true,
    faststart: hasFaststart(file),
  };
  const ok = Object.values(checks).every(Boolean);
  return {
    ok,
    checks,
    details: {
      width: video ? video.width : 0,
      height: video ? video.height : 0,
      fps: Math.round(fps * 100) / 100,
      videoCodec: video ? video.codec_name : null,
      audioCodec: audio ? audio.codec_name : null,
      pixFmt: video ? video.pix_fmt : null,
      duration: parseFloat((info.format && info.format.duration) || '0') || 0,
    },
  };
}

function evalFps(value: string): number {
  const m = String(value).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return 0;
  const den = m[2] !== undefined ? parseFloat(m[2]) : 1;
  return den ? parseFloat(m[1]) / den : 0;
}

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

export async function extractPoster(
  input: string,
  time: number,
  outFile: string,
  { w = 540, h = 960 }: { w?: number; h?: number } = {}
): Promise<string> {
  await run('ffmpeg', [
    '-hide_banner', '-y',
    '-ss', String(Math.max(0, time)),
    '-i', input,
    '-frames:v', '1',
    '-vf', `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`,
    '-q:v', '4',
    outFile,
  ]);
  return outFile;
}
