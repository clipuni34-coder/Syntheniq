/**
 * qc-editorial.ts — editorial quality control + plan repair (spec §15, §19).
 *
 * Technical QC (render.ts) verifies the video is decodable. This module
 * verifies the EDIT is good: hook strength (something happens early), pacing
 * (no dead air between kept segments), effect budget (no cue overload), and
 * payoff placement (the major payoff lands in the back half). Issues trigger
 * trimOverload(), which revises the plan before render — a weak plan is
 * repaired, never just reported.
 *
 * Visual budget count = non-structural motion cues + graphics.
 * Structural cues (drift/settle/transition) are the baseline grammar and
 * don't spend budget.
 */
import type { ClipPlan, MotionCue, Plan } from './types.js';

export const EDITORIAL = {
  /** soft cap: above this, warn */
  maxVisual: 12,
  /** hard cap: above this, it's an issue → plan gets revised */
  hardVisual: 14,
  /** gap between kept segments longer than this is dead air (s) */
  maxDeadGap: 2.5,
  /** first on-screen cue must land within this of clip start (s) */
  maxHookGap: 1.5,
  /** major-payoff beat must sit at/after this fraction of the clip span */
  minPayoffPos: 0.55,
} as const;

const STRUCTURAL: MotionCue['kind'][] = ['drift', 'settle', 'transition'];

/** Budget spend of one clip: visible motion cues + graphics. */
export function visualCount(c: ClipPlan): number {
  const cues = (c.motion?.cues || []).filter((x) => !STRUCTURAL.includes(x.kind)).length;
  return cues + (c.graphics?.length || 0);
}

export interface EditorialReport {
  issues: string[]; // plan should be revised
  warnings: string[]; // acceptable, log for the record
}

export function editorialQc(plan: Plan): EditorialReport {
  const issues: string[] = [];
  const warnings: string[] = [];

  for (const c of plan.clips) {
    const span = c.sourceEnd - c.sourceStart;
    if (span <= 0) continue;

    // 1. effect budget (§15: ~4–12 meaningful cues per clip)
    const vc = visualCount(c);
    if (vc > EDITORIAL.hardVisual) issues.push(`${c.id}: ${vc} visual cues > ${EDITORIAL.hardVisual} — overload, trim`);
    else if (vc > EDITORIAL.maxVisual) warnings.push(`${c.id}: ${vc} visual cues > ${EDITORIAL.maxVisual} — busy`);

    // 2. pacing: dead air between kept segments
    for (let i = 1; i < c.segments.length; i++) {
      const gap = c.segments[i].start - c.segments[i - 1].end;
      if (gap > EDITORIAL.maxDeadGap)
        issues.push(`${c.id}: ${gap.toFixed(1)}s dead gap between segments (pacing hole)`);
    }

    // 3. hook strength: the first visible cue should land early
    const cueTs = [
      ...(c.motion?.cues || []).map((x) => x.t),
      ...(c.punchIns || []).map((x) => x.time),
      ...(c.callouts || []).map((x) => x.time),
      ...(c.graphics || []).map((x) => x.t),
    ];
    if (cueTs.length) {
      const first = Math.min(...cueTs) - c.sourceStart;
      if (first > EDITORIAL.maxHookGap)
        warnings.push(`${c.id}: first visual cue ${(first).toFixed(1)}s in — weak hook window`);
    } else {
      warnings.push(`${c.id}: no motion/graphics cues at all — flat edit`);
    }

    // 4. payoff placement: major payoff belongs in the back half
    const beats = c.retention?.beats || [];
    const payoff = beats.find((b) => b.role === 'major-payoff') || beats[beats.length - 1];
    if (payoff && beats.length > 1) {
      const rel = (payoff.t - c.sourceStart) / span;
      if (rel < EDITORIAL.minPayoffPos)
        warnings.push(`${c.id}: major payoff at ${(rel * 100).toFixed(0)}% of clip (want ≥ ${EDITORIAL.minPayoffPos * 100}%)`);
    }
  }

  return { issues, warnings };
}

/** Drop the lowest-value non-structural cues until the clip is under the hard cap. */
export function trimOverload(plan: Plan): boolean {
  let changed = false;
  for (const c of plan.clips) {
    const cues = c.motion?.cues;
    if (!cues) continue;
    // rank: pulse (most expendable) < impact < emphasis/lowerThird
    const rank = (k: MotionCue['kind']) => (k === 'pulse' ? 0 : k === 'impact' ? 2 : 3);
    let guard = 0;
    while (visualCount(c) > EDITORIAL.maxVisual && cues.length && guard++ < 32) {
      let idx = -1;
      let best = Infinity;
      cues.forEach((x, i) => {
        if (STRUCTURAL.includes(x.kind)) return;
        const r = rank(x.kind) + (x.intensity ?? 0.5) * 0.1;
        if (r < best) {
          best = r;
          idx = i;
        }
      });
      if (idx < 0) break; // only structural cues left
      cues.splice(idx, 1);
      changed = true;
    }
  }
  return changed;
}
