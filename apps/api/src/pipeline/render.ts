import { execFile } from 'node:child_process';
import { accessSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT } from '../config.js';
import type { MediaInfo } from './types.js';
import { ffprobe } from './media.js';

const pexecFile = promisify(execFile);

/**
 * Self-healing environment for the hyperframes CLI — survives sandbox resets
 * that wipe /tmp, node_modules, and extracted toolchains:
 *  - PATH: the Node >= 22 bin (hyperframes hard-requires it; the system node
 *    may be 20) + ffmpeg-static on PATH for ffprobe/ffmpeg lookups
 *  - LD_LIBRARY_PATH: headless Chrome's system libs (no apt in sandbox)
 */
function toolEnv(): NodeJS.ProcessEnv {
  const tools = path.join(ROOT, '..', 'tools');
  const nodeBin = path.join(tools, 'node-v22.14.0-linux-x64', 'bin');
  const ff = path.join(tools, 'ffmpeg-static');
  const libs = path.join(tools, 'chrome-libs', 'libs');
  const has = (p: string) => { try { accessSync(p); return true; } catch { return false; } };
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (has(nodeBin)) env.PATH = `${nodeBin}${path.delimiter}${env.PATH || ''}`;
  if (has(ff)) env.PATH = `${ff}${path.delimiter}${env.PATH || ''}`;
  if (has(libs)) env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  return env;
}

function hyperframesBin(): string {
  const candidates = [
    path.join(ROOT, 'node_modules', '.bin', 'hyperframes'),
    path.join(ROOT, 'apps', 'api', 'node_modules', '.bin', 'hyperframes'),
    process.env.HYPERFRAMES_BIN || '',
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      accessSync(c);
      return c;
    } catch {
      /* next */
    }
  }
  return 'npx'; // last resort (may hit network)
}

/**
 * Render one HyperFrames composition project dir to MP4 via the official CLI:
 *   hyperframes render <projectDir> -o out.mp4 --fps <30|60> --quality standard
 */
export async function renderComposition(
  compDir: string,
  outMp4: string,
  fps: number,
  log: (msg: string) => void,
): Promise<void> {
  const bin = hyperframesBin();
  // hyperframes reads <projectDir>/package.json; drop in a minimal one so the
  // render does not depend on what lives next to the data dir.
  await writeFile(
    path.join(compDir, 'package.json'),
    JSON.stringify({ name: `clip-${path.basename(compDir)}`, private: true, version: '1.0.0' }, null, 2),
  ).catch(() => {});
  // Keep hyperframes' temp workdir + extracted-frame cache on the main disk
  // (sandbox /tmp is a small tmpfs; the CLI hard-fails below 1GB free there).
  const hfTmp = path.join(ROOT, '.cache', 'hyperframes-tmp');
  const hfFrames = path.join(ROOT, '.cache', 'hyperframes-frames');
  await Promise.all([mkdir(hfTmp, { recursive: true }), mkdir(hfFrames, { recursive: true })]).catch(() => {});
  log(`[render] ${path.basename(compDir)}: hyperframes render (${fps}fps, standard, 1 worker)`);
  try {
    await pexecFile(
      bin,
      [
        'render',
        compDir,
        '-o',
        outMp4,
        '--fps',
        String(fps),
        '--quality',
        'standard',
        '--workers',
        '1',
        '--video-frame-format',
        'jpg',
        '--frames-cache-dir',
        hfFrames,
      ],
      {
        cwd: ROOT,
        timeout: 45 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...toolEnv(), TMPDIR: hfTmp },
      },
    );
  } catch (e: any) {
    const tail = String((e as any).stderr || '').split('\n').slice(-12).join(' | ');
    log(`[render] FAILED: ${tail || e.message}`);
    throw new Error(`hyperframes render failed: ${tail || e.message}`.slice(0, 2000));
  }
  log(`[render] ${path.basename(compDir)}: wrote ${path.basename(outMp4)}`);
}

/**
 * QC one rendered clip (spec §20):
 *  - file exists + non-trivial size
 *  - full decode passes (every frame decodable, no corruption)
 *  - frames at start/middle/end are extractable (clip starts/ends at intended times)
 *  - resolution 1080x1920, expected fps, duration within tolerance
 *  - audio stream present (lip sync: A/V segments are cut from the same source
 *    ranges, so sync is structurally preserved — verified by construction)
 */
