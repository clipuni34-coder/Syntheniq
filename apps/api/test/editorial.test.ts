import test from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS } from '../src/pipeline/editorial/weights.js';
import { rankClips, sentencesFromSegments } from '../src/pipeline/editorial/index.js';
import { scoreCandidate } from '../src/pipeline/editorial/features.js';
import type { Segment } from '../src/types.js';

function seg(start: number, end: number, text: string): Segment {
  return { start, end, text, words: [] };
}

const SEGMENTS = [
  seg(0, 20, 'So today we are just going to talk for a while about some general things.'),
  seg(20, 40, 'It is a fairly normal day and there is nothing too surprising happening here.'),
  seg(40, 60, 'Let me just keep talking to fill some time while the camera keeps rolling.'),
  seg(60, 80, 'Why do most videos fail in the first three seconds? Nobody talks about the opening line.'),
  seg(80, 100, 'But here is the thing. Viewers decide in a single breath whether to stay or scroll away.'),
  seg(100, 125, 'Finally, here is how you know it worked. People stay, they comment, and they come back. Remember this.'),
];

const STRUCTURE = {
  sceneCuts: [10, 30, 55, 70, 90, 110],
  speechActive: [{ start: 0, end: 125 }],
  energyCurve: Array.from({ length: 250 }, (_, i) => ({ t: i * 0.5, rms: 0.2 })),
};

test('editorial weights sum to exactly 1 with the specified contract', () => {
  assert.deepEqual(WEIGHTS, {
    hook: 0.25,
    curiosity: 0.2,
    payoff: 0.2,
    standalone: 0.15,
    emotion: 0.1,
    visual: 0.1,
  });
  const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

test('sentences keep their timestamps', () => {
  const sentences = sentencesFromSegments(SEGMENTS);
  assert.ok(sentences.length >= 6);
  for (const s of sentences) {
    assert.ok(s.end > s.start, 'sentence has positive duration');
    assert.ok(s.text.length > 1);
  }
  assert.ok(sentences[0].start >= 0);
});

test('ranking prefers the passage with hook + curiosity + payoff', () => {
  const { clips, stats } = rankClips({
    segments: SEGMENTS,
    structure: STRUCTURE,
    duration: 125,
    hasText: true,
    maxClips: 3,
  });
  assert.equal(clips.length, 3);
  assert.ok(stats.candidatesConsidered > clips.length);
  for (let i = 1; i < clips.length; i++) {
    assert.ok(clips[i - 1].total >= clips[i].total, 'clips sorted by score');
  }
  const top = clips[0];
  assert.ok(top.start < 125 && top.end > 60, `top clip ${top.start}–${top.end} misses the strong passage`);
  assert.ok(top.total > 0.45, `top score ${top.total} unexpectedly low`);
  assert.ok(top.scores.hook >= 0.5, 'hook detected');
  assert.ok(top.reasons.length > 0);
});

test('scores stay within 0..1 and reasons are evidence', () => {
  const { clips } = rankClips({
    segments: SEGMENTS,
    structure: STRUCTURE,
    duration: 125,
    hasText: true,
    maxClips: 5,
  });
  for (const c of clips) {
    for (const v of Object.values(c.scores)) assert.ok(v >= 0 && v <= 1);
    assert.ok(c.total >= 0 && c.total <= 1);
    assert.ok(Array.isArray(c.reasons) && c.reasons.length > 0);
    assert.ok(c.duration >= 10 && c.duration <= 62);
  }
});

test('near-duplicate windows are suppressed, distinct moments survive', () => {
  const { clips, stats } = rankClips({
    segments: SEGMENTS,
    structure: STRUCTURE,
    duration: 125,
    hasText: true,
    maxClips: 8,
  });
  assert.ok(stats.candidatesConsidered > clips.length * 3, 'suppression actually pruned');
  for (let i = 0; i < clips.length; i++) {
    for (let j = i + 1; j < clips.length; j++) {
      const a = clips[i];
      const b = clips[j];
      const inter = Math.max(0, Math.min(a.end, b.end) - Math.max(a.start, b.start));
      const union = a.end - a.start + (b.end - b.start) - inter;
      assert.ok(inter / union < 0.5, 'kept clips must not be near-duplicates');
    }
  }
  assert.ok(clips.length >= 2, 'distinct moments survive as choices');
});

test('textless input still yields honest audio/visual clips', () => {
  const { clips } = rankClips({
    segments: [],
    structure: STRUCTURE,
    duration: 125,
    hasText: false,
    maxClips: 3,
  });
  assert.ok(clips.length >= 1);
  assert.ok(clips[0].title.includes('Moment at'));
  assert.ok(clips[0].reasons.some((r) => r.includes('Audio-only')));
});

test('CTA baggage is penalized', () => {
  const withCta = scoreCandidate(
    {
      start: 0,
      end: 30,
      text: 'This is a decent story with a nice arc and a clear ending for everyone. Smash that subscribe button and hit the bell for more.',
      sentences: ['This is a decent story with a nice arc and a clear ending for everyone.', 'Smash that subscribe button and hit the bell for more.'],
    },
    STRUCTURE
  );
  const clean = scoreCandidate(
    {
      start: 0,
      end: 30,
      text: 'This is a decent story with a nice arc and a clear ending for everyone watching today.',
      sentences: ['This is a decent story with a nice arc and a clear ending for everyone watching today.'],
    },
    STRUCTURE
  );
  assert.ok(clean.scores.standalone > withCta.scores.standalone, 'CTA should lower standalone value');
});
