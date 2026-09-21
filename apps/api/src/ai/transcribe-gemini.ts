import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Segment, Transcript } from '../pipeline/types.js';
import { detectSilences } from '../pipeline/media.js';
import { computeCoverage } from '../pipeline/transcribe.js';
import { AiError } from './types.js';

const pexecFile = promisify(execFile);
const BASE = 'https://generativelanguage.googleapis.com';
const CHUNK_SEC = 28 * 60; // word timestamps are limited to 30 min per request

/**
 * Gemini 3.5 Transcribe (official Interactions API, verified 2026-09-15):
 *   1. upload audio via Files API (resumable protocol)
 *   2. POST /v1beta/interactions  model=gemini-3.5-transcribe,
 *      transcription_config.mode = { type: "verbatim", timestamp_granularities: ["word"] }
 *   3. poll until status "completed", extract word_info annotations
 * Audio longer than 28 min is chunked with ffmpeg and offsets are re-based.
 */
export async function transcribeGemini(
  wav: string,
  mediaDur: number,
  language: string | undefined,
  log: (m: string) => void,
): Promise<Transcript> {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new AiError('GEMINI_API_KEY not set', false);

  // chunk long audio
  const chunks: { start: number; file: string }[] = [];
  if (mediaDur <= CHUNK_SEC) {
    chunks.push({ start: 0, file: wav });
  } else {
    const dir = path.dirname(wav);
    let i = 0;
    for (let t = 0; t < mediaDur; t += CHUNK_SEC) {
      const f = path.join(dir, `chunk-${i}.wav`);
      await pexecFile('ffmpeg', ['-y', '-v', 'error', '-ss', String(t), '-t', String(CHUNK_SEC), '-i', wav, '-c', 'copy', f], {
        maxBuffer: 8 * 1024 * 1024,
      });
      chunks.push({ start: t, file: f });
      i++;
    }
    log(`[transcribe:gemini] ${Math.ceil(mediaDur / CHUNK_SEC)} chunks of ${CHUNK_SEC / 60}min`);
  }

  const segments: Segment[] = [];
  for (const chunk of chunks) {
    log(`[transcribe:gemini] chunk @ ${chunk.start.toFixed(0)}s: uploading + transcribing…`);
    const uri = await uploadFile(key, chunk.file, log);
    const interaction = await createTranscription(key, uri, 'audio/wav', language, log);
    const final = await waitForCompletion(key, interaction, log);
    const words = extractWords(final);
    if (!words.length) throw new AiError(`gemini transcribe returned no word annotations for chunk @${chunk.start}s`, true);
    for (const w of words) {
      segments.push({
        start: r3(chunk.start + w.start),
        end: r3(chunk.start + w.end),
        text: w.text,
        words: [{ start: r3(chunk.start + w.start), end: r3(chunk.start + w.end), word: w.text, isFiller: false }],
      });
    }
  }

  const grouped = groupWordsToSegments(segments);
  const transcript: Transcript = { duration: mediaDur, language: language || 'en', segments: grouped };
  const silences = await detectSilences(wav, mediaDur);
  const trailing =
    silences.length && silences[silences.length - 1].end >= mediaDur - 0.05
      ? mediaDur - silences[silences.length - 1].start
      : 0;
  const cov = computeCoverage(transcript, mediaDur, trailing);
  log(
    `[transcribe:gemini] coverage gate: mediaDur=${mediaDur.toFixed(2)}s firstWord=${cov.firstStart.toFixed(2)}s ` +
      `lastWord=${cov.lastEnd.toFixed(2)}s trailingSilence=${cov.trailingSilence.toFixed(2)}s ` +
      `speechEnd=${cov.speechEnd.toFixed(2)}s coverage=${Math.round(cov.coverage * 100)}% ` +
      `threshold=${Math.round(cov.threshold * 100)}% -> ${cov.reason}`,
  );
  if (!cov.passed) {
    throw new AiError(`gemini transcript coverage ${Math.round(cov.coverage * 100)}% < 95% — ${cov.reason}`, true);
  }
  log(`[transcribe:gemini] done: ${grouped.length} segments, coverage ${(cov.coverage * 100).toFixed(0)}%`);
  return transcript;
}

