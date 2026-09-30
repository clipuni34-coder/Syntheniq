#!/usr/bin/env python3
"""reapply9 — cross-provider model-family guard (lost in reset #40 when
serve.sh's reapply chain re-wrote router.ts with a pre-fix copy, and the
reset itself rolled config.ts back).

  1. config.ts — MODEL_FAMILY + modelFitsProvider + modelForTask that only
     honors an explicit model (per-task or AI_MODEL) when its model family
     matches the provider being called; otherwise the provider's own tier
     default. Prevents AI_MODEL=gpt-* from 404'ing every gemini call
     (silent heuristic degradation).
  2. router.ts — same guard for REVIEW_MODEL + the import.
  3. test/model-routing.mjs — the 20/20 regression suite (full-file write).

Idempotent: patches assert anchors; full-file write compares content.
"""
import os, sys

ROOT = '/home/user/Syntheniq'


def patch(path, old, new, tag):
    p = os.path.join(ROOT, path)
    s = open(p).read()
    if new in s:
        print(f'  = {tag} (already applied)')
        return
    if old not in s:
        print(f'  ! {tag} ANCHOR MISSING — inspect {path}')
        sys.exit(1)
    s = s.replace(old, new, 1)
    open(p, 'w').write(s)
    print(f'  + {tag}')


def write(path, content, tag):
    p = os.path.join(ROOT, path)
    if os.path.exists(p) and open(p).read() == content:
        print(f'  = {tag} (already applied)')
        return
    open(p, 'w').write(content)
    print(f'  + {tag}')


# ── 1. config.ts ────────────────────────────────────────────────────────────
CFG_OLD = """/** Resolve the model for a task+provider given explicit config. */
export function modelForTask(cfg: AiConfig, task: TaskId, provider: ProviderId): string {
  return (
    cfg.taskModel[task] ||
    cfg.model ||
    DEFAULT_MODELS[provider][TASK_TIER[task]]
  );
}"""

CFG_NEW = """/** Model-name families each provider can actually serve (prefix match).
 *  Guards against the class of bug where a global AI_MODEL from one
 *  provider (e.g. gpt-5.6-luna) is forwarded to another provider (gemini)
 *  and every call 404s, silently degrading the whole chain to heuristic. */
const MODEL_FAMILY: Record<ProviderId, string[]> = {
  openai: ['gpt-', 'o1', 'o3', 'o4', 'chatgpt'],
  gemini: ['gemini-'],
  grok: ['grok-'],
};

export function modelFitsProvider(model: string, provider: ProviderId): boolean {
  const m = (model || '').toLowerCase();
  return MODEL_FAMILY[provider].some((fam) => m.startsWith(fam));
}

/** Resolve the model for a task+provider given explicit config.
 *  An explicit model (per-task or global AI_MODEL) is only honored when its
 *  model family belongs to the provider being called; otherwise the
 *  provider's own default for the task tier is used (graceful cross-provider
 *  semantics: AI_PROVIDER=gemini + AI_MODEL=gpt-* must not 404 on gemini). */
export function modelForTask(cfg: AiConfig, task: TaskId, provider: ProviderId): string {
  const explicit = cfg.taskModel[task] || cfg.model;
  if (explicit && modelFitsProvider(explicit, provider)) return explicit;
  return DEFAULT_MODELS[provider][TASK_TIER[task]];
}"""

patch('apps/api/src/config.ts', CFG_OLD, CFG_NEW, 'config.ts model-family guard')

# ── 2. router.ts ────────────────────────────────────────────────────────────
RT_IMPORT_OLD = """import {
  DEFAULT_MODELS,
  modelForTask,"""
RT_IMPORT_NEW = """import {
  DEFAULT_MODELS,
  modelFitsProvider,
  modelForTask,"""
patch('apps/api/src/ai/router.ts', RT_IMPORT_OLD, RT_IMPORT_NEW, 'router.ts import')

RT_REVIEW_OLD = """    for (const p of chain) {
      const model = this.cfg.reviewModel || modelForTask(this.cfg, task, p);"""
RT_REVIEW_NEW = """    for (const p of chain) {
      // review model is only honored when its family matches this provider,
      // otherwise fall through to modelForTask (which family-checks too)
      const model =
        this.cfg.reviewModel && modelFitsProvider(this.cfg.reviewModel, p)
          ? this.cfg.reviewModel
          : modelForTask(this.cfg, task, p);"""
patch('apps/api/src/ai/router.ts', RT_REVIEW_OLD, RT_REVIEW_NEW, 'router.ts review-model guard')

