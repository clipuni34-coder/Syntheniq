// Syntheniq — editorial intelligence: candidate generation + ranking.
import { scoreCandidate, speechRatioInRange, type Candidate, type ScoreContext } from './features.js';
import type { Clip, Segment, StructureData } from '../../types.js';

const MIN_CLIP = 18;
const MAX_CLIP = 62;
const TARGETS = [25, 35, 45];

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
    if (!candidates.length && duration > 4) {
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

export function suppress<T extends Candidate & { total: number }>(scored: T[], iouThreshold = 0.5): T[] {
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
  const scored = raw.map((c) => Object.assign({}, c, scoreCandidate(c, structure)));
  const kept = suppress(scored).slice(0, Math.max(1, maxClips));
  kept.sort((a, b) => b.total - a.total);

  const clips: Clip[] = kept.map((c, i) => ({
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
  }));

  return {
    clips,
    stats: {
      candidatesConsidered: raw.length,
      sentenceCount: sentences.length,
      hasText,
      topScore: clips.length ? clips[0].total : 0,
    },
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
