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
