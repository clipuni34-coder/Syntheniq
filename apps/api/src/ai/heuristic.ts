import type { LLMRequest, LLMResult } from './types.js';
import type { MediaInfo, Retention, RetentionBeat, RetentionBeatRole, Silence, Transcript } from '../pipeline/types.js';
import { deriveEditorialCues, tempoFor } from '../pipeline/motion.js';

/**
 * Heuristic offline AI — deterministic, dependency-free fallback so the whole
 * pipeline works with zero API keys (development + offline use). The UI labels
 * results from this mode clearly. LLM providers replace this when configured.
 */

export interface HeuristicSignals {
  transcript: Transcript;
  media: MediaInfo;
  silences: Silence[]; // gaps with no speech
  energy: { t: number; rms: number }[]; // ~1s buckets, rms 0..1
  analysis?: import('../pipeline/types.js').Analysis; // set after the analyze stage
  packageInput?: { clips: unknown[]; keyphrases: string[] }; // set before the package stage
}

const STOPWORDS = new Set(
  'the a an and or but if then so of to in on at by for with about into over under is are was were be been being it its this that these those i you he she we they me him her us them my your his our their not no yes do does did done have has had having will would can could should just really very much more most some any all each other another as from up out down off what which who whom when where why how'.split(
    ' ',
  ),
);

export function heuristicSupports(task: string): boolean {
  return task === 'analyze' || task === 'plan' || task === 'package' || task === 'video';
}

export function callHeuristic(req: LLMRequest, s: HeuristicSignals | null): LLMResult {
  const t0 = Date.now();
  let json: unknown;
  let text = '';
  if (req.task === 'analyze') json = heuristicAnalyze(s!);
  else if (req.task === 'plan') json = heuristicPlan(s!, s!.analysis as any);
  else if (req.task === 'package') json = heuristicPackage(s!.packageInput || { clips: [], keyphrases: [] }, s!);
  else json = { frames: [] }; // video task: no visual info offline
  text = JSON.stringify(json, null, 2);
  return { text, json, provider: 'heuristic', model: 'heuristic-v1', latencyMs: Date.now() - t0 };
}

// ── helpers ────────────────────────────────────────────────────────────

function energyAt(s: { energy: { t: number; rms: number }[] }, a: number, b: number): number {
  const inRange = s.energy.filter((e) => e.t >= a && e.t < b);
  if (!inRange.length) return 0;
  return inRange.reduce((x, e) => x + e.rms, 0) / inRange.length;
}

interface Beat {
  start: number;
  end: number;
  text: string;
  energy: number;
}

/** Split transcript into beats at long silences (≥0.8 s). */
function beats(s: HeuristicSignals): Beat[] {
  const out: Beat[] = [];
  let cur: Beat | null = null;
  for (const seg of s.transcript.segments) {
    const gapBefore = cur ? seg.start - cur.end : 0;
    if (!cur || gapBefore >= 0.8 || seg.start - cur.start > 60) {
      if (cur) out.push(cur);
      cur = { start: seg.start, end: seg.end, text: seg.text.trim(), energy: 0 };
    } else {
      cur.end = seg.end;
      cur.text += ' ' + seg.text.trim();
    }
  }
  if (cur) out.push(cur);
  for (const b of out) b.energy = energyAt(s, b.start, b.end);
  return out;
}

