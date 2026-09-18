#!/usr/bin/env node
/**
 * model-routing.mjs — regression tests for cross-provider model resolution.
 *
 * Guards the bug class where a global AI_MODEL from one provider (e.g.
 * AI_MODEL=gpt-5.6-luna with AI_PROVIDER=gemini) was forwarded verbatim to
 * the other provider, 404'ing every call and silently degrading the whole
 * AI chain to heuristic. Explicit models are now honored only when their
 * model family matches the provider being called.
 *
 * Run: node test/model-routing.mjs   (exits non-zero on any failure)
 */
import { DEFAULT_MODELS, modelForTask, modelFitsProvider } from '../dist/config.js';

let pass = 0;
let fail = 0;
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('ok   ' + label);
  } else {
    fail++;
    console.log('FAIL ' + label);
  }
}
function cfg(over = {}) {
  return {
    primary: null,
    model: null,
    fallback: [],
    taskProvider: {},
    taskModel: {},
    reviewProvider: null,
    reviewModel: null,
    ...over,
  };
}

// 1. No explicit model → per-provider defaults (deep tier = analyze/plan, fast = package)
ok(modelForTask(cfg(), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep, 'gemini analyze → gemini deep default');
ok(modelForTask(cfg(), 'package', 'gemini') === DEFAULT_MODELS.gemini.fast, 'gemini package → gemini fast default');
ok(modelForTask(cfg(), 'analyze', 'openai') === DEFAULT_MODELS.openai.deep, 'openai analyze → openai deep default');
ok(modelForTask(cfg(), 'analyze', 'grok') === DEFAULT_MODELS.grok.deep, 'grok analyze → grok default');

// 2. Explicit model matching the provider → honored (normal case, behavior unchanged)
ok(modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'analyze', 'openai') === 'gpt-5.6-luna', 'AI_MODEL=gpt-5.6-luna on openai → honored');
ok(modelForTask(cfg({ model: 'gemini-3.8-flash' }), 'analyze', 'gemini') === 'gemini-3.8-flash', 'AI_MODEL=gemini-3.8-flash on gemini → honored');

// 3. THE REGRESSION: explicit model from another provider → provider's own default
ok(
  modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep,
  'REGRESSION: AI_MODEL=gpt-5.6-luna on gemini → gemini deep default (not gpt-5.6-luna)'
);
ok(
  modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'package', 'gemini') === DEFAULT_MODELS.gemini.fast,
  'REGRESSION: AI_MODEL=gpt-5.6-luna on gemini (fast task) → gemini fast default'
);
ok(
  modelForTask(cfg({ model: 'gemini-3.8-flash' }), 'analyze', 'openai') === DEFAULT_MODELS.openai.deep,
  'REGRESSION: AI_MODEL=gemini-3.8-flash on openai → openai deep default'
);
ok(
  modelForTask(cfg({ model: 'gpt-5.6-terra' }), 'analyze', 'grok') === DEFAULT_MODELS.grok.deep,
  'REGRESSION: AI_MODEL=gpt-5.6-terra on grok → grok default'
);

// 4. Per-task model: honored when it fits, ignored (→ global or default) when it does not
ok(
  modelForTask(cfg({ taskModel: { analyze: 'gemini-3.8-flash' } }), 'analyze', 'gemini') === 'gemini-3.8-flash',
  'task model gemini-3.8-flash on gemini → honored'
);
ok(
  modelForTask(cfg({ taskModel: { analyze: 'gpt-5.6-terra' } }), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep,
  'task model gpt-5.6-terra on gemini → ignored, gemini default'
);
ok(
  modelForTask(cfg({ model: 'gpt-5.6-luna', taskModel: { analyze: 'gemini-3.8-flash' } }), 'analyze', 'gemini') === 'gemini-3.8-flash',
  'task model beats global when task model fits'
);
ok(
  modelForTask(cfg({ model: 'gpt-5.6-luna', taskModel: { analyze: 'gemini-3.8-flash' } }), 'plan', 'openai') === 'gpt-5.6-luna',
  'non-overridden task falls back to global model (fits openai)'
);

// 5. Family detection basics
ok(modelFitsProvider('gpt-5.6-luna', 'openai') === true, 'gpt-5.6-luna fits openai');
ok(modelFitsProvider('GPT-5.6-LUNA', 'openai') === true, 'case-insensitive family match');
ok(modelFitsProvider('gpt-5.6-luna', 'gemini') === false, 'gpt-5.6-luna does not fit gemini');
ok(modelFitsProvider('gemini-3.5-flash-lite', 'gemini') === true, 'gemini-3.5-flash-lite fits gemini');
ok(modelFitsProvider('grok-4.6', 'grok') === true, 'grok-4.6 fits grok');
ok(modelFitsProvider('', 'gemini') === false, 'empty model fits nothing');

console.log(`model-routing: ${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