TEST_GOLDEN = "#!/usr/bin/env node\n/**\n * model-routing.mjs \u2014 regression tests for cross-provider model resolution.\n *\n * Guards the bug class where a global AI_MODEL from one provider (e.g.\n * AI_MODEL=gpt-5.6-luna with AI_PROVIDER=gemini) was forwarded verbatim to\n * the other provider, 404'ing every call and silently degrading the whole\n * AI chain to heuristic. Explicit models are now honored only when their\n * model family matches the provider being called.\n *\n * Run: node test/model-routing.mjs   (exits non-zero on any failure)\n */\nimport { DEFAULT_MODELS, modelForTask, modelFitsProvider } from '../dist/config.js';\n\nlet pass = 0;\nlet fail = 0;\nfunction ok(cond, label) {\n  if (cond) {\n    pass++;\n    console.log('ok   ' + label);\n  } else {\n    fail++;\n    console.log('FAIL ' + label);\n  }\n}\nfunction cfg(over = {}) {\n  return {\n    primary: null,\n    model: null,\n    fallback: [],\n    taskProvider: {},\n    taskModel: {},\n    reviewProvider: null,\n    reviewModel: null,\n    ...over,\n  };\n}\n\n// 1. No explicit model \u2192 per-provider defaults (deep tier = analyze/plan, fast = package)\nok(modelForTask(cfg(), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep, 'gemini analyze \u2192 gemini deep default');\nok(modelForTask(cfg(), 'package', 'gemini') === DEFAULT_MODELS.gemini.fast, 'gemini package \u2192 gemini fast default');\nok(modelForTask(cfg(), 'analyze', 'openai') === DEFAULT_MODELS.openai.deep, 'openai analyze \u2192 openai deep default');\nok(modelForTask(cfg(), 'analyze', 'grok') === DEFAULT_MODELS.grok.deep, 'grok analyze \u2192 grok default');\n\n// 2. Explicit model matching the provider \u2192 honored (normal case, behavior unchanged)\nok(modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'analyze', 'openai') === 'gpt-5.6-luna', 'AI_MODEL=gpt-5.6-luna on openai \u2192 honored');\nok(modelForTask(cfg({ model: 'gemini-3.8-flash' }), 'analyze', 'gemini') === 'gemini-3.8-flash', 'AI_MODEL=gemini-3.8-flash on gemini \u2192 honored');\n\n// 3. THE REGRESSION: explicit model from another provider \u2192 provider's own default\nok(\n  modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep,\n  'REGRESSION: AI_MODEL=gpt-5.6-luna on gemini \u2192 gemini deep default (not gpt-5.6-luna)'\n);\nok(\n  modelForTask(cfg({ model: 'gpt-5.6-luna' }), 'package', 'gemini') === DEFAULT_MODELS.gemini.fast,\n  'REGRESSION: AI_MODEL=gpt-5.6-luna on gemini (fast task) \u2192 gemini fast default'\n);\nok(\n  modelForTask(cfg({ model: 'gemini-3.8-flash' }), 'analyze', 'openai') === DEFAULT_MODELS.openai.deep,\n  'REGRESSION: AI_MODEL=gemini-3.8-flash on openai \u2192 openai deep default'\n);\nok(\n  modelForTask(cfg({ model: 'gpt-5.6-terra' }), 'analyze', 'grok') === DEFAULT_MODELS.grok.deep,\n  'REGRESSION: AI_MODEL=gpt-5.6-terra on grok \u2192 grok default'\n);\n\n// 4. Per-task model: honored when it fits, ignored (\u2192 global or default) when it does not\nok(\n  modelForTask(cfg({ taskModel: { analyze: 'gemini-3.8-flash' } }), 'analyze', 'gemini') === 'gemini-3.8-flash',\n  'task model gemini-3.8-flash on gemini \u2192 honored'\n);\nok(\n  modelForTask(cfg({ taskModel: { analyze: 'gpt-5.6-terra' } }), 'analyze', 'gemini') === DEFAULT_MODELS.gemini.deep,\n  'task model gpt-5.6-terra on gemini \u2192 ignored, gemini default'\n);\nok(\n  modelForTask(cfg({ model: 'gpt-5.6-luna', taskModel: { analyze: 'gemini-3.8-flash' } }), 'analyze', 'gemini') === 'gemini-3.8-flash',\n  'task model beats global when task model fits'\n);\nok(\n  modelForTask(cfg({ model: 'gpt-5.6-luna', taskModel: { analyze: 'gemini-3.8-flash' } }), 'plan', 'openai') === 'gpt-5.6-luna',\n  'non-overridden task falls back to global model (fits openai)'\n);\n\n// 5. Family detection basics\nok(modelFitsProvider('gpt-5.6-luna', 'openai') === true, 'gpt-5.6-luna fits openai');\nok(modelFitsProvider('GPT-5.6-LUNA', 'openai') === true, 'case-insensitive family match');\nok(modelFitsProvider('gpt-5.6-luna', 'gemini') === false, 'gpt-5.6-luna does not fit gemini');\nok(modelFitsProvider('gemini-3.5-flash-lite', 'gemini') === true, 'gemini-3.5-flash-lite fits gemini');\nok(modelFitsProvider('grok-4.6', 'grok') === true, 'grok-4.6 fits grok');\nok(modelFitsProvider('', 'gemini') === false, 'empty model fits nothing');\n\nconsole.log(`model-routing: ${pass} pass, ${fail} fail`);\nprocess.exit(fail ? 1 : 0);\n"

TEST_PATH = os.path.join(ROOT, 'apps/api/test/model-routing.mjs')
write('apps/api/test/model-routing.mjs', TEST_GOLDEN, 'test/model-routing.mjs')

print('reapply9 done')
