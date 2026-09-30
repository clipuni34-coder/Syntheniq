#!/usr/bin/env node
/**
 * regression.mjs — §20 diagnostic harness. 4/4 must PASS.
 *
 * Four synthetic clips driven through the REAL pipeline stages
 * (prep-media → composition → lint → hyperframes render → qc):
 *
 *   A: 0 B-roll, 30fps, 4.0s — baseline: captions, hook, CTA
 *   B: 1 B-roll, 60fps, 5.0s — tracking emphasis + impact (emotion)
 *   C: multi B-roll + graphics (stat + list) + callouts, 30fps, 6.0s —
 *      audio-reactive pulse, lower third, transition
 *   D: 2 segments with a cut (transition), punch-in, 30fps, 4.0s comp
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..', '..');

// self-heal env (node22 + ffmpeg-static + chrome libs)
const TOOLS = path.resolve(ROOT, '..', 'tools');
const nodeBin = path.join(TOOLS, 'node-v22.14.0-linux-x64', 'bin');
const ff = path.join(TOOLS, 'ffmpeg-static');
const libs = path.join(TOOLS, 'chrome-libs', 'libs');
if (existsSync(nodeBin)) process.env.PATH = `${nodeBin}:${process.env.PATH}`;
if (existsSync(ff)) process.env.PATH = `${ff}:${process.env.PATH}`;
if (existsSync(libs)) process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const { prepClipMedia } = await import('../dist/pipeline/prep.js');
const { generateComposition } = await import('../dist/pipeline/compose.js');
const { lintComposition, renderComposition, qcClip } = await import('../dist/pipeline/render.js');

const WORK = path.join(ROOT, '.cache', 'regression');
const quiet = () => {};
let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass++;
    console.log(`    ok  ${name}`);
  } else {
    fail++;
    console.log(`    FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/* ── synthetic source (8s, 1080x1920, tone audio) ─────────────────────── */
function sourceValid(file) {
  try {
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
    return true;
  } catch {
    return false;
  }
}
async function makeSource(fps, file) {
  if (await fs.stat(file).then(() => true, () => false) && sourceValid(file)) return file;
  await fs.mkdir(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', [
    '-y', '-v', 'error',
    '-f', 'lavfi', '-i', `testsrc2=size=1080x1920:rate=${fps}:duration=8`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-shortest', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file,
  ], { maxBuffer: 16 * 1024 * 1024 });
  return file;
}

/* ── transcript fixture (words every 0.4s) ────────────────────────────── */
const WORDS = ['editing', 'workflow', 'first', 'thing', 'doubled', 'watch', 'time', 'second', 'captions', 'pace', 'fast', 'follow'];
function transcriptFor() {
  const segments = [];
  for (let i = 0; i < 20; i++) {
    const start = i * 0.4;
    segments.push({
      start,
      end: start + 0.35,
      text: `${WORDS[i % WORDS.length]} ${WORDS[(i + 3) % WORDS.length]}`,
      words: [
        { start, end: start + 0.17, word: WORDS[i % WORDS.length], isFiller: false },
        { start: start + 0.18, end: start + 0.35, word: WORDS[(i + 3) % WORDS.length], isFiller: false },
      ],
    });
  }
  return { duration: 8, language: 'en', segments };
}

const keyphrases = [
  { text: 'workflow', times: [0.4] },
  { text: 'watch time', times: [2.2] },
];

const baseClip = (o) => ({
  id: 'clip-x',
  sourceStart: 1,
  sourceEnd: 5,
  hookText: 'THE TEST HOOK',
  segments: [{ start: 1, end: 5 }],
  punchIns: [],
  cutaways: [],
  callouts: [],
  cta: { text: 'FOLLOW FOR MORE', style: 'simple' },
  music: 'none',
  energy: 0.5,
  thumbnail: { sourceTime: 2, text: 'HOOK' },
  title: 'Test clip',
  variants: [],
  motion: { cues: [], style: { tempo: 'steady' } },
  retention: { architecture: 'chronological-hook-escalation-final-revelation', rationale: 'test', beats: [
    { t: 1, role: 'hook', note: 'h' }, { t: 3, role: 'micro-payoff', note: 'm' }, { t: 4.5, role: 'major-payoff', note: 'M' },
  ] },
  ...o,
});

