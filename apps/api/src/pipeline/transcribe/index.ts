// Syntheniq — transcription orchestrator.
// Provider chain: OpenAI Whisper API → local faster-whisper →
// audio-structure fallback.
import { ensureWav } from './audio.js';
import { isConfigured as apiConfigured, transcribeApi } from './whisperApi.js';
import { isAvailable as localAvailable, transcribeLocal } from './localWhisper.js';
import { transcribeFallback } from './energyFallback.js';
import type { TranscriptResult } from '../../types.js';

export interface TranscribeOptions {
  offset?: number;
  language?: string;
}

export async function transcribeWav(
  wavPath: string,
  { offset = 0, language = undefined }: TranscribeOptions = {}
): Promise<TranscriptResult> {
  const attempts: string[] = [];
  if (apiConfigured()) {
    try {
      return await transcribeApi(wavPath, { language, offset });
    } catch (err) {
      attempts.push(`openai-whisper failed: ${(err as Error).message}`);
    }
  }
  if (await localAvailable()) {
    try {
      return await transcribeLocal(wavPath, { language, offset });
    } catch (err) {
      attempts.push(`local-whisper failed: ${(err as Error).message}`);
    }
  }
  const fallback = await transcribeFallback(wavPath, { offset });
  fallback.attempts = attempts;
  return fallback;
}

export async function transcribeVideo(
  videoPath: string,
  wavPath: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptResult> {
  await ensureWav(videoPath, wavPath);
  return transcribeWav(wavPath, opts);
}

export async function transcribeRange(
  videoPath: string,
  start: number,
  end: number,
  wavPath: string,
  opts: TranscribeOptions = {}
): Promise<TranscriptResult> {
  const padStart = Math.max(0, start - 1.5);
  await ensureWav(videoPath, wavPath, { ss: padStart, to: end });
  return transcribeWav(wavPath, { ...opts, offset: padStart });
}

export interface LongTranscribeOptions extends TranscribeOptions {
  /** Above this duration (seconds) the audio is transcribed in chunks. */
  chunkThreshold?: number;
  /** Chunk length in seconds. */
  chunkLength?: number;
  /** Overlap between chunks in seconds (boundary words land in both). */
  chunkOverlap?: number;
  onProgress?: (fraction: number) => void;
  transcribeFn?: (
    videoPath: string,
    start: number,
    end: number,
    wavPath: string,
    opts?: TranscribeOptions
  ) => Promise<TranscriptResult>;
}

/**
 * Long-form transcription. Short videos take the single-shot path; beyond
 * `chunkThreshold` the audio is transcribed in overlapping chunks and merged,
 * so a 2-hour upload behaves like twelve 10-minute ones (bounded memory,
 * steady progress, no giant-model timeout cliffs).
 */
export async function transcribeLong(
  videoPath: string,
  wavPath: string,
  duration: number,
  opts: LongTranscribeOptions = {}
): Promise<TranscriptResult> {
  const threshold = opts.chunkThreshold ?? 900;
  const length = Math.max(60, opts.chunkLength ?? 600);
  const overlap = Math.min(30, Math.max(0, opts.chunkOverlap ?? 10));
  const step = Math.max(30, length - overlap);
  const transcribeFn = opts.transcribeFn || transcribeRange;

  if (!(duration > threshold)) {
    await ensureWav(videoPath, wavPath);
    return transcribeWav(wavPath, opts);
  }

  const merged: TranscriptResult = {
    segments: [],
    language: null,
    provider: 'local-whisper+chunked',
    hasText: false,
    attempts: [],
  };
  let processed = 0;
  const total = Math.ceil(duration / step);
  for (let start = 0; start < duration; start += step) {
    const end = Math.min(duration, start + length);
    const chunkWav = wavPath.replace(/\.wav$/i, '') + `-chunk${processed}.wav`;
    const part = await transcribeFn(videoPath, start, end, chunkWav, opts);
    if (processed === 0) {
      if (part.provider && !part.provider.includes('chunked')) merged.provider = `${part.provider}+chunked`;
      merged.language = part.language ?? null;
    }
    if (Array.isArray(part.attempts) && part.attempts.length) merged.attempts.push(...part.attempts);
    for (const seg of part.segments || []) {
      if (seg.end <= start || seg.start >= end) continue;
      merged.segments.push(seg);
    }
    processed++;
    if (opts.onProgress) {
      try {
        opts.onProgress(processed / total);
      } catch {
        // ignore progress listener errors
      }
    }
  }
  merged.segments.sort((a, b) => a.start - b.start || a.end - b.end);
  merged.hasText = merged.segments.some((s) => s.text && s.text.trim().length > 0);
  return merged;
}
