import type { AiRouter } from '../ai/router.js';
import type { Graphic } from './graphics.js';
import type { Analysis, ClipPlan, MediaInfo, MotionCue, Plan, Retention, RetentionBeat, RetentionBeatRole, Transcript } from './types.js';
import { PLAN_SYSTEM, REVIEW_SYSTEM, analysisForPrompt, transcriptText } from './prompts.js';
import { deriveEditorialCues, sanitizeMotionCues, tempoFor } from './motion.js';
import { deriveRetention } from '../ai/heuristic.js';
import { detectGraphics } from './graphics.js';

interface MotionCtx {
  energy: { t: number; rms: number }[];
  analysis: Analysis;
  transcript?: Transcript;
}

/**
 * Stage: clip planning — the editor's brain.
 * LLM proposes clipCount + edit decisions (incl. motion-graphics cues);
 * code validates and repairs strictly; an optional independent second-pass
 * review (different provider) can revise.
 */
export async function runPlan(
  router: AiRouter,
  media: MediaInfo,
  transcript: Transcript,
  analysis: Analysis,
  energy: { t: number; rms: number }[] = [],
): Promise<{ plan: Plan; providers: { plan: string; review?: string } }> {
  const input = [
    `Media: ${media.duration.toFixed(1)}s, ${media.fps}fps, ${media.width}x${media.height}.`,
    'Story analysis (JSON):\n' + analysisForPrompt(analysis),
    'Transcript with times:\n' + transcriptText(transcript, 40000),
    'Produce the clip plan now. Decide how many clips are genuinely usable.',
  ].join('\n\n');

  const res = await router.call({
    task: 'plan',
    system: PLAN_SYSTEM,
    input,
    json: true,
    maxTokens: 12000,
    temperature: 0.3,
  });
  const ctx: MotionCtx = { energy, analysis, transcript };
  let plan = validatePlan(res.json, media.duration, ctx) as Plan;

  // ── second-pass review (independent model) ────────────────────────────
  let reviewProvider: string | undefined;
  const reviewInput = [
    `Media: ${media.duration.toFixed(1)}s, ${media.fps}fps.`,
    'Story analysis (JSON):\n' + analysisForPrompt(analysis).slice(0, 12000),
    'Transcript (may be truncated):\n' + transcriptText(transcript, 24000),
    'Proposed plan (JSON):\n' + JSON.stringify(plan, null, 1),
  ].join('\n\n');
  const review = await router.callReview('plan', {
    task: 'plan',
    system: REVIEW_SYSTEM,
    input: reviewInput,
    json: true,
    maxTokens: 12000,
    temperature: 0.2,
  }, res.provider === 'heuristic' ? null : res.provider);

  if (review && review.json) {
    const r = review.json as any;
    reviewProvider = `${review.provider}/${review.model}`;
    if (r.approved === false && r.revised && typeof r.revised === 'object') {
      const revised = validatePlan(r.revised, media.duration, ctx);
      if (revised && revised.clips.length >= 1) {
        router.log?.(`review: revised plan accepted (${revised.clips.length} clips) — ${String(r.feedback ?? '').slice(0, 300)}`);
        plan = revised;
      } else {
        router.log?.(`review: suggested revision failed validation, keeping original. Feedback: ${String(r.feedback ?? '').slice(0, 300)}`);
      }
    } else {
      router.log?.(`review: plan approved (${String(r.feedback ?? '').slice(0, 200)})`);
    }
  }

  plan.clips.forEach((c, i) => (c.id = `clip-${i + 1}`));
  return { plan, providers: { plan: `${res.provider}/${res.model}`, review: reviewProvider } };
}

// ── validation / repair ────────────────────────────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

