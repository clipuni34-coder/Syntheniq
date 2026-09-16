import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT, WHISPER_MODEL } from '../config.js';
import type { Transcript } from './types.js';

const pexecFile = promisify(execFile);

const FILLER = new Set(['um', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'mm', 'mmm', 'ahem', 'like', 'youknow']);

/**
 * Transcription router (spec §11): prefer the configured API (Gemini
 * Interactions API) when SYNTHENIQ_TRANSCRIBE=gemini and a key exists;
 * otherwise — and on any API failure — fall back to local faster-whisper.
 */
export async function transcribeAuto(
  wav: string,
  mediaDur: number,
  log: (m: string) => void,
): Promise<{ transcript: Transcript; provider: string }> {
  const mode = (process.env.SYNTHENIQ_TRANSCRIBE || 'local').toLowerCase();
  if (mode === 'gemini' && (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY)) {
    try {
      const { transcribeGemini } = await import('../ai/transcribe-gemini.js');
      const t = await transcribeGemini(wav, mediaDur, undefined, log);
      return { transcript: markFillers(t), provider: 'gemini-3.5-transcribe' };
    } catch (e) {
      log(`transcribe: gemini failed (${(e as Error).message}) — falling back to local faster-whisper`);
    }
  }
  const t = await transcribeLocal(wav, mediaDur, log);
  return { transcript: t, provider: `faster-whisper ${process.env.SYNTHENIQ_WHISPER_MODEL || 'small'}` };
}

function markFillers(t: Transcript): Transcript {
  for (const s of t.segments) for (const w of s.words) {
    w.isFiller = FILLER.has(w.word.toLowerCase().replace(/[^a-z]/gi, ''));
  }
  return t;
}

/**
 * Stage: transcription — local faster-whisper (private, no key needed).
 * Word-level timestamps + VAD. Coverage gate per PRODUCT.md: the transcript
 * must cover ≥95% of the media duration or the job is incomplete.
 */
export async function transcribeLocal(wav: string, mediaDur: number, log: (m: string) => void): Promise<Transcript> {
  const out = path.join(path.dirname(wav), 'whisper-raw.json');
  const attempts: { label: string; args: string[] }[] = [
    { label: `whisper ${WHISPER_MODEL} (vad)`, args: ['--model', WHISPER_MODEL, '--beam', '1'] },
    { label: `whisper ${WHISPER_MODEL} (no-vad, beam 5)`, args: ['--model', WHISPER_MODEL, '--beam', '5', '--no-vad'] },
  ];

  let raw: any = null;
  for (const a of attempts) {
    try {
      log(`[transcribe] ${a.label} ...`);
      const { stderr } = await pexecFile(
        process.execPath === 'node' ? 'python3' : 'python3',
        [path.join(ROOT, 'apps', 'api', 'tools', 'whisper_transcribe.py'), '--wav', wav, '--out', out, ...a.args],
        { timeout: 4 * 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 },
      );
      (stderr || '')
        .split('\n')
        .filter((l) => l.trim())
        .forEach((l) => log(l.trim()));
      const { readFileSync } = await import('node:fs');
      raw = JSON.parse(readFileSync(out, 'utf8'));
      break;
    } catch (e: any) {
      log(`[transcribe] ${a.label} failed: ${String(e.stderr || e.message).slice(0, 300)}`);
    }
  }
  if (!raw || !Array.isArray(raw.segments)) throw new Error('transcription produced no segments');

  const transcript: Transcript = {
    duration: mediaDur,
    language: raw.language || 'en',
    segments: raw.segments.map((s: any) => ({
      start: s.start,
      end: s.end,
      text: String(s.text || ''),
      words: (s.words || []).map((w: any) => {
        // whisper sometimes emits carry-over tokens like "-by" / "-word" for
        // "word by word"; strip the leading hyphen (keeps real hyphenated words).
        const word = String(w.word || '').replace(/^-+/, '');
        return {
          start: w.start,
          end: w.end,
          word,
          isFiller: FILLER.has(word.toLowerCase().replace(/[^a-z]/gi, '')),
        };
      }),
    })),
  };

  const lastEnd = transcript.segments.length ? Math.max(...transcript.segments.map((s) => s.end)) : 0;
  const coverage = mediaDur > 0 ? Math.min(1, lastEnd / mediaDur) : 0;
  if (coverage < 0.95) {
    throw new Error(
      `transcript coverage ${Math.round(coverage * 100)}% < 95% (last word ${lastEnd.toFixed(1)}s / ${mediaDur.toFixed(1)}s) — per product spec the job is incomplete`,
    );
  }
  log(`[transcribe] done: ${transcript.segments.length} segments, coverage ${(coverage * 100).toFixed(0)}%, lang=${transcript.language}`);
  return transcript;
}
