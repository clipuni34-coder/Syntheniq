// Syntheniq — transcription fallback: audio-structure segmentation.
// Real measured speech-active intervals; no invented words.
import { ffprobe } from '../../lib/ffmpeg.js';
import { detectSpeech } from '../structure.js';
import type { TranscriptResult } from '../../types.js';

export async function transcribeFallback(
  wavPath: string,
  { offset = 0 }: { offset?: number } = {}
): Promise<TranscriptResult> {
  let duration = 0;
  try {
    const info = await ffprobe(wavPath);
    duration = parseFloat((info.format && info.format.duration) || '0') || 0;
  } catch {
    duration = 0;
  }
  const speech = duration > 0 ? await detectSpeech(wavPath, duration) : [];
  return {
    segments: speech.map((s) => ({
      start: s.start + offset,
      end: s.end + offset,
      text: '',
      words: [],
    })),
    language: null,
    provider: 'audio-structure fallback',
    hasText: false,
  };
}
