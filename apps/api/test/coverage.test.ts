import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCoverage, mergeSegments } from '../src/pipeline/transcribe/coverage.js';
import type { Segment } from '../src/types.js';

const S = (start: number, end: number, text = 'words'): Segment => ({ start, end, text, words: [] });

test('full coverage passes with no gaps', () => {
  const r = analyzeCoverage([S(0, 30), S(30, 60)], 60);
  assert.equal(r.needsWork, false);
  assert.ok(r.coverage >= 0.99);
  assert.deepEqual(r.gaps, []);
});

test('an early cutoff tail is detected with its position', () => {
  const r = analyzeCoverage([S(0, 30)], 90);
  assert.equal(r.needsWork, true);
  assert.ok(r.gaps.some((g) => g.start <= 30.1 && g.end >= 89.9), 'tail gap reported');
  assert.ok(r.reasons.some((x) => x.includes('but the video runs to 90s')));
  assert.equal(Math.round(r.lastCoveredSecond), 30);
});

test('inner gaps are detected', () => {
  const r = analyzeCoverage([S(0, 20), S(50, 90)], 90);
  assert.equal(r.needsWork, true);
  assert.ok(r.gaps.some((g) => g.start <= 20.1 && g.end >= 49.9));
});

test('brief pauses are not treated as missing audio', () => {
  const r = analyzeCoverage([S(0, 28), S(33, 60)], 60);
  assert.equal(r.needsWork, false);
});

test('empty transcript on a real video demands full re-processing', () => {
  const r = analyzeCoverage([], 60);
  assert.equal(r.needsWork, true);
  assert.ok(r.reasons[0].includes('No transcript segments'));
});

test('mergeSegments reunites recovered ranges and drops duplicates', () => {
  const primary = [S(0, 30, 'hello world'), S(0.2, 29, 'hello')];
  const extra = [S(30, 60, 'second half here')];
  const merged = mergeSegments(primary, extra);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, 'hello world');
  assert.equal(merged[1].text, 'second half here');
  const r = analyzeCoverage(merged, 60);
  assert.equal(r.needsWork, false);
});
