#!/usr/bin/env node
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
