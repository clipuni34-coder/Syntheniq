import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureFixtures } from './helpers/fixtures.js';
import { ensureWav } from '../src/pipeline/transcribe/audio.js';
import { transcribeWav } from '../src/pipeline/transcribe/index.js';
import { analyzeCoverage } from '../src/pipeline/transcribe/coverage.js';

test('the pipeline transcribes real speech with word timestamps', async () => {
  const { short } = ensureFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-tr-'));
  const wav = path.join(dir, 'audio.wav');
  await ensureWav(short, wav);
  assert.ok(fs.statSync(wav).size > 100000);

  const result = await transcribeWav(wav);
  assert.ok(Array.isArray(result.segments));
  assert.ok(result.provider, 'provider is reported');
  if (result.hasText) {
    assert.ok(result.segments.length > 0, 'speech segments found');
    const words = result.segments.flatMap((s) => s.words || []);
    assert.ok(words.length > 10, 'word-level timestamps present');
    const joined = result.segments.map((s) => s.text).join(' ').toLowerCase();
    assert.ok(
      joined.includes('video') || joined.includes('three') || joined.includes('second'),
      `transcript resembles the narration, got: ${joined.slice(0, 120)}`
    );
    const cov = analyzeCoverage(result.segments, 30);
    assert.ok(cov.coverage > 0.4, `coverage ${cov.coverage} too low for full speech`);
  } else {
    assert.equal(result.provider, 'audio-structure fallback');
  }
});