export function validatePlan(raw: unknown, duration: number, ctx: MotionCtx): Plan | null {
  const p = (raw || {}) as any;
  if (!Array.isArray(p.clips) || !p.clips.length) return null;

  const clips: ClipPlan[] = [];
  for (const c of p.clips.slice(0, 8)) {
    const clip = repairClip(c, duration, ctx);
    if (clip) clips.push(clip);
  }
  if (!clips.length) return null;

  // chronological order
  clips.sort((a, b) => a.sourceStart - b.sourceStart);
  // resolve overlaps: truncate the earlier clip
  for (let i = 0; i < clips.length - 1; i++) {
    if (clips[i].sourceEnd > clips[i + 1].sourceStart + 0.5) {
      clips[i].sourceEnd = clips[i + 1].sourceStart;
      clips[i].segments = clips[i].segments.filter((s) => s.end <= clips[i].sourceEnd + 0.01);
      clips[i].punchIns = clips[i].punchIns.filter((x) => x.time <= clips[i].sourceEnd);
      clips[i].thumbnail.sourceTime = clamp(clips[i].thumbnail.sourceTime, clips[i].sourceStart, Math.max(clips[i].sourceStart, clips[i].sourceEnd));
      const kept = keptDuration(clips[i]);
      if (kept < 12) clips.splice(i, 1);
      i--;
    }
  }

  // drop clips whose kept content is too thin to be usable
  const usable = clips.filter((c) => keptDuration(c) >= 15);
  const plan: Plan = {
    clipCount: Math.min(6, usable.length),
    clips: usable.slice(0, 6),
    notes: typeof p.notes === 'string' ? p.notes : undefined,
  };
  return plan.clips.length ? plan : null;
}

function keptDuration(c: { segments: { start: number; end: number }[] }): number {
  return c.segments.reduce((a, s) => a + (s.end - s.start), 0);
}

