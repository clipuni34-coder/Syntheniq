// Syntheniq — editorial intelligence: candidate generation + ranking.
import { scoreCandidate, speechRatioInRange, type Candidate, type ScoreContext } from './features.js';
import { energyInRange, type EnergyStats } from './features.js';
import type { Clip, ClipSubSegment, Segment, StructureData } from '../../types.js';

const MIN_CLIP = 5;
const MAX_CLIP = 62;
const TARGETS = [25, 35, 45];
const VIRAL_TARGET = 45;

export interface ScoredCandidate extends Candidate {
  total: number;
  scores: Scores;
  reasons: string[];
  viralMultiplier?: number;
  viralScore?: number;
}

export interface TimedSentence {
  text: string;
  start: number;
  end: number;
}

export function sentencesFromSegments(segments: Segment[] | undefined | null): TimedSentence[] {
  const sentences: TimedSentence[] = [];
  for (const seg of segments || []) {
    const text = String((seg && seg.text) || '').trim();
    if (!text) continue;
    const span = Math.max(0.1, seg.end - seg.start);
    const parts = text.match(/[^.!?…]+[.!?…]+["”']?|\S[^.!?…]*$/g) || [text];
    const totalChars = parts.reduce((a, p) => a + p.length, 0) || 1;
    let cursor = seg.start;
    parts.forEach((part, i) => {
      const clean = part.trim();
      if (clean.length < 2) return;
      const frac = part.length / totalChars;
      const end = i === parts.length - 1 ? seg.end : cursor + span * frac;
      sentences.push({ text: clean, start: round2(cursor), end: round2(end) });
      cursor = end;
    });
  }
  return sentences.sort((a, b) => a.start - b.start);
}

function textOf(sentences: TimedSentence[]): string {
  return sentences.map((s) => s.text).join(' ');
}

export function generateCandidates(
  sentences: TimedSentence[],
  structure: Partial<StructureData>,
  duration: number,
  hasText: boolean
): Candidate[] {
  const speechActive = (structure && structure.speechActive) || [];
  const candidates: Candidate[] = [];

  if (!sentences.length) {
    const spans = speechActive.length > 0 ? speechActive : [{ start: 0, end: Math.min(duration, 300) }];
    for (const span of spans) {
      let cursor = span.start;
      while (cursor + 12 < span.end && cursor < duration) {
        const end = Math.min(span.end, cursor + 35, duration);
        if (end - cursor >= MIN_CLIP) {
          candidates.push({ start: round2(cursor), end: round2(end), text: '', sentences: [] });
        }
        cursor += 15;
        if (candidates.length > 400) break;
      }
    }
    if (!candidates.length && duration > 0) {
      candidates.push({ start: 0, end: round2(Math.min(duration, 45)), text: '', sentences: [] });
    }
    return candidates;
  }

  if (duration <= MAX_CLIP && sentences.length > 0) {
    candidates.push({
      start: round2(sentences[0].start),
      end: round2(Math.min(duration, sentences[sentences.length - 1].end)),
      text: textOf(sentences),
      sentences: sentences.map((s) => s.text),
    });
  }

  for (let i = 0; i < sentences.length; i++) {
    for (const target of TARGETS) {
      let j = i;
      while (j < sentences.length && sentences[j].end - sentences[i].start < target) {
        j++;
      }
      if (j >= sentences.length) j = sentences.length - 1;
      if (j < i) continue;
      const start = sentences[i].start;
      const end = Math.min(duration, sentences[j].end);
      const dur = end - start;
      if (dur < MIN_CLIP || dur > MAX_CLIP) continue;
      if (hasText && speechActive.length > 0) {
        const ratio = speechRatioInRange(speechActive, start, end);
        if (ratio < 0.3) continue;
      }
      const slice = sentences.slice(i, j + 1);
      candidates.push({
        start: round2(start),
        end: round2(end),
        text: textOf(slice),
        sentences: slice.map((s) => s.text),
      });
      if (candidates.length > 6000) return candidates;
    }
  }
  return candidates;
}

export function suppress<T extends ScoredCandidate>(scored: T[], iouThreshold = 0.5): T[] {
  const sorted = [...scored].sort((a, b) => b.total - a.total);
  const kept: T[] = [];
  for (const cand of sorted) {
    const dur = Math.max(0.1, cand.end - cand.start);
    let clash = false;
    for (const k of kept) {
      const kDur = Math.max(0.1, k.end - k.start);
      const inter = Math.max(0, Math.min(cand.end, k.end) - Math.max(cand.start, k.start));
      const union = dur + kDur - inter;
      const iou = union > 0 ? inter / union : 0;
      if (iou >= iouThreshold) {
        clash = true;
        break;
      }
    }
    if (!clash) kept.push(cand);
  }
  return kept;
}

export function computeViralMultiplier(
  start: number,
  end: number,
  structure: ScoreContext & Partial<StructureData>
): { multiplier: number; factors: Record<string, number> } {
  const { sceneCuts = [], speechActive = [], energyCurve = [] } = structure;
  const dur = Math.max(0.1, end - start);

  const cutsInRange = sceneCuts.filter((t) => t >= start && t <= end).length;
  const cutDensity = cutsInRange / dur;

  const energyStats = energyInRange(energyCurve, start, end);
  const energyVariance = energyStats.variance;

  const speechRatio = speechRatioInRange(speechActive, start, end);
  const silenceRatio = 1 - speechRatio;
  const dynamicRatio = 0.5 - Math.abs(speechRatio - 0.5);

  const hookBoost = start < dur * 0.15 ? 0.15 : 0;
  const payoffBoost = end > dur * 0.85 ? 0.12 : 0;
  const varietyBoost = cutDensity * 3;
  const energyBoost = Math.min(0.15, energyVariance * 20);
  const silenceBoost = Math.min(0.1, dynamicRatio * 0.2);

  const multiplier = Math.max(1, Math.min(3, 1 + hookBoost + payoffBoost + varietyBoost + energyBoost + silenceBoost));
  return {
    multiplier,
    factors: { cutDensity, energyVariance, speechRatio, hookBoost, payoffBoost, varietyBoost, energyBoost, silenceBoost },
  };
}

export interface MultiSegmentCandidate extends ScoredCandidate {
  subSegments: ClipSubSegment[];
  viralMultiplier: number;
}

export function generateMultiSegmentCandidates(
  clips: Clip[],
  structure: ScoreContext & Partial<StructureData>,
  sentences: TimedSentence[],
  duration: number
): MultiSegmentCandidate[] {
  const candidates: MultiSegmentCandidate[] = [];
  if (clips.length < 2) return candidates;

  for (let i = 0; i < clips.length - 1; i++) {
    const clipA = clips[i];
    const clipB = clips[i + 1];
    const gap = clipB.start - clipA.end;

    if (gap > 15) continue;
    if (gap < 0) continue;

    const start = clipA.start;
    const end = Math.min(duration, clipB.end);
    const dur = end - start;
    if (dur < MIN_CLIP || dur > MAX_CLIP) continue;

    const midPoint = (start + end) / 2;

    const subSegments: ClipSubSegment[] = [];
    const hookEnd = clipA.end;
    const payoffStart = clipB.start;

    if (hookEnd - start >= 1) {
      const txt = sentences
        .filter((s) => s.start >= start && s.end <= hookEnd)
        .map((s) => s.text)
        .join(' ')
        .slice(0, 80);
      subSegments.push({ purpose: 'hook', start, end: hookEnd, title: txt || 'opening hook' });
    }

    if (payoffStart > hookEnd && payoffStart - hookEnd >= 1) {
      const txt = sentences
        .filter((s) => s.start >= hookEnd && s.end <= payoffStart)
        .map((s) => s.text)
        .join(' ')
        .slice(0, 80);
      subSegments.push({
        purpose: 'narrative',
        start: hookEnd,
        end: payoffStart,
        title: txt || 'bridge',
      });
    }

    if (end - payoffStart >= 1) {
      const txt = sentences
        .filter((s) => s.start >= payoffStart && s.end <= end)
        .map((s) => s.text)
        .join(' ')
        .slice(0, 80);
      subSegments.push({ purpose: 'payoff', start: payoffStart, end, title: txt || 'closing payoff' });
    }

    if (subSegments.length < 2) continue;

    const text = sentences
      .filter((s) => s.start >= start && s.end <= end)
      .map((s) => s.text)
      .join(' ');
    const candidateText = sentences
      .filter((s) => s.start >= start && s.end <= end)
      .map((s) => s.text);

    const scored = scoreCandidate(
      { start, end, text, sentences: candidateText },
      structure
    );

    const { multiplier, factors } = computeViralMultiplier(start, end, structure);
    const viralScore = clampV(scored.total * multiplier);

    candidates.push({
      start: round2(start),
      end: round2(end),
      text,
      sentences: candidateText,
      subSegments,
      total: scored.total,
      scores: scored.scores,
      reasons: [...scored.reasons, `Viral multiplier: ${multiplier.toFixed(2)}× (cuts:${factors.cutDensity.toFixed(1)}/s, energyVar:${factors.energyVariance.toFixed(3)})`],
      viralMultiplier: multiplier,
      viralScore,
    });
  }

  const sorted = candidates.sort((a, b) => b.viralScore - a.viralScore);
  return sorted.slice(0, 8);
}

function clampV(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function makeTitle(text: string, start: number): string {
  const clean = String(text || '').trim();
  if (!clean) return `Moment at ${formatClock(start)}`;
  const ws = clean.split(/\s+/).slice(0, 9).join(' ');
  const trimmed = ws.length > 64 ? ws.slice(0, 64).trimEnd() + '…' : ws;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatClock(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export interface RankInput {
  segments?: Segment[] | null;
  structure?: ScoreContext & Partial<StructureData>;
  duration?: number;
  hasText?: boolean;
  maxClips?: number;
}

export function rankClips({ segments, structure = {}, duration = 0, hasText = true, maxClips = 5 }: RankInput): {
  clips: Clip[];
  stats: { candidatesConsidered: number; sentenceCount: number; hasText: boolean; topScore: number };
} {
  const sentences = hasText ? sentencesFromSegments(segments) : [];
  const raw = generateCandidates(sentences, structure, duration, hasText);
  const scored: ScoredCandidate[] = raw.map((c) => Object.assign({}, c, scoreCandidate(c, structure)) as ScoredCandidate);
  const kept: ScoredCandidate[] = suppress(scored).slice(0, Math.max(1, maxClips));
  kept.sort((a, b) => b.total - a.total);

  // Viral multiplier on top-scoring single segments
  for (const c of kept) {
    const { multiplier } = computeViralMultiplier(c.start, c.end, structure);
    c.viralMultiplier = multiplier;
    c.viralScore = clampV(c.total * multiplier);
  }

  const clips: Clip[] = kept.map((c, i) => {
    const predSfx = Math.max(1, Math.round(sfxEstimate(c, structure)));
    const predTrans = Math.max(0, Math.round(transitionEstimate(c)));
    return ({
      id: `clip-${i + 1}`,
      rank: i + 1,
      start: c.start,
      end: c.end,
      duration: round2(c.end - c.start),
      title: makeTitle(c.text, c.start),
      excerpt: c.text.length > 300 ? c.text.slice(0, 300).trimEnd() + '…' : c.text,
      scores: c.scores,
      heuristicScores: { ...c.scores },
      decidedBy: 'heuristic' as const,
      total: c.total,
      reasons: c.reasons,
      exported: null,
      improvedScore: predictImprovedScore(c.total, predSfx, predTrans),
      viralScore: c.viralScore,
      predictedSfxCount: predSfx,
      predictedTransitions: predTrans,
    });
  });

  // Generate multi-segment candidates from adjacent high-scoring clips
  const multiSeg = generateMultiSegmentCandidates(clips, structure, sentences, duration);
  for (const ms of multiSeg) {
    if (ms.viralScore > clips[0]?.viralScore * 0.8) {
      clips.push({
        id: `ms-${clips.length + 1}`,
        rank: clips.length + 1,
        start: ms.start,
        end: ms.end,
        duration: round2(ms.end - ms.start),
        title: makeTitle(ms.text, ms.start),
        excerpt: ms.text.length > 300 ? ms.text.slice(0, 300).trimEnd() + '…' : ms.text,
        scores: ms.scores,
        heuristicScores: { ...ms.scores },
        decidedBy: 'multi-segment' as const,
        total: ms.total,
        reasons: ms.reasons,
        exported: null,
        subSegments: ms.subSegments,
        improvedScore: predictImprovedScore(ms.total, sfxEstimate(ms, structure), transitionEstimate(ms)),
        viralScore: ms.viralScore,
        predictedSfxCount: Math.max(1, Math.round(sfxEstimate(ms, structure))),
        predictedTransitions: Math.max(0, Math.round(transitionEstimate(ms))),
      });
    }
  }

  clips.sort((a, b) => (b.viralScore ?? b.total) - (a.viralScore ?? a.total));
  clips.forEach((c, i) => {
    c.rank = i + 1;
    c.id = `clip-${i + 1}`;
  });

  return {
    clips,
    stats: {
      candidatesConsidered: raw.length,
      sentenceCount: sentences.length,
      hasText,
      topScore: clips.length ? clips[0].viralScore ?? clips[0].total : 0,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function sfxEstimate(candidate: Candidate & { scores: Scores }, structure: ScoreContext & Partial<StructureData>): number {
  const dur = candidate.end - candidate.start;
  if (dur <= 0) return 1;
  const { sceneCuts = [] } = structure;
  const cutsInRange = sceneCuts.filter((t) => t >= candidate.start && t <= candidate.end).length;
  const cutDensity = cutsInRange / dur;
  const intensity = candidate.scores.hook * 0.4 + candidate.scores.emotion * 0.3 + candidate.scores.visual * 0.3;
  return Math.max(1, Math.round(1 + cutDensity * 3 + intensity * 5));
}

function transitionEstimate(candidate: Candidate): number {
  const dur = candidate.end - candidate.start;
  if (dur > 20) return 3;
  if (dur > 15) return 2;
  if (dur > 10) return 1;
  return 0;
}

export function predictImprovedScore(baseScore: number, predictedSfx: number, predictedTransitions: number): number {
  const sfxBoost = Math.min(0.2, (predictedSfx - 1) * 0.03);
  const transitionBoost = Math.min(0.15, predictedTransitions * 0.05);
  return clampV(baseScore * (1 + sfxBoost + transitionBoost));
}

export function predictViralScore(
  scores: Scores,
  start: number,
  end: number,
  structure: ScoreContext & Partial<StructureData>
): number {
  const { multiplier } = computeViralMultiplier(start, end, structure);
  const baseScore = scores.hook * 0.3 + scores.emotion * 0.25 + scores.payoff * 0.2 + scores.visual * 0.15 + scores.curiosity * 0.1;
  return clampV(baseScore * multiplier);
}

import type { Scores } from '../../types.js';
