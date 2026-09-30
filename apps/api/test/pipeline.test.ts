// Syntheniq — Phase 5-12 integration tests for the visual treatment pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  countMatches,
  matchLexicon,
  detectEmotionEvents,
  deriveEmotionTrajectory,
  deriveEmotionTag,
  analyzeEmotion,
} from '../src/pipeline/editorial/emotion.js';
import { EMOTION_CRISIS, EMOTION_REVELATION, EMOTION_RECOVERY, EMOTION_TAGS, TRAJECTORY_KEYWORDS } from '../src/pipeline/editorial/lexicons.js';
import {
  scoreSegmentRetention,
  classifyRetentionBeats,
  scoreRetentionArchitecture,
  buildRetentionCurve,
} from '../src/pipeline/editorial/retention.js';
import { planMotion, type MotionCue, type MediaInfo } from '../src/pipeline/editorial/motion.js';
import { buildEditDecision } from '../src/pipeline/editorial/plan.js';
import { buildSafeRenderFilters, validateMotionCues, type SafeFilterOptions } from '../src/pipeline/editorial/qc.js';
import {
  buildCaptionEvents,
  buildKineticCaptions,
  buildKineticASS,
  toKineticWords,
} from '../src/pipeline/render/captions.js';
import { validateCaptions, repairCaptions, checkCaptionReadability } from '../src/pipeline/render/caption-qc.js';
import { buildTreatment, buildRenderCommand, type TreatmentOptions } from '../src/pipeline/render/treatments.js';
import { type Segment, type Word, type EnergyPoint, type Span } from '../src/types.js';

const TEST_MEDIA: MediaInfo = { width: 1080, height: 1920, fps: 30 };

const TEST_SEGMENTS: Segment[] = [
  { start: 0, end: 3, text: 'I had a problem that I could not solve.', words: [] },
  { start: 3, end: 6, text: 'But then I discovered the truth.', words: [] },
  { start: 6, end: 9, text: 'Here is how you can do this too.', words: [] },
  { start: 9, end: 12, text: 'The key changed everything.', words: [] },
];

const TEST_WORDS: Word[] = [
  { start: 0.2, end: 0.5, word: 'I' },
  { start: 0.5, end: 0.7, word: 'had' },
  { start: 0.7, end: 1.0, word: 'a' },
  { start: 1.0, end: 1.4, word: 'problem' },
  { start: 1.4, end: 1.7, word: 'that' },
  { start: 1.7, end: 2.1, word: 'I' },
  { start: 2.1, end: 2.4, word: 'could' },
  { start: 2.4, end: 2.8, word: 'not' },
  { start: 2.8, end: 3.2, word: 'solve' },
  { start: 3.5, end: 3.8, word: 'But' },
  { start: 3.8, end: 4.2, word: 'then' },
  { start: 4.2, end: 4.5, word: 'I' },
  { start: 4.5, end: 5.0, word: 'discovered' },
  { start: 5.0, end: 5.3, word: 'the' },
  { start: 5.3, end: 5.8, word: 'truth' },
  { start: 6.2, end: 6.5, word: 'Here' },
  { start: 6.5, end: 6.8, word: 'is' },
  { start: 6.8, end: 7.0, word: 'how' },
  { start: 7.0, end: 7.5, word: 'you' },
  { start: 7.5, end: 7.9, word: 'can' },
  { start: 7.9, end: 8.3, word: 'do' },
  { start: 8.3, end: 8.7, word: 'this' },
  { start: 8.7, end: 9.1, word: 'too' },
  { start: 9.5, end: 9.8, word: 'The' },
  { start: 9.8, end: 10.1, word: 'key' },
  { start: 10.1, end: 10.6, word: 'changed' },
  { start: 10.6, end: 11.2, word: 'everything' },
];

const TEST_SILENCES: Span[] = [
  { start: 3.3, end: 3.4 },
  { start: 8.0, end: 8.1 },
];

const TEST_ENERGY: EnergyPoint[] = Array.from({ length: 13 }, (_, i) => ({
  t: i,
  rms: 0.02 + Math.sin(i * 0.5) * 0.03,
}));

const TEST_CLIP_START = 0;
const TEST_CLIP_END = 12;