// ── Files API (resumable upload) ────────────────────────────────────────

async function uploadFile(key: string, file: string, log: (m: string) => void): Promise<string> {
  const size = (await stat(file)).size;
  const init = await fetch(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': 'audio/wav',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { mimeType: 'audio/wav', displayName: path.basename(file) } }),
  });
  if (!init.ok) throw new AiError(`gemini files init failed: HTTP ${init.status} ${await init.text()}`, init.status >= 500 || init.status === 429);
  const uploadUrl = init.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new AiError('gemini files: no upload url returned', false);
  const bytes = await readFile(file);
  const up = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'X-Goog-Upload-Command': 'upload, finalize',
      'X-Goog-Upload-Offset': '0',
      'Content-Type': 'audio/wav',
      'Content-Length': String(size),
    },
    body: bytes,
  });
  if (!up.ok) throw new AiError(`gemini files upload failed: HTTP ${up.status}`, up.status >= 500 || up.status === 429);
  const data: any = await up.json();
  const uri: string | undefined = data?.file?.uri || data?.name;
  if (!uri) throw new AiError('gemini files: no file uri in response', false);
  log(`[transcribe:gemini] uploaded ${(size / 1e6).toFixed(0)}MB → ${uri}`);
  return uri;
}

// ── Interactions API ────────────────────────────────────────────────────

async function createTranscription(
  key: string,
  fileUri: string,
  mime: string,
  language: string | undefined,
  log: (m: string) => void,
): Promise<any> {
  const res = await fetch(`${BASE}/v1beta/interactions`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini-3.5-transcribe',
      input: [{ type: 'audio', uri: fileUri, mime_type: mime }],
      generation_config: {
        transcription_config: {
          mode: { type: 'verbatim', timestamp_granularities: ['word'] },
          language_codes: language ? [language] : [],
        },
      },
    }),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    throw new AiError(`gemini transcribe: ${msg}`, res.status === 429 || res.status >= 500, res.status);
  }
  return data;
}

async function waitForCompletion(key: string, interaction: any, log: (m: string) => void): Promise<any> {
  let cur = interaction;
  for (let i = 0; i < 120; i++) {
    if (cur?.status === 'completed') return cur;
    if (cur?.status === 'failed' || cur?.status === 'cancelled') {
      throw new AiError(`gemini transcribe interaction ${cur.status}: ${cur?.error?.message || ''}`, false);
    }
    await new Promise((r) => setTimeout(r, 5000));
    const res = await fetch(`${BASE}/v1beta/interactions/${cur.id}`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) throw new AiError(`gemini transcribe poll failed: HTTP ${res.status}`, res.status === 429 || res.status >= 500);
    cur = await res.json();
  }
  throw new AiError('gemini transcribe: timed out waiting for completion', true);
}

function parseOffset(o: string): number {
  const n = parseFloat(o);
  return isFinite(n) ? n : 0;
}

function extractWords(interaction: any): { text: string; start: number; end: number }[] {
  const out: { text: string; start: number; end: number }[] = [];
  for (const step of interaction?.steps ?? []) {
    for (const content of step?.content ?? []) {
      for (const a of content?.annotations ?? []) {
        if (a?.type === 'word_info' && a.text) {
          out.push({ text: a.text, start: parseOffset(a.start_offset || '0'), end: parseOffset(a.end_offset || '0') });
        }
      }
    }
  }
  return out;
}

function groupWordsToSegments(wordSegs: Segment[]): Segment[] {
  // words arrive as 1-word pseudo-segments; group into sentence-ish segments
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const s of wordSegs) {
    const gap = cur ? s.start - cur.end : 0;
    const punctEnd = /[.!?…]["')\]]?$/.test(s.text);
    if (!cur || gap > 0.6 || (cur && punctEnd && cur.end - cur.start > 1.2)) {
      if (cur) out.push(cur);
      cur = { ...s, words: [{ ...s.words[0] }] };
    } else {
      cur.end = s.end;
      cur.text = (cur.text + ' ' + s.text).trim();
      cur.words.push({ ...s.words[0] });
    }
  }
  if (cur) out.push(cur);
  return out.filter((s) => s.text.trim().length > 0);
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
