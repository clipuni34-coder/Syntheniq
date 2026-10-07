// Syntheniq — coverage repair policy: biggest gaps re-transcribed first,
// successes merge, failures become notes (never job failures).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-recover-'));
process.env.SYNTHENIQ_DATA = DATA_DIR;

const { recoverGaps } = await import('../src/pipeline/index.js');
const { analyzeCoverage } = await import('../src/pipeline/transcribe/coverage.js');

function coverageWith(gaps: { start: number; end: number }[]) {
  return { gaps, coverage: 0.5, coveredSeconds: 30, totalSeconds: 60, needsWork: true, reasons: [] as string[] };
}

test('recoverGaps re-transcribes the largest gaps and merges segments', async () => {
  const seen: { start: number; end: number }[] = [];
  const notes: string[] = [];
  const out = await recoverGaps({
    input: '/tmp/video.mp4',
    projectId: 'p1',
    duration: 60,
    segments: [{ start: 0, end: 10, text: 'hello' }],
    coverage: coverageWith([
      { start: 10, end: 20 },
      { start: 20, end: 50 },
      { start: 50, end: 60 },
      { start: 5, end: 7 },
    ]),
    language: 'en',
    notes,
    transcribeRangeFn: (async (_video: string, start: number, end: number) => {
      seen.push({ start, end });
      return {
        segments: [{ start, end, text: `recovered ${start}-${end}` }],
        language: 'en',
        provider: 'fake',
        hasText: true,
      };
    }) as never,
  });
  // Largest three gaps only, biggest first.
  assert.deepEqual(
    seen.map((g) => g.end - g.start),
    [30, 10, 10]
  );
  assert.equal(out.segments.length, 4);
  assert.ok(out.segments.some((s) => s.text.startsWith('recovered 20')));
  assert.ok(out.coverage.coveredSeconds >= 30);
});

test('recoverGaps turns slice failures into notes and keeps going', async () => {
  const notes: string[] = [];
  const progress: number[] = [];
  const out = await recoverGaps({
    input: '/tmp/video.mp4',
    projectId: 'p1',
    duration: 60,
    segments: [{ start: 0, end: 10, text: 'hello' }],
    coverage: coverageWith([{ start: 10, end: 60 }]),
    language: null,
    notes,
    onProgress: (f: number) => progress.push(f),
    transcribeRangeFn: (async () => {
      throw new Error('slice exploded');
    }) as never,
  });
  assert.equal(out.segments.length, 1);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Could not recover 00:10–01:00/);
  assert.deepEqual(progress, [1]);
});

test('analyzeCoverage flags gapped transcripts as needing work', async () => {
  const cov = analyzeCoverage([{ start: 0, end: 10, text: 'hi' }], 100);
  assert.equal(cov.needsWork, true);
  assert.ok(cov.gaps.length > 0);
  assert.ok(cov.reasons.length > 0);
});