function repairClip(raw: any, duration: number, ctx: MotionCtx): ClipPlan | null {
  if (typeof raw !== 'object' || raw === null) return null;
  let start = num(raw.sourceStart, 0);
  let end = num(raw.sourceEnd, 0);
  start = clamp(start, 0, duration);
  end = clamp(end, 0, duration);
  if (end - start < 12) return null; // never a usable clip
  if (end - start > 150) end = start + 150;

  // segments: sanitize
  const rawSegs: unknown[] = Array.isArray(raw.segments) ? raw.segments : [];
  let segments: { start: number; end: number }[] = rawSegs
    .map((s: any) => ({ start: num(s.start), end: num(s.end) }))
    .map((s) => ({ start: clamp(s.start, start, end), end: clamp(s.end, start, end) }))
    .filter((s) => s.end - s.start >= 0.2)
    .sort((a, b) => a.start - b.start);
  // de-overlap
  const merged: { start: number; end: number }[] = [];
  for (const s of segments) {
    if (merged.length && s.start < merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(merged[merged.length - 1].end, s.end);
    } else merged.push({ ...s });
  }
  // drop micro segments, keep span coverage
  let kept = merged.filter((s) => s.end - s.start >= 0.4);
  if (!kept.length) kept = [merged[0] || { start, end }];
  const coverage = kept.reduce((a, s) => a + (s.end - s.start), 0) / (end - start);
  if (coverage < 0.55 && merged.length) {
    // AI cut too much — restore the largest removed gap
    const gaps: { start: number; end: number }[] = [];
    let cursor = start;
    for (const s of kept) {
      if (s.start - cursor > 0.3) gaps.push({ start: cursor, end: s.start });
      cursor = s.end;
    }
    if (end - cursor > 0.3) gaps.push({ start: cursor, end });
    gaps.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    if (gaps[0]) {
      kept.push(gaps[0]);
      kept.sort((a, b) => a.start - b.start);
    }
  }

  const inKept = (t: number) => kept.some((s) => t >= s.start - 0.05 && t <= s.end + 0.05);

  const rawPunchIns: unknown[] = Array.isArray(raw.punchIns) ? raw.punchIns : [];
  const punchIns = rawPunchIns
    .slice(0, 4)
    .map((x: any) => ({ time: num(x.time), zoom: clamp(num(x.zoom, 1.12), 1.05, 1.4), reason: String(x.reason ?? '') }))
    .filter((x) => inKept(x.time));

  const rawCutaways: unknown[] = Array.isArray(raw.cutaways) ? raw.cutaways : [];
  const cutaways = rawCutaways
    .slice(0, 3)
    .map((x: any) => ({ sourceTime: clamp(num(x.sourceTime), 0, duration), duration: clamp(num(x.duration, 1.5), 0.8, 3), reason: String(x.reason ?? '') }))
    .filter((x) => Math.abs(x.sourceTime - start) > 4 || x.sourceTime > end); // not from the clip itself

  const rawCallouts: unknown[] = Array.isArray(raw.callouts) ? raw.callouts : [];
  const callouts = rawCallouts
    .slice(0, 3)
    .map((x: any) => ({ time: clamp(num(x.time), start, end), text: String(x.text ?? '').slice(0, 40).toUpperCase(), style: ['label', 'stat', 'quote'].includes(x.style) ? x.style : 'label' }))
    .filter((x) => x.text.length >= 2 && inKept(x.time));

  const music = ['chill', 'drive', 'none'].includes(raw.music) ? raw.music : 'chill';
  const hookText = String(raw.hookText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const ctaText = String(raw.cta?.text ?? raw.cta ?? 'Follow for more').slice(0, 80);
  const thumbT = clamp(num(raw.thumbnail?.sourceTime, (start + end) / 2), start, end);
  const thumbText = String(raw.thumbnail?.text ?? hookText.slice(0, 32) ?? 'WATCH THIS').slice(0, 48);
  const title = String(raw.title ?? hookText).slice(0, 120);
  const rawVariants: unknown[] = Array.isArray(raw.variants) ? raw.variants : [];
  const variants = rawVariants
    .slice(0, 3)
    .map((v: any) => ({
      hookText: v.hookText ? String(v.hookText).slice(0, 80) : undefined,
      title: v.title ? String(v.title).slice(0, 120) : undefined,
      note: v.note ? String(v.note).slice(0, 160) : undefined,
    }))
    .filter((v: any) => v.hookText || v.title);

  if (!hookText || !segments.length) return null;

  const energy = clamp(num(raw.energy, 0.5), 0, 1);
  // motion cues: trust a validated AI proposal, otherwise derive from signals
  const aiMotion = sanitizeMotionCues(raw.motion, start, end);
  const motion =
    aiMotion && aiMotion.cues.length
      ? aiMotion
      : {
          cues: deriveEditorialCues({
            start,
            end,
            segments: kept,
            energy: ctx.energy,
            keyphrases: ctx.analysis.keyphrases,
            punchIns,
            topics: ctx.analysis.topics,
            music,
            energyLevel: energy,
          }),
          style: tempoFor(energy),
        };

  // retention: trust a valid AI architecture, otherwise derive from signals
  const retention = sanitizeRetention(raw.retention, start, end, kept) ?? deriveRetention(start, end, kept, { energy: ctx.energy, transcript: ctx.transcript! }, ctx.analysis);

  // the retention beat map paces the on-screen rhythm — "something valuable
  // is still coming": a curiosity tick, a spoken-word reward at the
  // micro-payoff, an impact at the major payoff. Each is deduplicated
  // against cues already placed (no double effects, never decorative).
  const beatCues = deriveBeatCues(retention.beats, motion.cues, ctx.transcript);
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

  return {
    id: String(raw.id ?? ''),
    sourceStart: r2(start),
    sourceEnd: r2(end),
    hookText,
    segments: kept.map((s) => ({ start: r2(s.start), end: r2(s.end) })),
    punchIns: punchIns.map((x) => ({ time: r2(x.time), zoom: Math.round(x.zoom * 100) / 100, reason: x.reason.slice(0, 80) })),
    cutaways,
    callouts,
    cta: { text: ctaText || 'Follow for more', style: 'simple' },
    music,
    energy,
    thumbnail: { sourceTime: r2(thumbT), text: thumbText },
    title: title || hookText,
    variants,
    motion: motionFinal,
    retention,
    ...(graphics.length ? { graphics } : {}),
  };
}

/** Motion cues derived from the retention beat map (the "value is coming"
 *  rhythm). Strictly capped and deduplicated so it never clutters:
 *  - curiosity      -> one subtle pulse tick (a shift is coming)
 *  - micro-payoff   -> one underline on the spoken word (a small reward lands)
 *  - major-payoff   -> one impact if no impact already marks the peak */
function deriveBeatCues(
  beats: RetentionBeat[],
  existing: MotionCue[],
  transcript: Transcript | undefined,
): MotionCue[] {
  const out: MotionCue[] = [];
  const near = (kind: string, t: number, dt: number) =>
    existing.some((c) => c.kind === kind && Math.abs(c.t - t) < dt) || out.some((c) => c.kind === kind && Math.abs(c.t - t) < dt);
  for (const b of beats) {
    if (b.role === 'curiosity' && !near('pulse', b.t, 0.8) && !out.some((c) => c.kind === 'pulse')) {
      out.push({ kind: 'pulse', t: b.t, intensity: 0.5, reason: 'curiosity beat — a shift is coming' });
    } else if (
      b.role === 'micro-payoff' &&
      !near('impact', b.t, 0.8) &&
      !out.some((c) => c.kind === 'emphasis') &&
      !existing.some((c) => c.kind === 'emphasis' && Math.abs(c.t - b.t) < 0.8)
    ) {
      const word = spokenWordAt(transcript, b.t);
      if (word) out.push({ kind: 'emphasis', t: b.t, variant: 'underline', text: word, reason: 'micro-payoff — reward on the spoken word' });
    } else if (b.role === 'major-payoff' && !near('impact', b.t, 1.0) && !out.some((c) => c.kind === 'impact') && existing.filter((c) => c.kind === 'impact').length < 2) {
      out.push({ kind: 'impact', t: b.t, intensity: 0.8, reason: 'major payoff — the reward moment' });
    }
  }
  return out;
}

/** The word being spoken at time t (null if in a gap). */
function spokenWordAt(transcript: Transcript | undefined, t: number): string | null {
  if (!transcript) return null;
  for (const seg of transcript.segments) {
    if (seg.end < t - 0.3 || seg.start > t + 0.3) continue;
    for (const w of seg.words) {
      if (w.start <= t + 0.05 && w.end >= t - 0.05) {
        const clean = w.word.replace(/[^A-Za-z0-9']/g, '');
        return clean.length >= 2 ? clean : null;
      }
    }
  }
  return null;
}

const BEAT_ROLES = new Set(['hook', 'curiosity', 'micro-payoff', 'escalation', 'major-payoff', 'satisfaction']);

/** Validate AI retention: architecture + beats required; teaser only when it
 *  is a clean cold-open (1.5-3.5s, from a kept segment, not the opening and
 *  not the final payoff). Returns null when the proposal is unusable. */
function sanitizeRetention(raw: any, start: number, end: number, kept: { start: number; end: number }[]): Retention | null {
  if (!raw || typeof raw !== 'object') return null;
  const architecture = String(raw.architecture ?? '').replace(/\s+/g, ' ').trim().slice(0, 48);
  if (!architecture) return null;
  const rationale = String(raw.rationale ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
  const rawBeats: unknown[] = Array.isArray(raw.beats) ? raw.beats : [];
  const beats: RetentionBeat[] = rawBeats
    .slice(0, 8)
    .map((b: any) => ({ t: num(b.t), role: (BEAT_ROLES.has(b.role) ? b.role : null) as RetentionBeatRole | null, note: String(b.note ?? '').replace(/\s+/g, ' ').slice(0, 90) }))
    .filter((b): b is RetentionBeat => b.role !== null && b.t >= start && b.t <= end)
    .sort((a, b) => a.t - b.t);
  const dedup: typeof beats = [];
  for (const b of beats) if (!dedup.length || b.t - dedup[dedup.length - 1].t >= 1.2) dedup.push(b);
  if (!dedup.length) return null;

  let teaser: Retention['teaser'];
  const tr = raw.teaser;
  if (tr && typeof tr === 'object') {
    const ts = clamp(num(tr.sourceStart, start), start, end);
    const te = clamp(num(tr.sourceEnd, ts), ts, end);
    const host = kept.find((k) => ts >= k.start - 0.05 && te <= k.end + 0.05);
    if (host && te - ts >= 1.5 && te - ts <= 3.5 && ts >= start + 6 && te <= end - 3) {
      teaser = { sourceStart: r2(ts), sourceEnd: r2(te), reason: String(tr.reason ?? 'curiosity cold-open').slice(0, 140) };
    }
  }
  return { architecture, rationale, beats: dedup, teaser };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