function topKeywords(s: HeuristicSignals, n: number): { text: string; times: number[] }[] {
  const freq = new Map<string, { count: number; times: number[] }>();
  for (const seg of s.transcript.segments) {
    for (const w of seg.words) {
      const clean = w.word.toLowerCase().replace(/[^a-z0-9']/gi, '');
      if (clean.length < 3 || STOPWORDS.has(clean) || /^[0-9.]+$/.test(clean)) continue;
      const e = freq.get(clean) || { count: 0, times: [] };
      e.count++;
      e.times.push(w.start);
      freq.set(clean, e);
    }
  }
  return [...freq.entries()]
    .map(([text, v]) => ({ text, times: v.times, score: v.count * Math.log(text.length + 1) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ text, times }) => ({ text, times }));
}

function clipScore(b: Beat, s: HeuristicSignals): number {
  const dur = b.end - b.start;
  if (dur < 4) return 0;
  const density = b.text.replace(/\s+/g, ' ').length / dur; // chars/sec
  const hook = (/\?|!/.test(b.text) ? 1 : 0) * 0.4 + (s.media.duration > 0 && b.start / s.media.duration < 0.3 ? 0.6 : 0.2);
  const curiosity = (b.text.match(/\b(why|how|secret|mistake|truth|nobody|actually|believe|turns out)\b/gi) || []).length;
  const payoff = (b.text.match(/[!]|(?:\d+(?:\.\d+)?)(?:%|k|m|b|million|thousand)/gi) || []).length;
  const standalone = (/[.!?]$/.test(b.text.trim()) ? 1 : 0.5);
  const emotion = Math.min(1, b.energy * 3);
  const visual = 0.5;
  const editorial = 0.25 * hook + 0.2 * Math.min(1, curiosity / 3) + 0.2 * Math.min(1, payoff / 3) + 0.15 * standalone + 0.1 * emotion + 0.1 * visual;
  return editorial * Math.min(1, density / 14) * Math.min(1, dur / 30);
}

// ── analyze ────────────────────────────────────────────────────────────

function heuristicAnalyze(s: HeuristicSignals) {
  const bs = beats(s);
  const kws = topKeywords(s, 12);
  const topics = bs
    .filter((b) => b.end - b.start >= 5)
    .map((b) => ({
      start: r2(b.start),
      end: r2(b.end),
      title: b.text.split(/\s+/).slice(0, 6).join(' '),
      summary: b.text.slice(0, 220),
      energy: r2(b.energy),
      emotion: /love|great|awesome|amazing|sad|crazy|insane|best|worst/i.test(b.text) ? 'strong' : 'neutral',
      importance: r2(clipScore(b, s)),
    }));

  const moments = bs
    .map((b) => ({ b, score: clipScore(b, s) }))
    .filter((x) => x.score > 0.05)
    .sort((a, b2) => b2.score - a.score)
    .slice(0, 8)
    .map(({ b, score }) => ({
      start: r2(b.start),
      end: r2(b.end),
      hook: Math.round(0.3 + score),
      curiosity: 5,
      payoff: 5,
      standalone: 6,
      emotion: Math.round(Math.min(10, b.energy * 10)),
      visual: 5,
      reason: `heuristic: density+energy+position (score ${score.toFixed(2)})`,
    }));

  return {
    language: s.transcript.language,
    tone: 'neutral',
    topics,
    keyphrases: kws.map((k) => ({ text: k.text, times: k.times.slice(0, 5).map(r2) })),
    deadAir: s.silences
      .filter((sl) => sl.end - sl.start >= 0.45)
      .map((sl) => ({ start: r2(sl.start), end: r2(sl.end), reason: 'silence' })),
    fillerNotes: 'heuristic mode: filler removal is silence/filler-word based only',
    moments,
  };
}

// ── plan ───────────────────────────────────────────────────────────────

function heuristicPlan(s: HeuristicSignals, analysis: any): { clipCount: number; clips: any[]; notes: string } {
  const bs = beats(s);
  const dur = s.media.duration;
  const maxClips = Math.min(6, Math.max(1, Math.floor(dur / 25)));

  // Build candidate windows: merge beats into 25–50 s spans, prioritized by score.
  const scored = bs.map((b) => ({ b, score: clipScore(b, s) })).sort((a, b2) => b2.score - a.score);
  const used: { start: number; end: number }[] = [];
  const clips: any[] = [];
  let idx = 1;

  for (const { b } of scored) {
    if (clips.length >= maxClips) break;
    if (b.end - b.start < 6) continue;
    if (used.some((u) => b.start < u.end && b.end > u.start)) continue;

    // Extend over following beats to reach 25–45 s.
    let start = b.start;
    let end = b.end;
    while (end - start < 25) {
      const next = bs.find((x) => x.start >= end - 0.5 && x.start < end + 3 && x.start <= start + 55);
      if (!next) break;
      end = Math.min(next.end, start + 55);
    }
    if (end - start > 55) end = start + 55; // hard cap; will be cut below
    if (end - start < 12) continue; // too thin to be a clip
    if (used.some((u) => start < u.end && end > u.start)) continue;
    used.push({ start, end });

    clips.push(buildClip(idx++, start, end, s, analysis));
  }

  clips.sort((a, b) => a.sourceStart - b.sourceStart);
  clips.forEach((c, i) => (c.id = `clip-${i + 1}`));
  if (!clips.length) {
    // Degenerate: take the highest-scoring beat region even if short.
    const best = scored[0];
    if (best) {
      const start = Math.max(0, best.b.start - 2);
      const end = Math.min(dur, best.b.end + 4);
      clips.push(buildClip(1, start, end, s, analysis));
    }
  }
  return {
    clipCount: clips.length,
    clips,
    notes: 'Heuristic offline plan (no AI provider configured). Silence-based beats + energy scoring. Add an API key for editorial AI planning.',
  };
}

function buildClip(id: number, start: number, end: number, s: HeuristicSignals, analysis: any): any {
  // Kept segments: cut silences ≥0.5 s inside [start,end].
  const segments: { start: number; end: number }[] = [];
  let pos = start;
  const gaps = s.silences.filter((g) => g.end > start + 0.5 && g.start < end - 0.5 && g.end - g.start >= 0.5);
  for (const g of gaps) {
    const gs = Math.max(g.start - 0.12, pos);
    if (gs > pos + 0.3) segments.push({ start: r2(pos), end: r2(gs) });
    pos = Math.min(g.end + 0.12, end);
  }
  if (pos < end - 0.2) segments.push({ start: r2(pos), end: r2(end) });
  if (!segments.length) segments.push({ start: r2(start), end: r2(end) });
  // Drop micro-segments.
  const kept = segments.filter((seg) => seg.end - seg.start >= 0.35);
  if (!kept.length) kept.push({ start: r2(start), end: r2(end) });

  // Punch-ins on the two loudest 1 s energy buckets inside the clip.
  const peaks = s.energy.filter((e) => e.t >= start && e.t <= end).sort((a, b2) => b2.rms - a.rms).slice(0, 2);
  const punchIns = peaks.map((p, i) => ({ time: r2(p.t), zoom: i === 0 ? 1.18 : 1.12, reason: 'energy peak' }));

  // First sentence → hook text.
  const firstWords = s.transcript.segments.find((seg) => seg.end > start)?.words ?? [];
  let hookText = firstWords.slice(0, 8).map((w) => w.word.replace(/[.,;:!?]/g, '')).join(' ');
  hookText = hookText.split(/\s+/).slice(0, 6).join(' ');
  if (hookText) hookText = hookText[0].toUpperCase() + hookText.slice(1);

  const kws = topKeywords(s, 5);
  const callouts = kws[0]
    ? [{ time: r2(Math.min(kws[0].times.find((t) => t >= start && t <= end) ?? (start + end) / 2, end - 2)), text: kws[0].text.toUpperCase(), style: 'label' }]
    : [];

  const energy = energyAt(s, start, end);
  const peakT = s.energy.filter((e) => e.t >= start && e.t <= end).sort((a, b2) => b2.rms - a.rms)[0]?.t ?? (start + end) / 2;
  const music = energy > 0.5 ? 'drive' : 'chill';

  // motion-graphics cues derived from the same signals the edit used
  const motion = {
    cues: deriveEditorialCues({
      start,
      end,
      segments: kept,
      energy: s.energy,
      keyphrases: s.analysis?.keyphrases ?? kws,
      punchIns,
      topics: s.analysis?.topics ?? [],
      music,
      energyLevel: energy,
    }),
    style: tempoFor(energy),
  };

  // Retention architecture — continuous reasons to keep watching (see RETENTION PRINCIPLE).
  const retention = deriveRetention(start, end, kept, s, analysis);

  // Variant: a genuinely different angle (payoff-led) from a later moment —
  // only when the clip holds a second strong sentence distinct from the hook.
  let variants: { hookText?: string; title?: string; note?: string }[] = [];
  {
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hookNorm = norm(hookText).split(' ').slice(0, 5).join(' ');
    if (hookNorm.length > 8) {
      const sentences: string[] = [];
      for (const seg of s.transcript.segments) {
        if (seg.end <= start + 0.5 || seg.start >= end - 0.5) continue;
        for (const part of seg.text.split(/(?<=[.!?])\s+/)) {
          const t = part.trim();
          if (t.length >= 15 && t.length <= 95) sentences.push(t);
        }
      }
      const payoff = sentences.reverse().find(
        (t) =>
          /\b(doubled|tripled|views|watch time|retention|will change|changed|completely|from zero|\d+)\b/i.test(t) &&
          !norm(t).includes(hookNorm),
      );
      if (payoff) {
        const clean = payoff.replace(/\s+/g, ' ').trim();
        variants = [{ hookText: clean.slice(0, 80), title: clean.slice(0, 120), note: 'payoff-led variant' }];
      }
    }
  }

  return {
    id,
    sourceStart: r2(start),
    sourceEnd: r2(end),
    hookText,
    segments: kept,
    punchIns,
    cutaways: [],
    callouts,
    cta: { text: 'Follow for more', style: 'simple' },
    music,
    energy: r2(energy),
    thumbnail: { sourceTime: r2(peakT), text: hookText.slice(0, 32) || 'Watch this' },
    title: hookText,
    variants,
    motion,
    retention,
  };
}

/**
 * Deterministic retention architecture (offline fallback). Chooses the
 * structure that fits the signals, places beats tracing
 * HOOK -> CURIOSITY -> MICRO-PAYOFF -> ESCALATION -> MAJOR PAYOFF ->
 * SATISFACTION, and emits a cold-open teaser only when it clearly pays.
 */
export function deriveRetention(
  start: number,
  end: number,
  kept: { start: number; end: number }[],
  s: { energy: { t: number; rms: number }[]; transcript: Transcript },
  analysis: any,
): Retention {
  const clipE = s.energy.filter((e) => e.t >= start && e.t <= end);
  const mean = clipE.length ? clipE.reduce((a, e) => a + e.rms, 0) / clipE.length : 0.2;
  const std = clipE.length ? Math.sqrt(clipE.reduce((a, e) => a + (e.rms - mean) ** 2, 0) / clipE.length) : 0.1;

  // local peaks (a bucket louder than both neighbours and above the mean)
  const peaks: { t: number; rms: number }[] = [];
  for (let i = 1; i < clipE.length - 1; i++) {
    if (clipE[i].rms > clipE[i - 1].rms && clipE[i].rms >= clipE[i + 1].rms && clipE[i].rms > mean + 0.2 * std) {
      peaks.push({ t: clipE[i].t, rms: clipE[i].rms });
    }
  }
  if (!peaks.length && clipE.length) peaks.push({ t: clipE.reduce((a, b) => (b.rms > a.rms ? b : a)).t, rms: mean });
  const strongest = peaks.reduce((a, b) => (b.rms > a.rms ? b : a));
  const mid = start + (end - start) / 2;
  const lateStrong = strongest.t > mid;
  const earlyMean = energyAt(s, start, mid);
  const lateMean = energyAt(s, mid, end);
  const rising = lateMean > earlyMean * 1.12;
  const strongOpening = earlyMean > mean + 0.15 * std;

  const inKept = (t: number) => kept.some((k) => t >= k.start - 0.05 && t <= k.end + 0.05);
  const clipText = s.transcript.segments
    .filter((g) => g.end > start && g.start < end)
    .map((g) => g.text)
    .join(' ');
  const headText = s.transcript.segments
    .filter((g) => g.start >= start && g.start <= start + 5)
    .map((g) => g.text)
    .join(' ');

  const hasQuestion = /\b(why|how|what|who|when|which)\b|\?/i.test(headText);
  const hasReveal = /\b(actually|turns out|the truth|secret|nobody|but here|most people|believe me)\b/i.test(clipText);
  const hasResult = /\b(result|ended up|here's (the|what)|after (that|all this)|in the end|final|so now)\b/i.test(clipText);
  const hasBeforeAfter = /\b(before|after|used to|from .{0,24} to \w+|\d+\s*(percent|%|k)\b|now (i )?(have|do|make|run))\b/i.test(clipText);
  const hasConsequence = /\b(that's when|so (that's|here's|this is the)|because of that|and that's how|which is why)\b/i.test(clipText);

  // ── architecture selection (signal-driven, never one-size-fits-all) ─────
  let architecture: Retention['architecture'];
  let rationale: string;
  let teaserFriendly = false;
  if (hasQuestion && rising) {
    architecture = 'question-investigation-answer';
    rationale = 'opens on a question, energy and detail build toward the answer at the end';
  } else if (peaks.length >= 3 && rising) {
    architecture = 'escalating-revelations';
    rationale = 'three or more rising beats — each reveal outdoes the last';
    teaserFriendly = true;
  } else if (hasBeforeAfter) {
    architecture = 'transformation';
    rationale = 'a clear before/after change anchors the arc';
  } else if (strongOpening && lateStrong && hasResult) {
    architecture = 'consequence-first-explanation';
    rationale = 'a strong early moment previews what follows; the middle explains how it happened';
    teaserFriendly = true;
  } else if (lateStrong && hasReveal) {
    architecture = 'open-loop-progressive-reveal-resolution';
    rationale = 'an open loop early resolves through progressive reveals into a late payoff';
    teaserFriendly = true;
  } else if (strongOpening && !lateStrong) {
    architecture = 'emotional-context-emotional-payoff';
    rationale = 'emotional up-front, context in the middle, emotional close';
  } else if (hasConsequence) {
    architecture = 'pattern-break-explanation';
    rationale = 'a consequence/pattern-break is named, then explained';
    teaserFriendly = true;
  } else {
    architecture = 'chronological-hook-escalation-final-revelation';
    rationale = 'strong chronological story with escalating detail and a final reveal';
  }

  // ── beats: continuous HOOK -> CURIOSITY -> MICRO-PAYOFF -> ESCALATION ->
  //    MAJOR PAYOFF -> SATISFACTION ────────────────────────────────────────
  const beat = (role: RetentionBeatRole, t: number, note: string): RetentionBeat => ({
    t: r2(Math.max(start, Math.min(end - 0.2, t))),
    role,
    note,
  });
  const firstTopic = (analysis?.topics ?? []).find((t: any) => t.end > start + 4 && t.start < end);
  const beats: RetentionBeat[] = [
    beat('hook', start + 0.4, 'opening claim — the viewer knows the subject, not the payoff'),
    beat('curiosity', start + (end - start) * 0.22, firstTopic ? `topic "${String(firstTopic.title).slice(0, 28)}" opens a question` : 'first open question created'),
    beat('micro-payoff', peaks[0]?.t ?? mid * 0.6, 'first concrete reward (detail/number/statement)'),
    beat('escalation', peaks[1]?.t ?? start + (end - start) * 0.66, 'stakes raised — next payoff promised'),
    beat('major-payoff', strongest.t, 'strongest emotional/informational peak of the clip'),
    beat('satisfaction', end - 0.5, 'loop closed — ending delivers a satisfying payoff'),
  ];
  // de-duplicate beats that collapse onto each other — when two collide,
  // keep the one with the stronger retention role (the payoff never drops)
  const prio: Record<string, number> = { 'major-payoff': 4, 'micro-payoff': 3, escalation: 2, curiosity: 1, hook: 0, satisfaction: 0 };
  const dedup: RetentionBeat[] = [];
  for (const b of beats.sort((a, b) => a.t - b.t)) {
    const last = dedup[dedup.length - 1];
    if (last && b.t - last.t < 1.6) {
      if ((prio[b.role] ?? 0) > (prio[last.role] ?? 0)) dedup[dedup.length - 1] = b;
      continue;
    }
    dedup.push(b);
  }
  if (!dedup.length) dedup.push(beat('hook', start + 0.4, 'opening'), beat('major-payoff', strongest.t, 'peak'), beat('satisfaction', end - 0.5, 'close'));
  if (!dedup.some((b) => b.role === 'major-payoff')) {
    dedup.push(beat('major-payoff', strongest.t, 'strongest peak of the clip'));
    dedup.sort((a, b) => a.t - b.t);
  }

  // ── optional cold-open teaser (the ONLY non-chronological element) ──────
  // A brief later moment, only when it creates curiosity without spoiling the
  // payoff: not the opening, not the final ~3s, inside a kept segment, and
  // genuinely louder than the clip average.
  let teaser: Retention['teaser'];
  if (teaserFriendly && end - start >= 20) {
    const cand = peaks
      .filter((p) => p.t >= start + 6 && p.t <= end - 4 && p.rms > mean + 0.4 * std)
      .sort((a, b) => b.rms - a.rms)[0];
    if (cand) {
      const dur = 2.4;
      const host = kept.find((k) => cand.t >= k.start && cand.t <= k.end);
      if (host) {
        const ts = Math.max(host.start, cand.t - dur / 2);
        const te = Math.min(host.end, ts + dur);
        if (te - ts >= 1.5 && inKept(ts) && inKept(te)) {
          teaser = {
            sourceStart: r2(ts),
            sourceEnd: r2(te),
            reason: `cold-open on a strong later moment (${cand.t.toFixed(1)}s) — creates a question the chronological story then answers`,
          };
        }
      }
    }
  }

  return { architecture, rationale, beats: dedup, teaser };
}

// ── package ────────────────────────────────────────────────────────────

/** Words that never make a good hashtag (content filler, pronouns, numbers-as-words). */
const PKG_STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','at','by','as','so','with','for','from',
  'you','your','yours','i','we','it','its','my','me','he','she','they','them','this','that',
  'these','those','is','are','was','were','be','been','am','do','does','did','done','can',
  'could','will','would','should','might','must','just','only','really','very','much','many',
  'more','most','all','any','some','no','not','nothing','time','times','thing','things','way',
  'ways','people','one','two','three','four','five','cannot','cant','dont','doesnt','wont',
  'um','uh','well','yeah','okay','ok','right','like','watch','video','videos','short','shorts',
  'back','come','comes','know','want','wants','good','great','big','small','true','actually',
  'basically','literally','completely','totally','kinda','sorta','make','makes','made','get',
  'gets','got','say','says','said','there','here','when','what','how','why','which','while',
  'second','first','next','last','final','spent','try','trying','change','changed','changes',
  'thank','thanks','thanks','try','one','week','weeks','months','month','hours','hour',
  'single','huge','view','views','read','read','view','screen','sound','fast','slow','new','old',
  'moment','decided','process','process','started','starting','stop','stopped','stopping',
]);

function cleanTag(phrase: string): string | null {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !PKG_STOP.has(w));
  if (!words.length) return null;
  let tag = words.join('');
  if (tag.length > 15) tag = words[0];
  return tag.length >= 3 && tag.length <= 15 ? tag : null;
}

