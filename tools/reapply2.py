#!/usr/bin/env python3
"""Re-apply session integration patches: plan→prep→compose→index→render.
Idempotent (asserts anchors; skips if already applied)."""
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

print('integration patches...')

# ── plan.ts ─────────────────────────────────────────────────────────────
patch('apps/api/src/pipeline/plan.ts',
"""import { deriveRetention } from '../ai/heuristic.js';""",
"""import { deriveRetention } from '../ai/heuristic.js';
import { detectGraphics } from './graphics.js';""",
'plan: import detectGraphics')

patch('apps/api/src/pipeline/plan.ts',
"""import type { Analysis, ClipPlan, MediaInfo, MotionCue, Plan, Retention, RetentionBeat, RetentionBeatRole, Transcript } from './types.js';""",
"""import type { Graphic } from './graphics.js';
import type { Analysis, ClipPlan, MediaInfo, MotionCue, Plan, Retention, RetentionBeat, RetentionBeatRole, Transcript } from './types.js';""",
'plan: import Graphic type')

patch('apps/api/src/pipeline/plan.ts',
"""  const beatCues = deriveBeatCues(retention.beats, motion.cues, ctx.transcript);
  const motionFinal = beatCues.length
    ? { style: motion.style, cues: [...motion.cues, ...beatCues].sort((a, b) => a.t - b.t) }
    : motion;

  return {""",
"""  const beatCues = deriveBeatCues(retention.beats, motion.cues, ctx.transcript);
  const motionFinal = beatCues.length
    ? { style: motion.style, cues: [...motion.cues, ...beatCues].sort((a, b) => a.t - b.t) }
    : motion;

  // ── visual storytelling: detect moments that EARN an on-screen graphic ──
  // Deterministic detectors re-derive values from the transcript (LLM numbers
  // are never trusted). An enumeration may complete in the segment right after
  // its opener ("the first thing…" → "the second thing is…"), so the next
  // kept segment is offered as context when the cut gap is small.
  const graphics: Graphic[] = [];
  const tx = ctx.transcript;
  if (tx) {
    const segText = (s: { start: number; end: number }) =>
      tx.segments.filter((sg) => sg.end > s.start + 0.05 && sg.start < s.end - 0.05).map((sg) => sg.text).join(' ');
    for (let k = 0; k < kept.length && graphics.length < 4; k++) {
      const s = kept[k];
      const text = segText(s);
      const words = tx.segments
        .filter((sg) => sg.end > s.start + 0.05 && sg.start < s.end - 0.05)
        .flatMap((sg) => sg.words);
      if (!words.length || !text.trim()) continue;
      const next = k + 1 < kept.length ? kept[k + 1] : undefined;
      const after = next && next.start - s.end < 6 ? { text: segText(next), t: next.start } : undefined;
      const g = detectGraphics(text, s.start, words, after);
      if (g) graphics.push(g);
    }
  }

  return {""",
'plan: graphics detection')

patch('apps/api/src/pipeline/plan.ts',
"""    motion: motionFinal,
    retention,
  };
}""",
"""    motion: motionFinal,
    retention,
    ...(graphics.length ? { graphics } : {}),
  };
}""",
'plan: return graphics')

# ── prep.ts ─────────────────────────────────────────────────────────────
patch('apps/api/src/pipeline/prep.ts',
"""import { buildSpecMotion } from './motion.js';""",
"""import { buildSpecMotion } from './motion.js';
import type { Graphic } from './graphics.js';""",
'prep: import Graphic')

patch('apps/api/src/pipeline/prep.ts',
"""  motion: MotionCue[]; // comp-time motion cues (visual + SFX)
  motionStyle: MotionStyle;
}""",
"""  motion: MotionCue[]; // comp-time motion cues (visual + SFX)
  motionStyle: MotionStyle;
  graphics: (Graphic & { compTime: number })[]; // visual-storytelling graphics (comp time)
}""",
'prep: CompSpec.graphics')

patch('apps/api/src/pipeline/prep.ts',
"""    .map((p) => ({ compTime: Math.max(0.2, Math.min(p.compTime, totalDur - 1.6)), zoom: p.zoom }))
    .sort((a, b) => a.compTime - b.compTime);

  // ── motion-graphics cues (comp time; gap cues dropped) ────────────────""",
"""    .map((p) => ({ compTime: Math.max(0.2, Math.min(p.compTime, totalDur - 1.6)), zoom: p.zoom }))
    .sort((a, b) => a.compTime - b.compTime);

  // ── visual-storytelling graphics (source → comp time; cut-away ones drop) ──
  const graphics: (Graphic & { compTime: number })[] = (clip.graphics ?? [])
    .map((g): (Graphic & { compTime: number }) | null => {
      const ct = srcToComp(segments, g.t);
      if (ct == null) return null; // the moment that earned it was cut
      return { ...g, compTime: Math.max(0.4, Math.min(ct, totalDur - 3.3)) }; // full display (incl. exit) must fit
    })
    .filter((g): g is Graphic & { compTime: number } => g != null)
    .slice(0, 4);

  // ── motion-graphics cues (comp time; gap cues dropped) ────────────────""",
'prep: graphics declaration (before SFX)')

