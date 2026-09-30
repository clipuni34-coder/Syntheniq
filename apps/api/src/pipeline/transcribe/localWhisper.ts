// Syntheniq — transcription provider: local faster-whisper (no API key).
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from '../../lib/ffmpeg.js';
import { WHISPER_MODEL, WHISPER_DEVICE } from '../../config.js';
import type { TranscriptResult } from '../../types.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function scriptPath(): string {
  // Works both from src/ (tsx) and dist/ (tsc build copies the script).
  const direct = path.join(here, 'whisper_local.py');
  if (fs.existsSync(direct)) return direct;
  return path.join(here, '..', '..', '..', 'src', 'pipeline', 'transcribe', 'whisper_local.py');
}

let availability: boolean | null = null;

export async function isAvailable(): Promise<boolean> {
  if (availability !== null) return availability;
  try {
    await run('python3', ['-c', 'import faster_whisper'], { timeoutMs: 30000 });
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

export async function transcribeLocal(
  wavPath: string,
  { language = undefined, offset = 0 }: { language?: string; offset?: number } = {}
): Promise<TranscriptResult> {
  const args = [
    scriptPath(),
    '--input',
    wavPath,
    '--model',
    WHISPER_MODEL,
    '--device',
    WHISPER_DEVICE,
    '--offset',
    String(offset),
  ];
  if (language) args.push('--language', language);
  const { stdout } = await run('python3', args, { timeoutMs: 1000 * 60 * 60 });
  const parsed = JSON.parse(stdout);
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  return {
    segments: segments
      .filter((s: any) => s && Number.isFinite(s.start) && Number.isFinite(s.end))
      .map((s: any) => ({
        start: s.start,
        end: s.end,
        text: String(s.text || '').trim(),
        words: Array.isArray(s.words)
          ? s.words
              .filter((w: any) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
              .map((w: any) => ({ start: w.start, end: w.end, word: String(w.word || '') }))
          : [],
      })),
    language: parsed.language || null,
    provider: `local-whisper (${WHISPER_MODEL})`,
    hasText: true,
  };
}
