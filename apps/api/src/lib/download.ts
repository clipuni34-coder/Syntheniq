// Syntheniq — URL-based media import (YouTube, etc.).
// Uses yt-dlp with cookies + Chrome impersonation to bypass bot detection.
import fs from 'node:fs';
import path from 'node:path';
import { run, type RunOptions } from './ffmpeg.js';
import { YTDLP_COOKIES, YTDLP_BINARY, YTDLP_MODULE } from '../config.js';
import { sourceDir, ensureDir } from './paths.js';

// yt-dlp args (everything after `python3 -W ignore -m yt_dlp`).
function buildYtDlpArgs(url: string, outputPath: string): string[] {
  return [
    // Format fallback: prefer 1080p-or-below, fall back to best.
    '-f', 'best[height<=1080]/best',
    // Remux to mp4 so downstream ffmpeg always sees a known container.
    '--remux-video', 'mp4',
    // Merge audio+video into a single file.
    '--merge-output-format', 'mp4',
    // Chrome impersonation defeats YouTube's headless-browser UA checks.
    '--impersonate', 'chrome',
    // Output template — --remux-video guarantees the final file lands at outputPath.
    '-o', outputPath,
    // Quiet stdout but keep stderr for error diagnostics.
    '-q',
    // Cookies from authenticated session (when available).
    ...(YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES) ? ['--cookies', YTDLP_COOKIES] : []),
    // The URL to download from.
    url,
  ];
}

export async function downloadFromUrl(
  url: string,
  projectId: string,
  onStdoutLine: RunOptions['onStdoutLine'],
  timeoutMs = 0
): Promise<string> {
  const dir = ensureDir(sourceDir(projectId));
  const timestamp = Date.now().toString(36);
  const outputPath = path.join(dir, `original-${timestamp}.mp4`);

  // In this environment yt-dlp is invoked via `python3 -m yt_dlp`.
  // -W ignore suppresses the Python 3.10 deprecation warning.
  // When YTDLP_BINARY is set to a standalone binary (e.g. "yt-dlp"),
  // pass the args directly without the python wrapper.
  const isPython = YTDLP_BINARY === 'python3' || YTDLP_BINARY === 'python';
  const args = isPython
    ? ['-W', 'ignore', '-m', YTDLP_MODULE, ...buildYtDlpArgs(url, outputPath)]
    : buildYtDlpArgs(url, outputPath);

  const { stdout, stderr, code } = await run(YTDLP_BINARY, args, {
    onStdoutLine,
    timeoutMs,
  });

  if (code !== 0) {
    const tail = stderr || stdout;
    fs.rmSync(outputPath, { force: true });
    throw new Error(
      `yt-dlp failed (exit ${code}): ${tail.trim().split('\n').pop() || 'unknown error'}`
    );
  }
  if (!fs.existsSync(outputPath)) {
    // yt-dlp may append an extra extension (e.g. .mp4.1); check for it.
    const dirFiles = fs.readdirSync(dir).filter((f) => f.startsWith(`original-${timestamp}`));
    if (dirFiles.length === 0) {
      throw new Error('yt-dlp completed but no file was written');
    }
    return path.join(dir, dirFiles[0]);
  }
  return outputPath;
}
