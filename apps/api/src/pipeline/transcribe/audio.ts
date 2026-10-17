// Syntheniq — decode (ranges of) the source video to 16kHz mono WAV for STT.
import { run } from '../../lib/ffmpeg.js';

export async function ensureWav(
  input: string,
  outPath: string,
  { ss = null, to = null }: { ss?: number | null; to?: number | null } = {}
): Promise<string> {
  const args = ['-hide_banner', '-y'];
  if (ss !== null && ss !== undefined) args.push('-ss', String(ss));
  if (to !== null && to !== undefined) args.push('-to', String(to));
  args.push(
    '-i',
    input,
    '-map',
    '0:a:0',
    '-af',
    'dynaudnorm=g=15:f=150',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    outPath,
  );
  await run('ffmpeg', args);
  return outPath;
}
