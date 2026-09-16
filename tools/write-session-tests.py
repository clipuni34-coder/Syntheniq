#!/usr/bin/env python3
"""Write the session's NEW test files (deleted by resets). Idempotent.
Covers: apps/api/test/failover-check.mjs, apps/api/test/regression.mjs
Run: python3 tools/write-session-tests.py
"""
import os

ROOT = '/home/user/Syntheniq'

FILES = {}

FILES['apps/api/test/failover-check.mjs'] = r'''#!/usr/bin/env node
/**
 * failover-check — provider failover semantics (spec §4). 9/9 must PASS.
 *
 *   1. no keys            → chain is heuristic-only; call() returns heuristic
 *   2. key present        → auto-picked primary is that provider
 *   3. per-task override  → explicit task provider leads the chain
 *   4. fallback config    → fallback provider sits after primary
 *   5. provider fails     → next configured provider serves the call
 *   6. all providers fail → local heuristic serves the call (job never dies)
 *   7. failed provider    → cools down and is skipped by the next call
 *   8. cooldown clears    → provider is retried after clearCooldown
 *   9. status()           → correct mode/flags, never leaks key material
 */
import { AiRouter } from '../dist/ai/router.js';
import { AiError } from '../dist/ai/types.js';
import { callHeuristic } from '../dist/ai/heuristic.js';

let pass = 0;
let fail = 0;
function check(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const KEYS = ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'XAI_API_KEY'];
const saved = {};
for (const k of KEYS) {
  saved[k] = process.env[k];
  delete process.env[k];
}
const restore = () => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
};

const makeCfg = (o = {}) => ({
  primary: null,
  model: null,
  fallback: [],
  taskProvider: {},
  taskModel: {},
  reviewProvider: null,
  reviewModel: null,
  ...o,
});
const makeRouter = (cfg, signals) => {
  const logs = [];
  return { r: new AiRouter(cfg, (m) => logs.push(m), signals), logs };
};

const signals = {
  media: { duration: 60, fps: 30, width: 1080, height: 1920, hasAudio: true, codec: 'h264' },
  transcript: {
    duration: 60,
    language: 'en',
    segments: [
      { start: 0, end: 10, text: 'Welcome back, today we look at editing.', words: [] },
      { start: 10, end: 20, text: 'The first thing I changed was my workflow.', words: [] },
      { start: 20, end: 30, text: 'It doubled my watch time in a month.', words: [] },
      { start: 30, end: 40, text: 'The second thing is captions and pacing.', words: [] },
      { start: 40, end: 50, text: 'Follow for more every week.', words: [] },
    ],
  },
  silences: [{ start: 9.5, end: 10.5 }],
  energy: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50].map((t, i) => ({ t, rms: 0.25 + i * 0.03 })),
  analysis: null, // filled below (heuristic analyze output)
};
// pre-compute analysis with the heuristic itself (keeps this test key-free)
signals.analysis = callHeuristic({ task: 'analyze', system: 's', input: 'i', json: true }, signals).json;

const REQ = { task: 'plan', system: 'system', input: 'input', json: true };
const ok = (p) => ({ text: '{}', json: { clips: [] }, provider: p, model: 'test-model', latencyMs: 1 });

console.log('failover-check (spec §4):');

// 1 — no keys → heuristic-only chain
{
  const { r } = makeRouter(makeCfg(), signals);
  const chain = r.chainFor('plan');
  const res = await r.call(REQ);
  check('1. no keys → heuristic chain + heuristic result', chain.length === 1 && chain[0] === 'heuristic' && res.provider === 'heuristic', `chain=${chain}`);
}

// 2 — key present → auto-picked primary
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  const { r } = makeRouter(makeCfg(), signals);
  check('2. auto-picked primary = gemini', r.primaryProvider() === 'gemini', `got ${r.primaryProvider()}`);
  delete process.env.GEMINI_API_KEY;
}

// 3 — per-task override leads the chain
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.XAI_API_KEY = 'test-key-456';
  const { r } = makeRouter(makeCfg({ taskProvider: { plan: 'grok' } }), signals);
  const chain = r.chainFor('plan');
  check('3. per-task provider leads chain', chain[0] === 'grok', `chain=${chain}`);
}

// 4 — fallback sits after primary
{
  const { r } = makeRouter(makeCfg({ primary: 'gemini', fallback: ['openai'] }), signals);
  const chain = r.chainFor('plan');
  check(
    '4. fallback after primary',
    chain[0] === 'gemini' && chain.indexOf('openai') > chain.indexOf('gemini'),
    `chain=${chain}`,
  );
}

// 5 — gemini fails → openai serves
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.OPENAI_API_KEY = 'test-key-123';
  const { r, logs } = makeRouter(makeCfg({ primary: 'gemini', fallback: ['openai'] }), signals);
  r.invoke = async (p) => {
    if (p === 'gemini') throw new AiError('simulated 503', true, 503);
    return ok(p);
  };
  const res = await r.call(REQ);
  check('5. provider failure → next provider serves', res.provider === 'openai', `res=${res.provider} logs=${logs.join(' | ')}`);
}

// 6 — all providers fail → heuristic serves (job never dies)
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.OPENAI_API_KEY = 'test-key-123';
  process.env.XAI_API_KEY = 'test-key-123';
  const { r, logs } = makeRouter(makeCfg({ primary: 'gemini', fallback: ['openai', 'grok'] }), signals);
  r.invoke = async () => {
    throw new AiError('simulated outage', true, 500);
  };
  let res;
  let threw = null;
  try {
    res = await r.call(REQ);
  } catch (e) {
    threw = e.message;
  }
  check('6. all providers fail → heuristic result (no throw)', !threw && res.provider === 'heuristic', `threw=${threw} provider=${res && res.provider}`);
}

// 7 — failed provider cools down, next call skips it
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.OPENAI_API_KEY = 'test-key-123';
  const { r, logs } = makeRouter(makeCfg({ primary: 'gemini', fallback: ['openai'] }), signals);
  let geminiAttempts = 0;
  r.invoke = async (p) => {
    if (p === 'gemini') {
      geminiAttempts++;
      throw new AiError('simulated 503', true, 503);
    }
    return ok(p);
  };
  await r.call(REQ); // gemini fails → openai
  const attemptsAfterFirst = geminiAttempts;
  await r.call(REQ); // gemini should be skipped (cooldown)
  const skipped = attemptsAfterFirst === geminiAttempts && logs.some((l) => l.includes('cooling down'));
  check('7. failed provider cools down and is skipped', skipped, `attempts=${geminiAttempts} logs=${logs.join(' | ')}`);
}

// 8 — clearCooldown lets the provider be retried
{
  process.env.GEMINI_API_KEY = 'test-key-123';
  process.env.OPENAI_API_KEY = 'test-key-123';
  const { r } = makeRouter(makeCfg({ primary: 'gemini', fallback: ['openai'] }), signals);
  let geminiUp = false;
  r.invoke = async (p) => {
    if (p === 'gemini') {
      if (!geminiUp) throw new AiError('down', true, 503);
      return ok(p);
    }
    return ok(p);
  };
  const first = await r.call(REQ); // gemini down → openai
  geminiUp = true;
  r.clearCooldown('gemini');
  const second = await r.call(REQ); // gemini up again → gemini serves
  check('8. clearCooldown → provider retried and recovers', first.provider === 'openai' && second.provider === 'gemini', `first=${first.provider} second=${second.provider}`);
}

// 9 — status(): mode + configured flags, no key leakage
{
  process.env.OPENAI_API_KEY = 'sk-super-secret-value-9876';
  const { r } = makeRouter(makeCfg(), signals);
  const st = r.status();
  const dumped = JSON.stringify(st);
  const noLeak = !dumped.includes('sk-super-secret-value-9876');
  const modeOk = st.mode === 'ai' && st.providers.find((p) => p.id === 'openai')?.configured === true;
  check('9. status() mode/flags correct, no key leak', noLeak && modeOk, `mode=${st.mode} leak=${!noLeak}`);
}

restore();
console.log(`\nfailover-check: ${pass}/9 pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
'''

FILES['apps/api/test/regression.mjs'] = r'''#!/usr/bin/env node
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
'''

print('write-session-tests...')
written = 0
for rel, content in FILES.items():
    p = os.path.join(ROOT, rel)
    if os.path.exists(p) and open(p).read() == content:
        print(f'  = {rel} (unchanged)')
        continue
    os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, 'w').write(content)
    written += 1
    print(f'  + {rel}')
print(f'done ({written} written)')
