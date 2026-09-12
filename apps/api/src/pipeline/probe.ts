// Syntheniq — media probing. The video file is the source of truth for
// duration, dimensions and streams.
import { ffprobe } from '../lib/ffmpeg.js';
import type { ProbeResult } from '../types.js';

export function parseFps(value: unknown): number {
  if (!value) return 0;
  if (typeof value === 'number') return value;
  const m = String(value).match(/^(\d+(?:\.\d+)?)(?:\/(\d+(?:\.\d+)?))?$/);
  if (!m) return 0;
  const num = parseFloat(m[1]);
  const den = m[2] !== undefined ? parseFloat(m[2]) : 1;
  if (!den) return 0;
  return num / den;
}

export async function probeMedia(file: string): Promise<ProbeResult> {
  const data = await ffprobe(file);
  const streams: any[] = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = data.format || {};

  const candidates = [parseFloat(format.duration)];
  for (const s of streams) {
    if (s.duration) candidates.push(parseFloat(s.duration));
  }
  const duration = Math.max(0, ...candidates.filter((v) => Number.isFinite(v)));

  return {
    duration,
    sizeBytes: parseInt(format.size || '0', 10) || 0,
    bitrate: parseInt(format.bit_rate || '0', 10) || 0,
    formatName: format.format_name || '',
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video ? video.width || 0 : 0,
    height: video ? video.height || 0 : 0,
    fps: video ? parseFps(video.avg_frame_rate || video.r_frame_rate) : 0,
    videoCodec: video ? video.codec_name || '' : '',
    audioCodec: audio ? audio.codec_name || '' : '',
    pixFmt: video ? video.pix_fmt || '' : '',
  };
}