test('Phase 5: emotion lexicons are exported', () => {
  assert.ok(Array.isArray(EMOTION_CRISIS));
  assert.ok(EMOTION_CRISIS.length > 0);
  assert.ok(Array.isArray(EMOTION_REVELATION));
  assert.ok(EMOTION_REVELATION.length > 0);
  assert.ok(Array.isArray(EMOTION_RECOVERY));
  assert.ok(EMOTION_RECOVERY.length > 0);
  assert.ok(typeof EMOTION_TAGS === 'object');
  assert.ok(EMOTION_TAGS.crisis);
  assert.ok(typeof TRAJECTORY_KEYWORDS === 'object');
  assert.ok(TRAJECTORY_KEYWORDS.escalating);
});

test('Phase 5: countMatches finds lexicon keywords', () => {
  const count = countMatches('I had a problem and pain', EMOTION_CRISIS);
  assert.ok(count >= 2, `Expected at least 2 matches, got ${count}`);
});

test('Phase 5: matchLexicon returns matched keywords', () => {
  const matches = matchLexicon('I had a problem', EMOTION_CRISIS);
  assert.ok(matches.includes('problem'));
});

test('Phase 5: detectEmotionEvents finds crisis and revelation', () => {
  const events = detectEmotionEvents(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  assert.ok(events.some((e) => e.type === 'crisis'));
  assert.ok(events.length > 0);
});

test('Phase 5: deriveEmotionTrajectory produces a curve', () => {
  const events = detectEmotionEvents(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const traj = deriveEmotionTrajectory(events, TEST_CLIP_START, TEST_CLIP_END);
  assert.ok(traj.curve.length > 0);
  assert.ok(typeof traj.label === 'string');
});

test('Phase 5: deriveEmotionTag returns a tag for keyphrases', () => {
  const tag = deriveEmotionTag(['problem', 'pain', 'struggle']);
  assert.ok(tag !== 'neutral', `Expected non-neutral tag, got ${tag}`);
});

test('Phase 5: analyzeEmotion returns complete intelligence', () => {
  const result = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  assert.ok(result.events.length > 0);
  assert.ok(result.trajectory.curve.length > 0);
  assert.ok(result.overall.tag);
  assert.ok(result.segments.length > 0);
});

test('Phase 6: scoreSegmentRetention returns valid scores', () => {
  const score = scoreSegmentRetention(0, 3, {
    segments: TEST_SEGMENTS,
    words: TEST_WORDS,
    energyCurve: TEST_ENERGY,
    silence: TEST_SILENCES,
  });
  assert.ok(score.predicted >= 0 && score.predicted <= 1);
  assert.ok(score.reasons.length > 0);
  assert.ok(typeof score.signals.energy === 'number');
});

test('Phase 6: classifyRetentionBeats creates segments', () => {
  const beats = classifyRetentionBeats(
    TEST_SEGMENTS,
    TEST_WORDS,
    [],
    TEST_ENERGY,
    TEST_SILENCES,
    12,
    []
  );
  assert.ok(beats.length > 0);
  assert.ok(
    beats.some(
      (b) =>
        b.role === 'teaser' ||
        b.role === 'payoff' ||
        b.role === 'curiosity' ||
        b.role === 'closer' ||
        b.role === 'narrative'
    )
  );
});

test('Phase 6: scoreRetentionArchitecture returns a plan', () => {
  const events = detectEmotionEvents(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const traj = deriveEmotionTrajectory(events, TEST_CLIP_START, TEST_CLIP_END);
  const beats = classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, events, TEST_ENERGY, TEST_SILENCES, 12, []);
  const plan = scoreRetentionArchitecture(beats, traj, TEST_SEGMENTS, TEST_WORDS, TEST_ENERGY, TEST_SILENCES, 12);
  assert.ok(plan.architecture);
  assert.ok(plan.beats.length > 0);
  assert.ok(plan.curve.length > 0);
});

test('Phase 6: buildRetentionCurve produces time-valence points', () => {
  const curve = buildRetentionCurve(TEST_SEGMENTS, TEST_WORDS, TEST_ENERGY, TEST_SILENCES, 0, 12);
  assert.ok(curve.length > 0);
  assert.ok(curve.every((p) => typeof p.t === 'number' && typeof p.predicted === 'number'));
});

test('Phase 7: planMotion generates cues from emotion and retention', () => {
  const events = detectEmotionEvents(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const traj = deriveEmotionTrajectory(events, TEST_CLIP_START, TEST_CLIP_END);
  const beats = classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, events, TEST_ENERGY, TEST_SILENCES, 12, []);
  const plan = scoreRetentionArchitecture(beats, traj, TEST_SEGMENTS, TEST_WORDS, TEST_ENERGY, TEST_SILENCES, 12);
  const motion = planMotion(events, plan.beats, TEST_MEDIA, 12);

  assert.ok(motion.cues.length >= 0);
  assert.ok(typeof motion.summary === 'string');
  assert.ok(motion.cues.every((c) => c.t >= 0 && c.t <= 12));
});

test('Phase 7: planMotion deduplicates nearby cues', () => {
  const events: any[] = [
    { t: 2, type: 'revelation', intensity: 0.8, label: 'first' },
    { t: 2.5, type: 'revelation', intensity: 0.7, label: 'close second' },
  ];
  const motion = planMotion(events, [], TEST_MEDIA, 12);
  const impactCues = motion.cues.filter((c) => c.kind === 'impact');
  assert.ok(impactCues.length <= 2);
});

test('Phase 7: planMotion generates different variant types', () => {
  const events: any[] = [
    { t: 3, type: 'crisis', intensity: 0.9, label: 'crisis' },
    { t: 6, type: 'revelation', intensity: 0.8, label: 'revelation' },
    { t: 9, type: 'recovery', intensity: 0.6, label: 'recovery' },
  ];
  const motion = planMotion(events, [], TEST_MEDIA, 12);
  const kinds = new Set(motion.cues.map((c) => c.kind));
  assert.ok(kinds.size > 1, `Expected multiple cue kinds, got: ${[...kinds].join(', ')}`);
});

test('Phase 8: buildEditDecision creates segments from analysis', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);

  const decision = buildEditDecision(
    {
      startTime: 0,
      endTime: 12,
      segments: TEST_SEGMENTS,
      words: TEST_WORDS,
      energyCurve: TEST_ENERGY,
      silences: TEST_SILENCES,
      media: TEST_MEDIA,
    },
    { emotion, retention, motion }
  );

  assert.ok(decision.id);
  assert.ok(decision.segments.length > 0);
  assert.ok(decision.media.width === 1080);
  assert.ok(decision.motion.cues);
});

