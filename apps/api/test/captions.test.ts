import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCaptionEvents,
  buildASS,
  splitTwoLines,
  fmtAssTime,
} from '../src/pipeline/render/captions.js';
import type { Word } from '../src/types.js';

const W = (start: number, end: number, word: string): Word => ({ start, end, word });

test('words group into short timed phrases relative to the clip', () => {
  const words = [
    W(10, 10.3, 'Why'), W(10.3, 10.5, 'do'), W(10.5, 10.8, 'most'), W(10.8, 11.1, 'videos'),
    W(11.1, 11.4, 'fail?'), W(12, 12.3, 'Here'), W(12.3, 12.5, 'is'), W(12.5, 12.8, 'why.'),
  ];
  const events = buildCaptionEvents(words, 10, 20);
  assert.ok(events.length >= 2);
  assert.equal(events[0].start, 0);
  for (const e of events) {
    assert.ok(e.end > e.start);
    assert.ok(e.end <= 10.01);
    assert.ok(e.text.split(' ').length <= 4);
  }
});

test('events never overlap', () => {
  const words: Word[] = [];
  for (let i = 0; i < 20; i++) words.push(W(i * 0.3, i * 0.3 + 0.28, `w${i}`));
  const events = buildCaptionEvents(words, 0, 10);
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].start >= events[i - 1].end - 0.001, 'no bleed into next event');
  }
});

test('ASS output is a valid burn-in track', () => {
  const ass = buildASS([{ start: 1.2, end: 2.5, text: 'Hello world, this is a fairly long caption line' }]);
  assert.ok(ass.includes('[V4+ Styles]'));
  assert.ok(ass.includes('Style: Default,Inter,72,'));
  assert.ok(ass.includes('Dialogue: 0,0:00:01.20,0:00:02.50,Default'));
  assert.ok(ass.includes('\\N'), 'long lines wrap to two lines');
});

test('ASS special characters are neutralized', () => {
  const ass = buildASS([{ start: 0, end: 1, text: 'a{b}c' }]);
  assert.ok(!ass.includes('a{b}c'));
});

test('helpers behave', () => {
  assert.equal(fmtAssTime(61.237), '0:01:01.23');
  assert.equal(splitTwoLines('short line'), 'short line');
  assert.ok(splitTwoLines('this is a much longer caption that must wrap').includes('\\N'));
});
