#!/usr/bin/env python3
"""Re-apply the Syntheniq session work (graphics, editorial QC, failover,
packaging, tests) after a sandbox reset reverts the source tree.
Idempotent: each patch asserts its anchor; a missing anchor means the
patch is already applied or the base changed — it prints and skips."""
import os, sys

ROOT = '/home/user/Syntheniq'
API = os.path.join(ROOT, 'apps', 'api')

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
    os.makedirs(os.path.dirname(p), exist_ok=True)
    if os.path.exists(p) and open(p).read() == content:
        print(f'  = {tag} (unchanged)')
        return
    open(p, 'w').write(content)
    print(f'  + {tag}')

print('patching...')

# ── 1. types.ts ─────────────────────────────────────────────────────────
patch('apps/api/src/pipeline/types.ts',
"// Shared pipeline data structures (persisted as JSON under the project dir).",
"// Shared pipeline data structures (persisted as JSON under the project dir).\nimport type { Graphic } from './graphics.js';",
'types: import Graphic')
patch('apps/api/src/pipeline/types.ts',
"export interface ClipMeta {\n  title: string;\n  caption: string; // generic",
"export interface ClipMeta {\n  title: string;\n  /** The narrative angle: 'Mistake → Fix', 'List / how-to', 'Progression', 'Personal story', … */\n  angle: string;\n  caption: string; // generic",
'types: ClipMeta.angle')
patch('apps/api/src/pipeline/types.ts',
"export interface ClipPackage {\n  title: string;\n  captions: { tiktok: string; instagram: string; youtube: string };",
"export interface ClipPackage {\n  title: string;\n  angle: string;\n  captions: { tiktok: string; instagram: string; youtube: string };",
'types: ClipPackage.angle')
patch('apps/api/src/pipeline/types.ts',
"  motion?: MotionPlan; // motion-graphics cues (source timeline)\n  retention?: Retention; // retention architecture (beats + optional cold-open teaser)",
"  motion?: MotionPlan; // motion-graphics cues (source timeline)\n  retention?: Retention; // retention architecture (beats + optional cold-open teaser)\n  graphics?: Graphic[]; // editorial visual-storytelling graphics (source timeline)",
'types: ClipPlan.graphics')

# ── 2. prompts.ts ───────────────────────────────────────────────────────
patch('apps/api/src/pipeline/prompts.ts',
'      "index": 0,\n      "title": "<=95 chars, curiosity-led, no clickbait lies",',
'      "index": 0,\n      "angle": "the narrative angle, one of: \'Mistake → Fix (before/after)\' | \'List / how-to\' | \'Progression (numbers move)\' | \'Personal story\' | \'Direct value / tip\'",\n      "title": "<=95 chars, curiosity-led, a COMPLETE sentence — never a mid-sentence fragment, no clickbait lies",',
'prompts: PACKAGE_SYSTEM angle')

# ── 3. package.ts ───────────────────────────────────────────────────────
patch('apps/api/src/pipeline/package.ts',
"    const hook = c.hookText;\n    return {\n      title: String(r.title || c.title || hook).slice(0, 95),",
"    const hook = c.hookText;\n    return {\n      title: String(r.title || c.title || hook).slice(0, 95),\n      angle: String(r.angle || 'Direct value / tip').slice(0, 120),",
'package: meta angle')
patch('apps/api/src/pipeline/package.ts',
"    return {\n      title: metas[i].title,\n      captions: {",
"    return {\n      title: metas[i].title,\n      angle: metas[i].angle,\n      captions: {",
'package: package angle')

# ── 4. jobs.ts ──────────────────────────────────────────────────────────
patch('apps/api/src/jobs.ts',
"""  done(msg: string): void {
    this.state.status = 'done';
    this.state.progress = 1;
    if (this.state.stages['complete']) this.state.stages['complete'] = { status: 'done', progress: 1, detail: msg };
    this.log('info', `pipeline ${msg}`);
  }""",
"""  done(msg: string): void {
    this.state.status = 'done';
    this.state.progress = 1;
    this.state.error = undefined; // a retried-to-success must not keep showing the old error
    if (this.state.stages['complete']) this.state.stages['complete'] = { status: 'done', progress: 1, detail: msg };
    this.log('info', `pipeline ${msg}`);
  }""",
'jobs: done() clears error')

print('core patches done')