function clipWindowText(s: HeuristicSignals, start: number, end: number): string {
  return s.transcript.segments
    .filter((sg) => sg.end > start + 0.05 && sg.start < end - 0.05)
    .map((sg) => sg.text)
    .join(' ');
}

/** Extend a hook fragment to its full sentence in the transcript (complete titles, §AI-path parity). */
function completeTitle(hook: string, s: HeuristicSignals): string {
  const base = String(hook || '').trim();
  if (base.length < 8) return base;
  // match the hook against the transcript tolerating punctuation the hook may lack
  // ("So three months ago I made" ↔ "So three months ago, I made …")
  const words = base.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).slice(0, 10);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(words.map((w) => esc(w)).join('[^a-z0-9]*'), 'i');
  for (const seg of s.transcript.segments) {
    const m = seg.text.match(re);
    if (!m || m.index == null) continue;
    const tail = seg.text.slice(m.index + m[0].length);
    const b = tail.match(/^[^.!?]*[.!?]/); // extend to the sentence end (raw punctuation kept)
    const full = (base + (b ? b[0] : '')).replace(/\s+/g, ' ').trim().replace(/\s+([,.!?])/g, '$1');
    // strip weak openers
    const cleaned = (full.replace(/^(so|um|uh|okay|ok|right|alright|yeah|actually|basically)[,\s]+/i, '')
      .replace(/^(\S)/, (m) => m.toUpperCase()));
    return cleaned.length >= 12 ? cleaned.slice(0, 95) : full.slice(0, 95);
  }
  return base.slice(0, 95);
}
/** Derive the narrative angle from what is actually spoken in the clip window. */
function deriveAngle(s: HeuristicSignals, start: number, end: number): string {
  const text = clipWindowText(s, start, end).toLowerCase();
  const ordinals = (text.match(/\b(first|second|third|fourth|fifth|next|final|last)\b/g) || []).length;
  const story = /\b(mistake|wrong|failed|failure|learned|lesson|story|used to|three months ago|a year ago|last year|when i started)\b/.test(text);
  const fix = /\b(fix|fixed|changed|improvement|what i do|my process|my workflow)\b/.test(text);
  const progress = /\$|\b\d+\s*(x|k|m|b)\b|\b(doubled|tripled|grew|increased|from zero|watch time|revenue|views)\b/.test(text);
  if (story && fix) return 'Mistake → Fix (before/after)';
  if (ordinals >= 2) return 'List / how-to';
  if (ordinals >= 1 && fix) return 'List / how-to';
  if (story) return 'Personal story';
  if (progress) return 'Progression (numbers move)';
  return 'Direct value / tip';
}