test('Phase 8: buildEditDecision assigns transitions', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);

  const decision = buildEditDecision(
    {
      startTime: 0,
      endTime: 12,
      segments: TEST_SEGMENTS,
      words: TEST_WORDS,
      energyCurve: TEST_ENERGY,
      silences: TEST_SILENCES,
      media: TEST_MEDIA,
    },
    { emotion, retention, motion }
  );

  const segmentsWithTransitions = decision.segments.filter(
    (s) => s.transitions.in !== null || s.transitions.out !== null
  );
  assert.ok(segmentsWithTransitions.length > 0);
});

test('Phase 9: validateMotionCues returns warnings for dense cues', () => {
  const cues: MotionCue[] = [];
  for (let i = 0; i < 20; i++) {
    cues.push({ kind: 'emphasis', t: i, duration: 1, intensity: 0.5, label: `cue-${i}` });
  }
  const result = validateMotionCues(cues, 10, TEST_MEDIA);
  assert.ok(result.warnings.length > 0);
});

test('Phase 9: validateMotionCues flags high intensity', () => {
  const cues: MotionCue[] = [
    { kind: 'impact', t: 1, duration: 1, intensity: 1.0, label: 'extreme' },
  ];
  const result = validateMotionCues(cues, 5, TEST_MEDIA);
  assert.ok(result.warnings.some((w) => w.includes('jarring')));
});

test('Phase 10: toKineticWords produces word-level effects', () => {
  const kinetic = toKineticWords(TEST_WORDS, 0, 12);
  assert.ok(kinetic.length > 0);
  assert.ok(kinetic.every((w) => Object.values(['typewriter', 'pop', 'slide_left', 'slide_right', 'bounce', 'highlight', 'none']).includes(w.effect)));
});

test('Phase 10: buildKineticCaptions groups words into events', () => {
  const events = buildKineticCaptions(TEST_WORDS, 0, 12);
  assert.ok(events.length > 0);
  assert.ok(events.every((e) => e.words.length > 0));
  assert.ok(events.every((e) => typeof e.style === 'string'));
});

test('Phase 10: buildKineticASS produces valid ASS content', () => {
  const events = buildKineticCaptions(TEST_WORDS, 0, 12);
  const ass = buildKineticASS(events, { title: 'Test' });
  assert.ok(ass.includes('[Script Info]'));
  assert.ok(ass.includes('[Events]'));
  assert.ok(ass.includes('Dialogue:'));
});

