import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureFixtures } from './helpers/fixtures.js';
import { renderClip, verifyExport, extractPoster } from '../src/pipeline/render/index.js';
import { buildCaptionEvents, writeASS } from '../src/pipeline/render/captions.js';
import type { Word } from '../src/types.js';

function fakeWords(start: number, end: number): Word[] {
  const vocab = 'Why do most videos fail in the first three seconds of playback'.split(' ');
  const words: Word[] = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const s = start + ((end - start) * i) / n;
    words.push({ start: s, end: s + 0.3, word: vocab[i % vocab.length] });
  }
  return words;
}

test('renderClip produces a verified iPhone-spec MP4 with burned-in captions', async () => {
  const { short } = ensureFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-render-'));
  const events = buildCaptionEvents(fakeWords(5, 15), 5, 15);
  assert.ok(events.length >= 2);
  const ass = path.join(dir, 'captions.ass');
  writeASS(ass, events);

  const out = path.join(dir, 'out.mp4');
  let progressCalls = 0;
  await renderClip({
    input: short,
    start: 5,
    duration: 10,
    assFile: ass,
    outFile: out,
    onProgress: () => {
      progressCalls++;
    },
  });
  assert.ok(fs.statSync(out).size > 50000, 'render has real bytes');
  assert.ok(progressCalls > 0, 'progress reported');

  const v = await verifyExport(out);
  assert.deepEqual(v.checks, {
    hasVideo: true,
    videoCodec: true,
    resolution: true,
    fps: true,
    pixFmt: true,
    audioCodec: true,
    faststart: true,
  });
  assert.equal(v.ok, true);
  assert.equal(v.details.width, 1080);
  assert.equal(v.details.height, 1920);
  assert.equal(v.details.videoCodec, 'h264');
  assert.equal(v.details.audioCodec, 'aac');
});

test('renderClip works captionless (the audio-only path)', async () => {
  const { short } = ensureFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-render-'));
  const out = path.join(dir, 'plain.mp4');
  await renderClip({ input: short, start: 0, duration: 6, assFile: null, outFile: out });
  const v = await verifyExport(out);
  assert.equal(v.ok, true);
});

test('extractPoster writes a vertical JPEG', async () => {
  const { short } = ensureFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syn-render-'));
  const poster = path.join(dir, 'poster.jpg');
  await extractPoster(short, 12, poster);
  const stat = fs.statSync(poster);
  assert.ok(stat.size > 5000);
});
