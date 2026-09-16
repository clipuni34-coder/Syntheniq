import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { MediaInfo, MediaSignals } from './types.js';

const pexecFile = promisify(execFile);

export async function ffprobe(file: string): Promise<MediaInfo> {
  const { stdout } = await pexecFile('ffprobe', [
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_streams',
    '-show_format',
    file,
  ]);
  const d = JSON.parse(stdout);
  const v = (d.streams || []).find((s: any) => s.codec_type === 'video');
  const a = (d.streams || []).find((s: any) => s.codec_type === 'audio');
  if (!v) throw new Error('no video stream found in source file');
  const num = parseInt(v.r_frame_rate?.split('/')[0] ?? '30', 10);
  const den = parseInt(v.r_frame_rate?.split('/')[1] ?? '1', 10) || 1;
  const fpsRaw = num / den;
  const fps = fpsRaw >= 50 ? 60 : 30;
  return {
    path: file,
    duration: parseFloat(d.format?.duration ?? v.duration ?? '0') || 0,
    fps,
    width: v.width,
    height: v.height,
    hasAudio: Boolean(a),
    codec: v.codec_name,
  };
}

/** Cut one kept segment, reframed to 1080×1920, silent (audio mixed separately). */
export async function cutSegment(
  src: string,
  out: string,
  start: number,
  dur: number,
  media: MediaInfo,
  opts: { cropBiasX?: number } = {},
): Promise<void> {
  const bias = opts.cropBiasX ?? 0.5;
  const srcW = media.width;
  const srcH = media.height;
  // 9:16 crop box in source pixels
  let cw: number, ch: number;
  if (srcW / srcH > 9 / 16) {
    ch = srcH;
    cw = Math.round((srcH * 9) / 16);
  } else {
    cw = srcW;
    ch = Math.round((srcW * 16) / 9);
  }
  cw = Math.min(cw, srcW);
  ch = Math.min(ch, srcH);
  const x = Math.round(((srcW - cw) * bias) / 2) | 0;
  const y = Math.round((srcH - ch) / 2) | 0;
  const vf = [
    `crop=${cw}:${ch}:${x}:${y}`,
    'scale=1080:1920:flags=lanczos',
    'setsar=1',
    `fps=${media.fps}`,
    'format=yuv420p',
  ].join(',');

  await pexecFile(
    'ffmpeg',
    [
      '-y', '-v', 'error',
      '-ss', start.toFixed(3),
      '-i', src,
      '-t', dur.toFixed(3),
      '-vf', vf,
      '-an',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '18',
      '-movflags', '+faststart',
      out,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

export async function extractAudioWav16k(src: string, out: string): Promise<void> {
  await pexecFile(
    'ffmpeg',
    ['-y', '-v', 'error', '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', out],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

export async function cutAudioWav(src: string, out: string, start: number, dur: number): Promise<void> {
  await pexecFile(
    'ffmpeg',
    ['-y', '-v', 'error', '-ss', start.toFixed(3), '-i', src, '-t', dur.toFixed(3), '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', out],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

/** Detect silence gaps (no speech) via silencedetect. */
export async function detectSilences(wav: string, duration: number, thresholdDb = -34, minDur = 0.35): Promise<{ start: number; end: number }[]> {
  const { stderr } = await pexecFile(
    'ffmpeg',
    ['-i', wav, '-af', `silencedetect=noise=${thresholdDb}dB:d=${minDur}`, '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const out: { start: number; end: number }[] = [];
  const re = /silence_start:\s*([\d.]+).*?silence_end:\s*([\d.]+)/gs;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr))) out.push({ start: parseFloat(m[1]), end: parseFloat(m[2]) });
  // Unmatched trailing silence
  const tail = stderr.match(/silence_start:\s*([\d.]+)(?![\s\S]*silence_end)/);
  if (tail) out.push({ start: parseFloat(tail[1]), end: duration });
  return out.filter((s) => s.end > s.start);
}

/** ~1 s RMS energy buckets (0..1 normalized by global max). */
export async function energyBuckets(wav: string, duration: number): Promise<{ t: number; rms: number }[]> {
  const { stdout } = await pexecFile(
    'ffmpeg',
    ['-i', wav, '-af', 'astats=metadata=1:reset=44100,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  // astats metadata prints the pts_time on the frame line and each stat on
  // its own following line — associate by tracking the last seen frame time.
  const buckets = new Map<number, number[]>();
  let lastT = -1;
  for (const line of stdout.split('\n')) {
    const tm = line.match(/pts_time:([\d.]+)/);
    if (tm) {
      lastT = parseInt(tm[1], 10);
      if (!buckets.has(lastT)) buckets.set(lastT, []);
      continue;
    }
    const vm = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?[\d.]+)/);
    if (vm && lastT >= 0) {
      const v = parseFloat(vm[1]);
      buckets.get(lastT)!.push(isFinite(v) ? Math.pow(10, v / 20) : 0);
    }
  }
  const arr = [...buckets.entries()]
    .filter(([t]) => t < duration + 1)
    .map(([t, vs]) => ({ t, rms: vs.reduce((a, b) => a + b, 0) / vs.length }));
  const max = Math.max(0.01, ...arr.map((a) => a.rms));
  return arr.map((a) => ({ t: a.t, rms: Math.min(1, a.rms / max) }));
}

export async function mediaSignals(wav: string, duration: number): Promise<MediaSignals> {
  const [silences, energy] = await Promise.all([detectSilences(wav, duration), energyBuckets(wav, duration)]);
  return { silences, energy };
}

/** Grab one frame as PNG (for multimodal video-understanding). */
export async function framePng(src: string, t: number, out: string, size = 480): Promise<void> {
  await pexecFile(
    'ffmpeg',
    ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', `scale=${size}:-2`, out],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

/** Thumbnail: 1080×1920 frame + bold drawtext title. */
export async function makeThumbnail(
  src: string,
  t: number,
  text: string,
  out: string,
  media: MediaInfo,
  fontfile: string,
): Promise<void> {
  const tmpText = path.join(path.dirname(out), '.thumb_text.txt');
  await writeFile(tmpText, text.replace(/\\n/g, '\n'));
  const srcW = media.width;
  const srcH = media.height;
  let cw: number, ch: number;
  if (srcW / srcH > 9 / 16) {
    ch = srcH;
    cw = Math.round((srcH * 9) / 16);
  } else {
    cw = srcW;
    ch = Math.round((srcW * 16) / 9);
  }
  const x = Math.round((srcW - cw) / 2);
  const vf = [
    `crop=${Math.min(cw, srcW)}:${Math.min(ch, srcH)}:${x}:${Math.round((srcH - ch) / 2)}`,
    'scale=1080:1920:flags=lanczos',
    'eq=brightness=-0.03',
    `drawtext=fontfile=${fontfile}:textfile=${tmpText}:fontcolor=white:fontsize=92:borderw=8:bordercolor=black@0.85:line_spacing=16:x=(w-text_w)/2:y=h*0.40:box=0`,
  ].join(',');
  await pexecFile(
    'ffmpeg',
    ['-y', '-v', 'error', '-ss', t.toFixed(3), '-i', src, '-frames:v', '1', '-vf', vf, '-q:v', '2', out],
    { maxBuffer: 8 * 1024 * 1024 },
  );
}

/**
 * Final audio mix:
 *   voice (concatenated kept segments)
 *   + music bed (sidechain-ducked under the voice)
 *   + SFX cues at composition-time offsets
 * → mixed.m4a
 */
export async function mixAudio(
  parts: { file: string; dur: number }[],
  totalDur: number,
  musicFile: string | null,
  sfx: { file: string; at: number; vol: number }[],
  out: string,
): Promise<void> {
  const args: string[] = ['-y', '-v', 'error'];
  for (const p of parts) args.push('-i', p.file);
  const musicIdx = musicFile ? parts.length : -1;
  if (musicFile) args.push('-i', musicFile);
  const sfxIdxs: number[] = [];
  for (const s of sfx) {
    args.push('-i', s.file);
    sfxIdxs.push(parts.length + (musicFile ? 1 : 0) + sfxIdxs.length);
  }

  const fc: string[] = [];
  // voice
  for (let i = 0; i < parts.length; i++) fc.push(`[${i}:a]atrim=0:${parts[i].dur.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100[v${i}]`);
  fc.push([...parts.keys()].map((i) => `[v${i}]`).join('') + `concat=n=${parts.length}:v=0:a=1[voice]`);
  if (musicFile) {
    fc.push(
      `[${musicIdx}:a]atrim=0:${totalDur.toFixed(3)},asetpts=PTS-STARTPTS,aresample=44100,volume=0.16[music]`,
      '[voice][music]sidechaincompress=threshold=0.05:ratio=8:attack=40:release=500:level_sc=1.4[vm]',
    );
  }
  let voiceBus = musicFile ? '[vm]' : '[voice]';
  for (let i = 0; i < sfx.length; i++) {
    const ms = Math.max(0, Math.round(sfx[i].at * 1000));
    fc.push(
      `[${sfxIdxs[i]}:a]atrim=0:3,asetpts=PTS-STARTPTS,adelay=${ms}|${ms},volume=${sfx[i].vol}[sfx${i}]`,
      `${voiceBus}[sfx${i}]amix=inputs=2:duration=first:normalize=0[b${i}]`,
    );
    voiceBus = `[b${i}]`;
  }
  fc.push(`${voiceBus}alimiter=limit=0.95[aout]`);

  args.push('-filter_complex', fc.join(';'), '-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-t', totalDur.toFixed(3), out);
  await pexecFile('ffmpeg', args, { maxBuffer: 16 * 1024 * 1024 });
}

export function probeOut(file: string): Promise<MediaInfo> {
  return ffprobe(file);
}