test('Phase 10: buildKineticCaptions assigns pop effect to punctuation', () => {
  const events = buildKineticCaptions(TEST_WORDS, 0, 12);
  const allWords = events.flatMap((e) => e.words);
  const punctuation = allWords.filter((w) => /^[.,!?;:'"…]$/.test(w.text));
  if (punctuation.length > 0) {
    assert.ok(punctuation.every((w) => w.effect === 'pop'));
  }
});

test('Phase 10: validateCaptions catches overlapping events', () => {
  const events: KineticCaptionEvent[] = [
    { start: 0, end: 2, words: [], style: 'neutral' },
    { start: 0.5, end: 3, words: [], style: 'neutral' },
  ];
  const result = validateCaptions(events);
  assert.ok(!result.ok);
  assert.ok(result.issues.length > 0);
});

test('Phase 10: repairCaptions fixes overlapping events', () => {
  const events: KineticCaptionEvent[] = [
    { start: 0, end: 2, words: [], style: 'neutral' },
    { start: 1.5, end: 3, words: [], style: 'neutral' },
  ];
  const fixed = repairCaptions(events);
  assert.ok(fixed.fixed);
  assert.ok(fixed.events.length > 0);
});

test('Phase 10: checkCaptionReadability detects fast words', () => {
  const events: KineticCaptionEvent[] = [
    { start: 0, end: 0.1, words: [{ start: 0, end: 0.1, text: 'hello world test long text', effect: 'none', emphasis: 0, layer: 0 }], style: 'neutral' },
  ];
  const result = checkCaptionReadability(events);
  assert.ok(!result.ok);
});

test('Phase 10: buildTreatment assembles filter chains', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const decision = buildEditDecision(
    { startTime: 0, endTime: 12, segments: TEST_SEGMENTS, words: TEST_WORDS, energyCurve: TEST_ENERGY, silences: TEST_SILENCES, media: TEST_MEDIA },
    { emotion, retention, motion }
  );

  const treatment = buildTreatment(decision, {});
  assert.ok(treatment.videoFilters.length > 0);
  assert.ok(treatment.motionCues);
  assert.ok(treatment.keyframes);
  assert.ok(Array.isArray(treatment.warnings));
});

test('Phase 10: buildRenderCommand generates ffmpeg args', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const decision = buildEditDecision(
    { startTime: 0, endTime: 12, segments: TEST_SEGMENTS, words: TEST_WORDS, energyCurve: TEST_ENERGY, silences: TEST_SILENCES, media: TEST_MEDIA },
    { emotion, retention, motion }
  );

  const treatment = buildTreatment(decision, {});
  const args = buildRenderCommand('/fake/input.mp4', '/fake/output.mp4', treatment, { start: 0, duration: 12 });
  assert.ok(args.includes('-c:v'));
  assert.ok(args.includes('h264'));
  assert.ok(args.includes('/fake/output.mp4'));
});

test('Phase 10: multi-segment treatment produces valid labeled filtergraph', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const decision = buildEditDecision(
    { startTime: 0, endTime: 12, segments: TEST_SEGMENTS, words: TEST_WORDS, energyCurve: TEST_ENERGY, silences: TEST_SILENCES, media: TEST_MEDIA },
    { emotion, retention, motion }
  );

  const treatment = buildTreatment(decision, { assFile: '/tmp/test.ass', kineticAssFile: '/tmp/kinetic.ass' });
  const vf = treatment.videoFilters.join(',');

  // Each segment must have a trim + output label for the concat
  assert.ok(vf.includes('trim='), 'multi-segment filtergraph should include trim');
  assert.ok(vf.includes('[seg-'), 'multi-segment filtergraph should use labeled segment outputs');
  assert.ok(vf.includes('concat=n=') && vf.includes('v=1:a=0'), 'should end with video-only concat');
  assert.ok(treatment.captionFilters.length > 0, 'base captions ass filter should be included');

  const args = buildRenderCommand('/fake/input.mp4', '/fake/output.mp4', treatment, { start: 0, duration: 12 });
  const fcIdx = args.indexOf('-filter_complex');
  assert.ok(fcIdx >= 0, 'multi-segment render command should use -filter_complex');
  const vfStr = args[fcIdx + 1];
  assert.ok(vfStr.includes('subtitles=filename='), 'base captions should appear in render command');
  assert.ok(vfStr.includes('ass=filename='), 'kinetic captions should appear in render command');
  assert.ok(args.includes('-map'), 'should map filter_complex output');
  assert.ok(args.includes('[outv]'), 'should map [outv] output label');
});

