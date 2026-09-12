// Syntheniq — synthetic test media with REAL speech (espeak-ng narration
// + multi-segment video), cached and cross-process locked.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIX_DIR = path.join(here, '..', 'fixtures');
const LOCK_DIR = path.join(FIX_DIR, '.lock');

export const NARRATION = [
  'Why do most videos fail in the first three seconds?',
  'I spent thirty days studying the channels that blow up, and what I found shocked me.',
  'Nobody talks about the opening line, but the opening line is everything.',
  'Here is the thing. Viewers decide in a single breath whether to stay or to scroll away.',
  'I tried three different hooks on the same video, and the result was completely different each time.',
  'But then something unexpected happened, and the numbers turned around.',
  'The secret is simple. Ask a question, make a promise, and pay it off before the end.',
  'So remember this. Start with curiosity, end with proof, and do this every single time.',
  'Finally, here is how you know it worked. People stay, they comment, and they come back for more.',
].join(' ');

function sh(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: 'pipe' });
}

function ffprobeDuration(file: string): number {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', file],
    { encoding: 'utf8' }
  );
  return parseFloat(JSON.parse(out).format.duration) || 0;
}

function scriptHash(): string {
  return crypto.createHash('sha256').update(NARRATION).digest('hex').slice(0, 12);
}

export interface FixtureSet {
  demo: string;
  short: string;
}

function fixturesReady(): FixtureSet | null {
  const demo = path.join(FIX_DIR, 'demo-60.mp4');
  const short = path.join(FIX_DIR, 'short-30.mp4');
  const hashFile = path.join(FIX_DIR, '.hash');
  if (!fs.existsSync(demo) || !fs.existsSync(short) || !fs.existsSync(hashFile)) return null;
  if (fs.readFileSync(hashFile, 'utf8').trim() !== scriptHash()) return null;
  try {
    if (ffprobeDuration(demo) < 50 || ffprobeDuration(short) < 25) return null;
  } catch {
    return null;
  }
  return { demo, short };
}

function acquireLock(waitMs = 300000): boolean {
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      return true;
    } catch {
      const ready = fixturesReady();
      if (ready) return false;
      if (Date.now() - start > waitMs) throw new Error('Timed out waiting for fixture lock');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
}

function releaseLock(): void {
  try {
    fs.rmSync(LOCK_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function generate(): FixtureSet {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const scriptFile = path.join(FIX_DIR, 'narration.txt');
  const wavFile = path.join(FIX_DIR, 'narration.wav');
  fs.writeFileSync(scriptFile, NARRATION);

  sh('espeak-ng', ['-v', 'en-us', '-s', '165', '-f', scriptFile, '-w', wavFile]);

  const sources = ['testsrc2', 'smptebars', 'rgbtestsrc', 'yuvtestsrc'];
  const parts: string[] = [];
  sources.forEach((src, i) => {
    const part = path.join(FIX_DIR, `part${i}.mp4`);
    sh('ffmpeg', [
      '-hide_banner', '-y',
      '-f', 'lavfi',
      '-i', `${src}=s=1280x720:r=30:d=15`,
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-pix_fmt', 'yuv420p',
      '-an',
      part,
    ]);
    parts.push(part);
  });
  const listFile = path.join(FIX_DIR, 'parts.txt');
  fs.writeFileSync(listFile, parts.map((p) => `file '${p}'`).join('\n'));
  const videoOnly = path.join(FIX_DIR, 'video-60.mp4');
  sh('ffmpeg', ['-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', videoOnly]);

  const demo = path.join(FIX_DIR, 'demo-60.mp4');
  sh('ffmpeg', [
    '-hide_banner', '-y',
    '-i', videoOnly,
    '-i', wavFile,
    '-filter_complex', '[1:a]apad,atrim=0:60[a]',
    '-map', '0:v',
    '-map', '[a]',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-t', '60',
    '-movflags', '+faststart',
    demo,
  ]);

  const short = path.join(FIX_DIR, 'short-30.mp4');
  sh('ffmpeg', ['-hide_banner', '-y', '-i', demo, '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', short]);

  for (const f of [...parts, listFile, videoOnly, scriptFile, wavFile]) {
    try {
      fs.unlinkSync(f);
    } catch {
      // ignore
    }
  }
  fs.writeFileSync(path.join(FIX_DIR, '.hash'), scriptHash());
  return { demo, short };
}

export function ensureFixtures(): FixtureSet {
  fs.mkdirSync(FIX_DIR, { recursive: true });
  const ready = fixturesReady();
  if (ready) return ready;
  const weHoldLock = acquireLock();
  try {
    const again = fixturesReady();
    if (again) return again;
    if (!weHoldLock) throw new Error('Fixture lock released without producing fixtures');
    return generate();
  } finally {
    if (weHoldLock) releaseLock();
  }
}
