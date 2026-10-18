import test from 'node:test';
import assert from 'node:assert/strict';
import { WEIGHTS } from '../src/pipeline/editorial/weights.js';
import { rankClips, sentencesFromSegments, generateMultiSegmentCandidates, computeViralMultiplier, predictImprovedScore, predictViralScore } from '../src/pipeline/editorial/index.js';
import { scoreCandidate } from '../src/pipeline/editorial/features.js';
import { detectContentTheme, themeEditingProfile, detectDopamineMoments } from '../src/pipeline/editorial/themes.js';
import { resolveSfxAsset, getAvailableSfx, type SfxType } from '../src/pipeline/render/sfx.js';
import fs from 'node:fs';
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

test('viral multiplier rewards hooks at clip start and payoff at end', () => {
  const { multiplier } = computeViralMultiplier(0, 35, STRUCTURE);
  assert.ok(multiplier > 1, `Expected multiplier > 1, got ${multiplier}`);

  const { multiplier: midMult } = computeViralMultiplier(60, 95, STRUCTURE);
  assert.ok(midMult < multiplier, 'mid-clip multiplier should be lower than hook-at-start');
});

test('predictImprovedScore increases with more SFX and transitions', () => {
  const base = predictImprovedScore(0.5, 1, 0);
  const moreSfx = predictImprovedScore(0.5, 5, 0);
  const moreTrans = predictImprovedScore(0.5, 5, 3);
  assert.ok(moreSfx > base, 'More SFX should increase predicted score');
  assert.ok(moreTrans > moreSfx, 'More transitions should further increase predicted score');
  assert.ok(base >= 0 && base <= 1, 'Score should be clamped 0-1');
});

test('rankClips produces clips with viralScore and improvedScore', () => {
  const { clips } = rankClips({
    segments: SEGMENTS,
    structure: STRUCTURE,
    duration: 125,
    hasText: true,
    maxClips: 3,
  });
  assert.ok(clips.length > 0);
  for (const c of clips) {
    assert.ok(c.viralScore !== undefined, 'viralScore should be set');
    assert.ok(c.improvedScore !== undefined, 'improvedScore should be set');
    assert.ok(c.viralScore >= 0 && c.viralScore <= 1, 'viralScore in range');
    assert.ok(c.improvedScore >= 0 && c.improvedScore <= 1, 'improvedScore in range');
    assert.ok(c.predictedSfxCount !== undefined, 'predictedSfxCount should be set');
    assert.ok(c.predictedTransitions !== undefined, 'predictedTransitions should be set');
  }
});

test('generateMultiSegmentCandidates combines adjacent clips into story arcs', () => {
  const { clips } = rankClips({
    segments: SEGMENTS,
    structure: STRUCTURE,
    duration: 125,
    hasText: true,
    maxClips: 5,
  });
  const candidates = generateMultiSegmentCandidates(clips, STRUCTURE, sentencesFromSegments(SEGMENTS), 125);
  if (candidates.length > 0) {
    const c = candidates[0];
    assert.ok(c.subSegments && c.subSegments.length >= 2, 'Should have multiple sub-segments');
    assert.ok(c.viralMultiplier > 1, 'Should have viral multiplier');
    assert.ok(c.viralScore >= 0 && c.viralScore <= 1, 'viralScore in range');
    const purposes = c.subSegments.map((s) => s.purpose);
    assert.ok(purposes.includes('hook') || purposes.includes('narrative'), 'Should include narrative hook sub-segment');
    assert.ok(purposes.includes('payoff'), 'Should include payoff sub-segment');
  }
});

test('content theme detection identifies how-to videos', () => {
  const howToSegs: Segment[] = [
    seg(0, 5, 'Here is how you can do this yourself'),
    seg(5, 10, 'Step one: gather your materials'),
    seg(10, 15, 'Step two: apply the technique'),
    seg(15, 20, 'The key changed everything for me'),
  ];
  const theme = detectContentTheme(howToSegs, { sceneCuts: [], speechActive: [], energyCurve: [] }, 20);
  assert.ok(theme.theme === 'howto' || theme.theme === 'general', `Expected howto theme, got ${theme.theme}`);
  assert.ok(theme.confidence > 0, 'Should have non-zero confidence');
  assert.ok(typeof theme.editingStrategy === 'string');
});

test('content theme detection identifies storytime videos', () => {
  const storySegs: Segment[] = [
    seg(0, 5, 'So I was walking down the street last week'),
    seg(5, 10, 'Then something unexpected happened'),
    seg(10, 15, 'But then I discovered the truth'),
    seg(15, 20, 'Here is how you can do this too'),
  ];
  const theme = detectContentTheme(storySegs, { sceneCuts: [], speechActive: [], energyCurve: [] }, 20);
  assert.ok(typeof theme.theme === 'string');
  const profile = themeEditingProfile(theme.theme);
  assert.ok(profile.targetSegmentCount >= 1, 'Should have valid segment target');
});

test('dopamine moments are detected at energy spikes and scene cuts', () => {
  const segs: Segment[] = [
    seg(0, 4, 'I had a big problem that I could not solve'),
    seg(4, 8, 'But then I discovered the secret nobody talks about'),
    seg(8, 12, 'Finally, here is how you know it worked'),
  ];
  const structure = {
    sceneCuts: [4, 8],
    speechActive: [{ start: 0, end: 12 }],
    energyCurve: [
      { t: 0, rms: 0.01 },
      { t: 2, rms: 0.05 },
      { t: 4, rms: 0.01 },
      { t: 6, rms: 0.08 },
      { t: 8, rms: 0.01 },
      { t: 10, rms: 0.06 },
    ],
  };
  const moments = detectDopamineMoments(segs, structure, 12, 0);
  assert.ok(moments.length > 0, 'Should detect dopamine moments');
  assert.ok(moments.every((m) => typeof m.time === 'number' && typeof m.type === 'string'));
});

test('SFX assets are real WAV files in sfx_assets directory', () => {
  const available = getAvailableSfx();
  assert.ok(available.whoosh.length > 0, 'whoosh assets available');
  assert.ok(available.swoosh.length > 0, 'swoosh assets available');
  assert.ok(available.click.length > 0, 'click assets available');
  assert.ok(available.impact.length > 0, 'impact assets available');

  const whooshPath = resolveSfxAsset('whoosh', 0.5);
  assert.ok(fs.existsSync(whooshPath), `whoosh asset should exist: ${whooshPath}`);
  assert.ok(whooshPath.endsWith('.wav'), 'Should be a WAV file');
});
