import { execSync, execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { transcribeLocal } from '../src/pipeline/transcribe.js';

const OUT = path.join(process.cwd(), '.repro');
mkdirSync(OUT, { recursive: true });
const S = path.join(OUT, 'speech.wav');
const SI = path.join(OUT, 'silence.wav');
const A = path.join(OUT, 'audio.wav');
const PHRASE =
  'Hello, this is a test of the Syntheniq transcription coverage gate with trailing silence at the end.';
const q = (s) => s.replace(/"/g, '\\"');

execSync(`espeak -w "${q(S)}" "${q(PHRASE)}"`, { stdio: 'ignore' });
execSync(`ffmpeg -y -v error -f lavfi -i "anullsrc=cl=mono:r=16000" -t 0.6 -q:a 9 "${q(SI)}"`, {
  stdio: 'ignore',
});
execSync(
  `ffmpeg -y -v error -i "${q(S)}" -i "${q(SI)}" -filter_complex "[0:a][1:a]concat=n=2:v=0:a=1[a]" -map "[a]" -ar 16000 -ac 1 "${q(A)}"`,
  { stdio: 'ignore' },
);

const dur = parseFloat(
  JSON.parse(
    execFileSync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_entries', 'format=duration', A], {
      encoding: 'utf8',
    }),
  ).format.duration,
);
console.log(`[repro] built audio.wav (espeak speech + 0.6s trailing silence): dur=${dur.toFixed(4)}s`);

const log = (m) => console.log('[gated]', m);

let transcript = null;
let outcome = 'REJECTED';
try {
  transcript = await transcribeLocal(A, dur, log);
  outcome = 'ACCEPTED';
} catch (e) {
  console.log(`[repro] transcribeLocal threw: ${e.message}`);
}

let lastEnd = 0;
let firstStart = Infinity;
if (transcript) {
  for (const s of transcript.segments) for (const w of s.words) {
    lastEnd = Math.max(lastEnd, w.end);
    firstStart = Math.min(firstStart, w.start);
  }
}

console.log(`[repro] RESULT=${outcome}`);
if (transcript) {
  const oldCov = dur > 0 ? Math.min(1, lastEnd / dur) : 0;
  console.log(`[repro] firstWord=${firstStart.toFixed(3)}s lastWord=${lastEnd.toFixed(3)}s mediaDur=${dur.toFixed(3)}s`);
  console.log(`[repro] OLD formula (lastWord/mediaDur)=${Math.round(oldCov * 100)}% -> ${oldCov < 0.95 ? 'REJECT' : 'pass'}`);
  console.log(`[repro] NEW formula: trailing silence excluded (see [gated] coverage-gate log above)`);
} else {
  console.log(`[repro] transcript was rejected by the gate (see throw + [gated] logs above for real values)`);
}
process.exit(outcome === 'ACCEPTED' ? 0 : 64);