patch('apps/api/src/pipeline/prep.ts',
"""  onLog(`[prep] ${clip.id}: ${segments.length} segments, ${totalDur.toFixed(1)}s comp, ${cutaways.length} cutaways, ${punchIns.length} punch-ins, ${motion.length} motion cues`);""",
"""  onLog(`[prep] ${clip.id}: ${segments.length} segments, ${totalDur.toFixed(1)}s comp, ${cutaways.length} cutaways, ${punchIns.length} punch-ins, ${motion.length} motion cues, ${graphics.length} graphics`);""",
'prep: log graphics count')

patch('apps/api/src/pipeline/prep.ts',
"""    else if (c.kind === 'transition' && c.variant === 'wipe') push('whoosh', c.t - 0.08, 0.18);
  }""",
"""    else if (c.kind === 'transition' && c.variant === 'wipe') push('whoosh', c.t - 0.08, 0.18);
  }
  for (const g of graphics) {
    if (g.type === 'stat' || g.type === 'progress') push('pop', g.compTime, 0.3);
  }""",
'prep: graphic SFX')

patch('apps/api/src/pipeline/prep.ts',
"""    audioFile: mixedFile,
    motion,
    motionStyle,
  };
}""",
"""    audioFile: mixedFile,
    motion,
    motionStyle,
    graphics,
  };
}""",
'prep: return graphics')

# ── index.ts ────────────────────────────────────────────────────────────
patch('apps/api/src/pipeline/index.ts',
"""import { lintComposition, qcClip, renderComposition } from './render.js';""",
"""import { lintComposition, qcClip, renderComposition } from './render.js';
import { editorialQc, trimOverload } from './qc-editorial.js';""",
'index: import editorial QC')

patch('apps/api/src/pipeline/index.ts',
"""  job.setPlan(plan);
  log(
    'info',
    `plan: ${plan.clips.length} clips via ${planProviders.plan}${planProviders.review ? ` (review: ${planProviders.review})` : ''} — ${plan.clips
      .map((c) => `${c.id}[${c.sourceStart.toFixed(0)}-${c.sourceEnd.toFixed(0)}s]`)
      .join(' ')}`,
  );
  await checkCancelled(job);

  // ── clip state ───────────────────────────────────────────────────────""",
"""  job.setPlan(plan);
  log(
    'info',
    `plan: ${plan.clips.length} clips via ${planProviders.plan}${planProviders.review ? ` (review: ${planProviders.review})` : ''} — ${plan.clips
      .map((c) => `${c.id}[${c.sourceStart.toFixed(0)}-${c.sourceEnd.toFixed(0)}s]`)
      .join(' ')}`,
  );

  // ── editorial QC: pacing, hook strength, effect budget, payoff (spec §19) ─
  const edq = editorialQc(plan);
  for (const w of edq.warnings) log('warn', `editorial: ${w}`);
  for (const iss of edq.issues) log('warn', `editorial: ${iss}`);
  if (edq.issues.length) {
    // revise the plan and continue — a weak plan is repaired, never just reported
    const trimmed = trimOverload(plan);
    if (trimmed) {
      await fs.writeFile(planPath, JSON.stringify(plan, null, 1));
      job.setPlan(plan);
      log('info', 'editorial: plan revised (overloaded cues trimmed) — continuing');
    }
  } else if (!edq.warnings.length) {
    log('info', 'editorial: plan clean (hook, pacing, visual budget, payoff placement)');
  }
  await checkCancelled(job);

  // ── clip state ───────────────────────────────────────────────────────""",
'index: editorial QC stage')

# ── render.ts ───────────────────────────────────────────────────────────
patch('apps/api/src/pipeline/render.ts',
"""const pexecFile = promisify(execFile);
""",
"""const pexecFile = promisify(execFile);

/**
 * Self-healing environment for the hyperframes CLI — survives sandbox resets
 * that wipe /tmp, node_modules, and extracted toolchains:
 *  - PATH: the Node >= 22 bin (hyperframes hard-requires it; the system node
 *    may be 20) + ffmpeg-static on PATH for ffprobe/ffmpeg lookups
 *  - LD_LIBRARY_PATH: headless Chrome's system libs (no apt in sandbox)
 */
function toolEnv(): NodeJS.ProcessEnv {
  const tools = path.join(ROOT, '..', 'tools');
  const nodeBin = path.join(tools, 'node-v22.14.0-linux-x64', 'bin');
  const ff = path.join(tools, 'ffmpeg-static');
  const libs = path.join(tools, 'chrome-libs', 'libs');
  const has = (p: string) => { try { accessSync(p); return true; } catch { return false; } };
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (has(nodeBin)) env.PATH = `${nodeBin}${path.delimiter}${env.PATH || ''}`;
  if (has(ff)) env.PATH = `${ff}${path.delimiter}${env.PATH || ''}`;
  if (has(libs)) env.LD_LIBRARY_PATH = [libs, env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter);
  return env;
}
""",
'render: toolEnv self-heal')

# version-drift guard: render.ts later moved from execFile to a detached
# spawn (hung-render watchdog) — the toolEnv() line is the stable marker.
_render = open(os.path.join(ROOT, 'apps/api/src/pipeline/render.ts')).read()
if 'env: { ...toolEnv(), TMPDIR: hfTmp }' in _render:
    print('  = render: env uses toolEnv (already applied)')
else:
    patch('apps/api/src/pipeline/render.ts',
    """        env: { ...process.env, TMPDIR: hfTmp },
      },
    );""",
    """        env: { ...toolEnv(), TMPDIR: hfTmp },
      },
    );""",
    'render: env uses toolEnv')

print('integration patches done')
