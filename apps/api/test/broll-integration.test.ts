// Syntheniq — B-roll (cutaway overlay) integration tests.
// Exercises buildBRollFilters (geometry, layering, Ken Burns, fades, validation)
// and buildRenderCommand (filter_complex wiring, inputs, [base]->[outv] overlays).
// Hermetic: no network, no ffmpeg render; uses in-memory cue objects + string args.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBRollFilters, type BRollFilterResult } from '../src/pipeline/render/faces.js';
import { buildRenderCommand, type TreatmentResult } from '../src/pipeline/render/treatments.js';
import { EXPORT_SPEC } from '../src/pipeline/render/index.js';
import type { BRollCue } from '../src/types.js';

const W = EXPORT_SPEC.width; // 1080
const H = EXPORT_SPEC.height; // 1920

function cue(over: Partial<BRollCue>): BRollCue {
  return {
    id: 'c1',
    source: 'clip.mp4',
    clipStart: 0,
    clipEnd: 2,
    outStart: 1,
    outDuration: 2,
    ...over,
  };
}

function treatment(brollCues: BRollCue[]): TreatmentResult {
  return {
    videoFilters: [
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      'setsar=1',
      'format=yuv420p',
    ],
    audioFilters: [],
    captionFilter: null,
    captionFilters: [],
    motionCues: [],
    keyframes: [],
    brollCues,
    brollNotes: [],
    warnings: [],
  };
}

function renderArgs(b: BRollCue[]): string[] {
  return buildRenderCommand('main.mp4', '/tmp/out.mp4', treatment(b), { start: 0, duration: 10 }, [], [], false);
}

const opts = { baseLabel: '[base]', startInputIndex: 1, exportWidth: W, exportHeight: H, fps: EXPORT_SPEC.fps };

test('1. empty b-roll cues produce a plain -vf render (no filter_complex, no overlay)', () => {
  const r = buildBRollFilters([], opts);
  assert.equal(r.inputCount, 0);
  assert.equal(r.chains.length, 0);
  const args = renderArgs([]);
  assert.equal(args.includes('-filter_complex'), false);
  assert.ok(args.includes('-vf'), 'single-chain -vf path is used');
  assert.equal(args.includes('overlay'), false, 'no overlay without cues');
});

test('2. a valid single cue adds a b-roll input, overlay, and maps [outv]', () => {
  const args = renderArgs([cue({ id: 'c1', outStart: 1, outDuration: 2 })]);
  assert.equal(args.includes('-filter_complex'), true);
  assert.ok(args.includes('clip.mp4'), 'b-roll source is added as an -i input');
  const dashI = args.reduce((n, a) => n + (a === '-i' ? 1 : 0), 0);
  assert.equal(dashI, 2, 'main input + 1 b-roll input');
  assert.ok(args.join(' ').includes('overlay'), 'overlay filter is present');
  assert.ok(args.includes('[outv]'), 'final [outv] label is mapped');
});

test('3. invalid cues (zero-duration / degenerate clip window) are skipped with a note', () => {
  const bad = cue({ id: 'bad', clipStart: 2, clipEnd: 2, outStart: 0, outDuration: 0 });
  const r = buildBRollFilters([bad], opts);
  assert.ok(r.notes.some((n) => n.includes('Skipped')), r.notes.join(' | '));
  assert.equal(r.inputCount, 0);
  const args = renderArgs([bad]);
  assert.equal(args.includes('-filter_complex'), false, 'no overlay when all cues invalid -> degrades to -vf');
});

test('4. full-frame cutaway (no size) scales to the full export frame, centered at 0,0', () => {
  const r = buildBRollFilters([cue({ id: 'full' })], opts);
  assert.equal(r.inputCount, 1);
  assert.equal(r.chains.length, 2, 'prep + overlay per cue');
  const m = r.chains[0].match(/crop=(\d+):(\d+)/);
  assert.ok(m, 'prep crops to target dims: ' + r.chains[0]);
  assert.equal(Number(m![1]), W);
  assert.equal(Number(m![2]), H);
  const om = r.chains[1].match(/overlay=(\d+):(\d+)/);
  assert.ok(om, 'overlay is positioned: ' + r.chains[1]);
  assert.equal(Number(om![1]), 0);
  assert.equal(Number(om![2]), 0);
});

test('5. PiP inset sizes and positions the overlay', () => {
  const r = buildBRollFilters([cue({ id: 'pip', size: { width: 0.3, height: 0.4 }, position: { x: 0, y: 0 } })], opts);
  const cm = r.chains[0].match(/crop=(\d+):(\d+)/);
  assert.ok(cm, 'prep crops to inset dims: ' + r.chains[0]);
  assert.equal(Number(cm![1]), Math.round(0.3 * W));
  assert.equal(Number(cm![2]), Math.round(0.4 * H));
  const om = r.chains[1].match(/overlay=(\d+):(\d+)/);
  assert.ok(om, 'overlay is positioned: ' + r.chains[1]);
  assert.equal(Number(om![1]), 0);
  assert.equal(Number(om![2]), 0);
});

test('6. Ken Burns zoom enlarges the source beyond the target before cropping', () => {
  const r = buildBRollFilters([cue({ id: 'kb', kenBurns: { zoomStart: 1.0, zoomEnd: 1.5 } })], opts);
  const sm = r.chains[0].match(/scale=(\d+):(\d+)/);
  assert.ok(sm, 'prep scales the source: ' + r.chains[0]);
  assert.ok(Number(sm![1]) >= W, 'scale width exceeds export width (zoom applies)');
  assert.ok(Number(sm![2]) >= H, 'scale height exceeds export height (zoom applies)');
  const cm = r.chains[0].match(/crop=(\d+):(\d+)/);
  assert.ok(cm);
  assert.equal(Number(cm![1]), W);
  assert.equal(Number(cm![2]), H);
});

test('7. multiple cues layer in ascending layer order, last overlay emits [outv]', () => {
  const r = buildBRollFilters(
    [
      cue({ id: 'bg', layer: 0, outStart: 1, outDuration: 2 }),
      cue({ id: 'fg', layer: 1, outStart: 1, outDuration: 2 }),
    ],
    opts
  );
  assert.equal(r.inputCount, 2);
  assert.equal(r.chains.length, 4, '2 prep chains + 2 overlay chains');
  const firstOverlay = r.chains.find((c) => c.includes('overlay') && c.startsWith('[base]'));
  assert.ok(firstOverlay, 'first overlay composites on [base]');
  const last = r.chains[r.chains.length - 1];
  assert.ok(last.includes('[outv]'), 'last overlay emits [outv]: ' + last);
  assert.ok(r.chains[3].includes('[br0_ov]'), 'second overlay consumes the prior layer pad: ' + r.chains[3]);
});

test('8. fade in/out are applied as alpha fades on the overlay prep chain', () => {
  const r = buildBRollFilters([cue({ id: 'f', fade: { in: 0.3, out: 0.3 } })], opts);
  const prep = r.chains[0];
  assert.ok(prep.includes('fade=t=in:st=0:d=0.3:alpha=1'), 'fade-in present: ' + prep);
  assert.ok(prep.includes('fade=t=out'), 'fade-out present');
  // clipDur = 2, fade.out = 0.3 -> fade-out starts at clipDur - fade.out = 1.7
  assert.ok(prep.includes('st=1.7'), 'fade-out starts at clipDur - fade.out: ' + prep);
});