/** Generic words that make bad hashtags even though they're not stopwords. */
const PKG_GENERIC = new Set(['words', 'word', 'text', 'read', 'screen', 'follow', 'sound', 'big', 'new', 'next', 'start', 'start', 'one', 'way']);

function buildHashtags(input: { keyphrases: string[] }, clip: any, s: HeuristicSignals): string[] {
  const tags: string[] = [];
  const push = (t: string | null) => {
    if (t && !tags.includes(t) && tags.length < 4) tags.push(t);
  };
  // 1. topic content words, ranked by (frequency, length, first appearance)
  //    ("…huge mistake with my editing workflow…" → workflow, editing, mistake, …)
  const topicWords = String(clip.topic || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  const tfreq = new Map<string, number>();
  const tfirst = new Map<string, number>();
  topicWords.forEach((w, i) => {
    if (PKG_STOP.has(w) || PKG_GENERIC.has(w)) return;
    tfreq.set(w, (tfreq.get(w) || 0) + 1);
    if (!tfirst.has(w)) tfirst.set(w, i);
  });
  [...tfreq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || tfirst.get(a[0])! - tfirst.get(b[0])!)
    .forEach(([w]) => push(w));
  // 2. keyphrases (multi-word first, then single words)
  const kws = [...(clip.keyphrases || []), ...input.keyphrases];
  for (const k of kws) if (String(k).includes(' ')) push(cleanTag(k));
  for (const k of kws) if (!String(k).includes(' ')) push(cleanTag(k));
  // 3. last resort: most frequent real content words spoken in the clip
  if (tags.length < 2) {
    const freq = new Map<string, number>();
    for (const w of clipWindowText(s, clip.sourceStart || 0, clip.sourceEnd || 1e9).toLowerCase().match(/[a-z]{5,}/g) || []) {
      if (!PKG_STOP.has(w) && !PKG_GENERIC.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([w]) => push(w));
  }
  tags.push('shorts');
  return tags.map((t) => '#' + t);
}

function heuristicPackage(input: { clips: any[]; keyphrases: string[] }, s: HeuristicSignals) {
  const clips = input.clips.map((c: any, i: number) => {
    const hook = String(c.hookText || c.title || 'You have to see this.').trim();
    const title = completeTitle(hook, s).slice(0, 95) || 'You have to see this.';
    const angle = deriveAngle(s, c.sourceStart || 0, c.sourceEnd || s.media.duration);
    const hashtags = buildHashtags(input, c, s);
    const desc = String(c.topic || 'A moment from the full video — the key idea in under a minute.');
    return {
      index: i,
      title,
      angle,
      tiktokCaption: `${title} ${hashtags.slice(0, 4).join(' ')}`.trim(),
      instagramCaption: `${title}\n\n${desc}\n\n${hashtags.slice(0, 5).join(' ')}`.trim(),
      youtubeDescription: `${title}\n\n${desc}\n\n${hashtags.join(' ')}`.trim(),
      description: desc,
      hashtags,
      cta: 'Follow for more 🔔',
      variants: (Array.isArray(c.variants) ? c.variants : [])
        .slice(0, 3)
        .map((v: any) => ({
          hookText: v.hookText ? String(v.hookText).slice(0, 80) : undefined,
          title: v.title ? String(v.title).slice(0, 120) : undefined,
          note: v.note ? String(v.note).slice(0, 160) : undefined,
        }))
        .filter((v: any) => v.hookText || v.title),
    };
  });
  return { clips };
}

function r2(n: number): number {
  return Math.round(n * 100) / 100;
}