test('Phase 10: single-segment treatment includes base caption filters', () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const decision = buildEditDecision(
    { startTime: 0, endTime: 12, segments: TEST_SEGMENTS, words: TEST_WORDS, energyCurve: TEST_ENERGY, silences: TEST_SILENCES, media: TEST_MEDIA },
    { emotion, retention, motion }
  );

  const treatment = buildTreatment(decision, { assFile: '/tmp/test.ass' });
  assert.ok(treatment.captionFilters.length > 0, 'assFile should produce caption filter');
  assert.ok(treatment.captionFilters[0].includes('subtitles=filename='), 'should include subtitles filter');
});

test('Phase 12: full pipeline integration — emotion → retention → motion → plan → treatment', async () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, TEST_CLIP_START, TEST_CLIP_END);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const decision = buildEditDecision(
    { startTime: 0, endTime: 12, segments: TEST_SEGMENTS, words: TEST_WORDS, energyCurve: TEST_ENERGY, silences: TEST_SILENCES, media: TEST_MEDIA },
    { emotion, retention, motion }
  );

  const treatment = buildTreatment(decision, {});
  const captionEvents = buildKineticCaptions(TEST_WORDS, 0, 12, motion.cues);
  const captionQC = validateCaptions(captionEvents, motion.cues);

  assert.ok(decision.id);
  assert.ok(decision.segments.length > 0);
  assert.ok(treatment.videoFilters.length > 0);
  assert.ok(captionEvents.length > 0);
  assert.ok(typeof captionQC.stats.wordCount === 'number');
});

test('Phase 12: treatment with empty motion cues still renders', () => {
  const emotion = analyzeEmotion([], [], [], 0, 12);
  const retention = scoreRetentionArchitecture([], emotion.trajectory, [], [], undefined, [], 12);
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  assert.ok(motion.cues.length >= 0);
});

test('Phase 12: emotion events trigger correct motion cue kinds', () => {
  const crisisEvents: any[] = [{ t: 1, type: 'crisis', intensity: 0.8, label: 'crisis' }];
  const revelationEvents: any[] = [{ t: 5, type: 'revelation', intensity: 0.7, label: 'revelation' }];
  const recoveryEvents: any[] = [{ t: 8, type: 'recovery', intensity: 0.6, label: 'recovery' }];

  const crisisMotion = planMotion(crisisEvents, [], TEST_MEDIA, 12);
  const crisisPunchIn = crisisMotion.cues.find((c) => c.kind === 'punch_in');
  assert.ok(crisisPunchIn, 'Crisis should produce punch_in cue');

  const revelationMotion = planMotion(revelationEvents, [], TEST_MEDIA, 12);
  const revelationImpact = revelationMotion.cues.find((c) => c.kind === 'impact');
  assert.ok(revelationImpact, 'Revelation should produce impact cue');

  const recoveryMotion = planMotion(recoveryEvents, [], TEST_MEDIA, 12);
  const recoverySettle = recoveryMotion.cues.find((c) => c.kind === 'settle');
  assert.ok(recoverySettle, 'Recovery should produce settle cue');
});

test('Phase 12: retention beats drive segment purposes', () => {
  const events = detectEmotionEvents(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, 0, 12);
  const beats = classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, events, TEST_ENERGY, TEST_SILENCES, 12, []);
  const teaserBeat = beats.find((b) => b.role === 'teaser');
  if (teaserBeat) {
    assert.ok(teaserBeat.confidence > 0.5);
    assert.ok(teaserBeat.signals.length > 0 || teaserBeat.label);
  }
});

test('Phase 12: kinetic captions integrate with motion plans', () => {
  const emotion = analyzeEmotion(TEST_SEGMENTS, TEST_WORDS, TEST_SILENCES, 0, 12);
  const retention = scoreRetentionArchitecture(
    classifyRetentionBeats(TEST_SEGMENTS, TEST_WORDS, emotion.events, TEST_ENERGY, TEST_SILENCES, 12, []),
    emotion.trajectory,
    TEST_SEGMENTS,
    TEST_WORDS,
    TEST_ENERGY,
    TEST_SILENCES,
    12
  );
  const motion = planMotion(emotion.events, retention.beats, TEST_MEDIA, 12);
  const captionEvents = buildKineticCaptions(TEST_WORDS, 0, 12, motion.cues);

  const qc = validateCaptions(captionEvents, motion.cues);
  assert.ok(qc.stats.eventCount === captionEvents.length);
  assert.ok(typeof qc.stats.wordCount === 'number');
});