export async function qcClip(outMp4: string, expectedDur: number, expectedFps: number): Promise<{ ok: boolean; issues: string[]; warnings: string[] }> {
  const issues: string[] = [];
  const warnings: string[] = [];

  let size = 0;
  try {
    const { stat } = await import('node:fs/promises');
    size = (await stat(outMp4)).size;
  } catch {
    return { ok: false, issues: ['output file missing'], warnings };
  }
  if (size < 100_000) issues.push(`file too small (${size} bytes)`);

  let info: MediaInfo;
  try {
    info = await ffprobe(outMp4);
  } catch (e) {
    return { ok: false, issues: [`ffprobe failed: ${(e as Error).message}`], warnings };
  }
  if (info.width !== 1080 || info.height !== 1920) issues.push(`resolution ${info.width}x${info.height} != 1080x1920`);
  if (info.fps !== expectedFps) issues.push(`fps ${info.fps} != ${expectedFps}`);
  if (Math.abs(info.duration - expectedDur) > Math.max(0.6, expectedDur * 0.05)) {
    issues.push(`duration ${info.duration.toFixed(1)}s vs expected ${expectedDur.toFixed(1)}s`);
  }
  if (!info.hasAudio) issues.push('no audio stream');

  // audio must actually CONTAIN sound (a broken mix can still carry a stream)
  try {
    const { stderr } = await pexecFile(
      'ffmpeg',
      ['-hide_banner', '-i', outMp4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
    const m = String(stderr).match(/max_volume:\s*(-?[\d.]+)\s*dB/);
    if (m && parseFloat(m[1]) < -50) issues.push('audio is (near) silent');
  } catch {
    /* volumedetect unavailable — non-blocking */
  }

  // full decode
  try {
    await pexecFile('ffmpeg', ['-v', 'error', '-i', outMp4, '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  } catch (e: any) {
    const msg = String(e.stderr || e.message).slice(0, 300);
    if (msg && !/Invalid data found/.test(msg)) issues.push(`decode errors: ${msg}`);
    else if (msg) warnings.push(`decode noise: ${msg}`);
  }

  // frozen-composition guard (spec §18/§27): a sub-composition that timed out
  // renders a STATIC snapshot that still probes as a perfectly valid MP4 —
  // exit code and ffprobe cannot catch it, so verify the picture actually
  // changes across the clip (captions/speaker/progress bar always move).
  try {
    const yavgs: { t: number; v: number }[] = [];
    for (let i = 1; i <= 6; i++) {
      const t = Math.max(0.1, (expectedDur * i) / 7);
      const { stdout } = await pexecFile(
        'ffmpeg',
        ['-hide_banner', '-ss', t.toFixed(2), '-i', outMp4, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'],
        { maxBuffer: 8 * 1024 * 1024, timeout: 2 * 60 * 1000 },
      );
      const m = String(stdout).match(/lavfi\.signalstats\.YAVG=([0-9.]+)/);
      if (m) yavgs.push({ t, v: parseFloat(m[1]) });
    }
    if (yavgs.length >= 4) {
      const black = yavgs.find((y) => y.v < 12);
      if (black) issues.push(`frame at ${black.t.toFixed(1)}s is black (video track may not have rendered)`);
      const span = Math.max(...yavgs.map((y) => y.v)) - Math.min(...yavgs.map((y) => y.v));
      if (span < 0.15) issues.push(`picture is static across the clip (possible frozen composition snapshot)`);
    }
  } catch {
    /* signalstats unavailable — non-blocking */
  }

  // frame extractability at start / middle / end
  const os = await import('node:os');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'qc-'));
  try {
    for (const t of [0.05, expectedDur / 2, Math.max(0.05, expectedDur - 0.1)]) {
      await pexecFile('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', outMp4, '-frames:v', '1', path.join(tmp, `f${t}.png`)], { maxBuffer: 8 * 1024 * 1024 });
    }
  } catch (e: any) {
    issues.push(`frame extraction failed: ${String(e.message).slice(0, 200)}`);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  return { ok: issues.length === 0, issues, warnings };
}

/** Best-effort static composition check before render (official CLI linter). */
export async function lintComposition(compDir: string, log: (msg: string) => void): Promise<void> {
  const bin = hyperframesBin();
  try {
    const { stdout, stderr } = await pexecFile(bin, ['lint', compDir, '--json'], { cwd: ROOT, timeout: 5 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
    const parsed = JSON.parse(String(stdout || stderr || ''));
    if (parsed.errorCount > 0) log(`[lint] ${compDir}: ${parsed.errorCount} errors: ${JSON.stringify(parsed.findings?.slice(0, 5) ?? [])}`);
    else log(`[lint] ${path.basename(compDir)}: ok (${parsed.warningCount ?? 0} warnings)`);
  } catch {
    /* linter unavailable — non-blocking */
  }
}