async function runCase(name, { fps, clip, expect }) {
  console.log(`  case ${name}:`);
  const media = { path: await makeSource(fps, path.join(WORK, `src${fps}.mp4`)), duration: 8, fps, width: 1080, height: 1920, hasAudio: true, codec: 'h264' };
  const projectDir = path.join(WORK, `case-${name}`);
  await fs.rm(projectDir, { recursive: true, force: true });
  await fs.mkdir(projectDir, { recursive: true });
  const transcript = transcriptFor();

  const t0 = Date.now();
  const spec = await prepClipMedia(clip, 0, media, projectDir, quiet);
  const compDir = path.join(projectDir, 'comp', clip.id);
  await fs.mkdir(path.join(projectDir, 'comp'), { recursive: true });
  await generateComposition(spec, path.join(projectDir, 'media', clip.id), compDir, transcript, keyphrases, 0);
  await lintComposition(compDir, quiet);
  const out = path.join(WORK, `out-${name}.mp4`);
  await renderComposition(compDir, out, spec.fps, quiet);
  const qc = await qcClip(out, spec.totalDur, spec.fps);

  // composition content assertions
  const readHtml = async (f) => { try { return await fs.readFile(f, 'utf8'); } catch { return ''; } };
  const rootHtml = await readHtml(path.join(compDir, 'index.html'));
  const fxHtml = await readHtml(path.join(compDir, 'compositions', 'fx.html'));
  const allHtml = rootHtml + fxHtml;
  const capLines = (allHtml.match(/class="cap-line"/g) || []).length;
  const cutCount = (rootHtml.match(/<video id="cut\d+"/g) || []).length;
  const segCount = (rootHtml.match(/<video id="seg\d+"/g) || []).length;
  const gfxCount = (fxHtml.match(/class="gfx /g) || []).length;

  check(`render+qc pass (${((Date.now() - t0) / 1000).toFixed(0)}s)`, qc.ok, qc.issues.join('; '));
  check('captions present', capLines >= 3, `${capLines} lines`);
  expect({ spec, rootHtml, fxHtml, allHtml, capLines, cutCount, segCount, gfxCount, qc });
}

console.log('regression harness (§20): 4 synthetic clips through prep→compose→render→qc');
await fs.mkdir(WORK, { recursive: true });

// A — 0 B-roll, 30fps, 4.0s baseline
await runCase('A', {
  fps: 30,
  clip: baseClip({ id: 'clip-x' }),
  expect: ({ cutCount, spec }) => {
    check('A: zero B-roll', cutCount === 0, `${cutCount} cutaways`);
    check('A: length 4.0s @30fps', Math.abs(spec.totalDur - 4.0) < 0.05 && spec.fps === 30, `${spec.totalDur}s @${spec.fps}`);
  },
});

// B — 1 B-roll, 60fps, 5.0s, tracking emphasis + impact
await runCase('B', {
  fps: 60,
  clip: baseClip({
    id: 'clip-x', sourceStart: 2, sourceEnd: 7, segments: [{ start: 2, end: 7 }],
    cutaways: [{ sourceTime: 0, duration: 1.5, reason: 'harness b-roll' }],
    motion: { cues: [
      { kind: 'emphasis', t: 3, variant: 'tracking', text: 'first', reason: 'keyphrase' },
      { kind: 'impact', t: 5, intensity: 0.8, reason: 'emotional peak' },
    ], style: { tempo: 'energetic', emotion: 'excited' } },
  }),
  expect: ({ cutCount, spec, allHtml }) => {
    check('B: exactly one B-roll', cutCount === 1, `${cutCount} cutaways`);
    check('B: 60fps output', spec.fps === 60, `${spec.fps}fps`);
    check('B: tracking emphasis wired', allHtml.includes('mgt'), 'no per-glyph tracking spans');
  },
});

// C — multi B-roll + graphics + callouts, 30fps, 6.0s
await runCase('C', {
  fps: 30,
  clip: baseClip({
    id: 'clip-x', sourceStart: 1, sourceEnd: 7, segments: [{ start: 1, end: 7 }],
    cutaways: [
      { sourceTime: 7.0, duration: 0.8, reason: 'harness b-roll 1' },
      { sourceTime: 0.0, duration: 1.2, reason: 'harness b-roll 2' },
    ],
    callouts: [{ time: 2.2, text: 'KEY IDEA', style: 'stat' }],
    graphics: [
      { type: 'stat', t: 3, value: '2x', title: 'watch time', reason: 'spoken multiplier' },
      { type: 'list', t: 5, title: '2 key points', items: ['First', 'Second'], reason: 'spoken list' },
    ],
    motion: { cues: [
      { kind: 'pulse', t: 1.6, reason: 'audio-reactive' },
      { kind: 'lowerThird', t: 2.0, text: 'THE WORKFLOW', reason: 'topic bar' },
    ], style: { tempo: 'steady' } },
  }),
  expect: ({ cutCount, gfxCount, fxHtml, spec }) => {
    check('C: two B-rolls', cutCount === 2, `${cutCount} cutaways`);
    check('C: both graphic panels rendered', gfxCount === 2, `${gfxCount} gfx`);
    check('C: stat value in composition', fxHtml.includes('2x'), 'no "2x"');
    check('C: callout in composition', fxHtml.includes('KEY IDEA'), 'no callout');
    check('C: length 6.0s', Math.abs(spec.totalDur - 6.0) < 0.05, `${spec.totalDur}s`);
  },
});

// D — 2 segments (cut/transition), punch-in, impact, 30fps, 4.0s comp
await runCase('D', {
  fps: 30,
  clip: baseClip({
    id: 'clip-x', sourceStart: 1, sourceEnd: 6, segments: [{ start: 1, end: 3.5 }, { start: 4.5, end: 6 }],
    punchIns: [{ time: 2, zoom: 1.15, reason: 'punch on number' }],
    motion: { cues: [{ kind: 'impact', t: 2.2, intensity: 0.7, reason: 'peak' }], style: { tempo: 'energetic' } },
  }),
  expect: ({ segCount, spec }) => {
    check('D: two segments rendered', segCount === 2, `${segCount} segs`);
    check('D: structural transition present', spec.motion.some((m) => m.kind === 'transition'), 'no transition cue');
    check('D: punch-in placed', spec.punchIns.length === 1, `${spec.punchIns.length} punchIns`);
    check('D: comp length 4.0s (1.0s gap cut by design)', Math.abs(spec.totalDur - 4.0) < 0.05, `${spec.totalDur}s`);
  },
});

console.log(`\nregression: ${pass}/${pass + fail} checks pass, ${fail} fail (cases A-D)`);
process.exit(fail ? 1 : 0);
