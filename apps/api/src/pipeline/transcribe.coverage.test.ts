import { strict as assert } from 'node:assert';
import { computeCoverage } from './transcribe.js';
import type { Transcript } from './types.js';

function mk(lastWordEnd: number, mediaDur: number, opts: { firstStart?: number; segEnd?: number } = {}): Transcript {
  const start = opts.firstStart ?? 0;
  const segEnd = opts.segEnd ?? lastWordEnd;
  return {
    duration: mediaDur,
    language: 'en',
    segments: [
      {
        start,
        end: segEnd,
        text: 'x',
        words: [{ start, end: lastWordEnd, word: 'x', isFiller: false }],
      },
    ],
  };
}

const THRESHOLD = 0.95;

// 1) Bug scenario: trailing silence at the tail. Speech ends at 5.12s, audio
//    runs to 5.96s. OLD gate (lastEnd/mediaDur = 5.12/5.96 = 86%) REJECTED.
//    NEW gate excludes the 0.84s trailing silence -> speechEnd=5.12 -> 100% PASS.
{
  const t = mk(5.12, 5.96);
  const c = computeCoverage(t, 5.96, 0.84);
  const oldCov = Math.min(1, 5.12 / 5.96);
  assert.equal(c.coverage, 1, 'trailing silence must be excluded so coverage hits 100%');
  assert.ok(c.passed, 'gate must PASS when the gap after the last word is silence');
  assert.ok(oldCov < THRESHOLD, 'OLD formula (86%) would have rejected — reproducing the bug');
  assert.ok(c.speechEnd < 5.96 && c.trailingSilence === 0.84, 'speechEnd excludes trailing silence');
}

// 2) Genuinely incomplete: last word at 4.0s but speech actually ends at 5.5s
//    (trailing silence only 0.5s). Gate must still FAIL.
{
  const t = mk(4.0, 6.0);
  const c = computeCoverage(t, 6.0, 0.5);
  assert.ok(!c.passed, 'real incompleteness must still fail the gate');
  assert.ok(c.coverage < THRESHOLD, `coverage ${c.coverage} below 0.95`);
  assert.equal(c.speechEnd, 5.5);
}

// 3) No trailing silence detected, transcript stops early -> FAIL.
{
  const t = mk(3.0, 6.0);
  const c = computeCoverage(t, 6.0, 0);
  assert.ok(!c.passed);
  assert.equal(c.coverage, 0.5);
}

// 4) Boundary: last word exactly at speechEnd -> 100% PASS.
{
  const t = mk(5.0, 5.0, { firstStart: 0.2 });
  const c = computeCoverage(t, 5.0, 0);
  assert.equal(c.coverage, 1);
  assert.ok(c.passed);
}

// 5) Boundary just below: last word 4.5s over speechEnd 4.75s -> FAIL.
{
  const t = mk(4.5, 5.0);
  const c = computeCoverage(t, 5.0, 0.25);
  assert.equal(c.speechEnd, 4.75);
  assert.equal(c.coverage, 4.5 / 4.75);
  assert.ok(!c.passed);
}

// 6) Word-level precision: segment end is padded past the last word, but the
//    real last spoken word ended earlier -> coverage uses the WORD end, not
//    the (padded) segment end. Speech ends at 4.0s, pad pushes segment to 4.2s.
{
  const t = mk(4.0, 5.0, { segEnd: 4.2 });
  const c = computeCoverage(t, 5.0, 0);
  assert.equal(c.lastEnd, 4.0, 'coverage must use word end, not padded segment end');
  assert.equal(c.coverage, 4.0 / 5.0);
  assert.ok(!c.passed);
}

// 7) Empty transcript -> coverage 0 -> FAIL (no NaN).
{
  const t: Transcript = { duration: 10, language: 'en', segments: [] };
  const c = computeCoverage(t, 10, 0);
  assert.equal(c.coverage, 0);
  assert.ok(!c.passed);
  assert.ok(!Number.isNaN(c.coverage));
}

// 8) Zero-duration media -> coverage 0, no crash.
{
  const t = mk(0, 0);
  const c = computeCoverage(t, 0, 0);
  assert.equal(c.coverage, 0);
  assert.ok(!c.passed);
}

console.log(`transcribe.coverage.test: ALL PASSED (${8} cases)`);
