// Syntheniq — transcription provider: OpenAI Whisper API.
import fs from 'node:fs';
import { OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL } from '../../config.js';
import type { Segment, TranscriptResult, Word } from '../../types.js';

export function isConfigured(): boolean {
  return Boolean(OPENAI_API_KEY);
}

export async function transcribeApi(
  wavPath: string,
  { language = undefined, offset = 0 }: { language?: string; offset?: number } = {}
): Promise<TranscriptResult> {
  if (!isConfigured()) throw new Error('OPENAI_API_KEY is not set');
  const fileBuffer = fs.readFileSync(wavPath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', OPENAI_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'segment');
  form.append('timestamp_granularities[]', 'word');
  if (language) form.append('language', language);

  const res = await fetch(`${OPENAI_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Whisper API error (${res.status}): ${body.slice(0, 500)}`);
  }
  const data = (await res.json()) as any;
  const segments: Segment[] = Array.isArray(data.segments) ? data.segments : [];
  const words: any[] = Array.isArray(data.words) ? data.words : [];
  const bySegment: Segment[] = segments.map((s) => ({
    start: (s.start || 0) + offset,
    end: (s.end || 0) + offset,
    text: String(s.text || '').trim(),
    words: [] as Word[],
  }));
  for (const w of words) {
    const ws = (w.start || 0) + offset;
    const we = (w.end || 0) + offset;
    const host = bySegment.find((s) => ws >= s.start - 0.5 && ws <= s.end + 0.5);
    const entry: Word = { start: ws, end: we, word: String(w.word || w.text || '') };
    if (host) host.words.push(entry);
  }
  return {
    segments: bySegment,
    language: data.language || null,
    provider: 'openai-whisper',
    hasText: true,
  };
}
