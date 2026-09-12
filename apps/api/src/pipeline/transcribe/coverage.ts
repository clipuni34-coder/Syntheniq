// Syntheniq — EDITORIAL RULE enforcement.
// The transcript is measured against the actual video duration; missing
// ranges are reported so the pipeline can re-process them. The video is
// the final authority.
import type { Segment, Span } from '../../types.js';

export const DEFAULTS = {
  minGap: 8,
  tailGap: 12,
  minCoverage: 0.85,
};

export function unionSpans(segments: Segment[] | undefined | null): Span[] {
  const spans = (segments || [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: Math.max(0, s.start), end: s.end }))
    .sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end + 0.75) {
      last.end = Math.max(last.end, s.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

export interface CoverageReport {
  coverage: number;
  coveredSeconds: number;
  gaps: Span[];
  tailGapSeconds: number;
  lastCoveredSecond: number;
  needsWork: boolean;
  reasons: string[];
}

export function analyzeCoverage(
  segments: Segment[] | undefined | null,
  duration: number,
  opts: Partial<typeof DEFAULTS> = {}
): CoverageReport {
  const { minGap, tailGap, minCoverage } = { ...DEFAULTS, ...opts };
  const spans = unionSpans(segments);
  const coveredSeconds = spans.reduce((a, s) => a + (s.end - s.start), 0);
  const coverage = duration > 0 ? coveredSeconds / duration : 0;

  const gaps: Span[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start - cursor >= minGap) gaps.push({ start: cursor, end: s.start });
    cursor = Math.max(cursor, s.end);
  }
  const tail = duration - cursor;
  const tailUncovered = tail >= tailGap;
  if (tailUncovered) gaps.push({ start: cursor, end: duration });

  const reasons: string[] = [];
  if (spans.length === 0 && duration > 0) {
    reasons.push('No transcript segments at all for a video with duration — full re-processing required.');
  } else {
    if (coverage < minCoverage) {
      reasons.push(
        `Transcript covers ${Math.round(coveredSeconds)}s of ${Math.round(duration)}s ` +
          `(${Math.round(coverage * 100)}%) — below the ${Math.round(minCoverage * 100)}% bar.`
      );
    }
    if (tailUncovered) {
      reasons.push(
        `Transcription ends at ${Math.round(cursor)}s but the video runs to ${Math.round(duration)}s — ` +
          `the final ${Math.round(tail)}s are missing.`
      );
    }
    const inner = gaps.filter((g) => g.end < duration - 1);
    if (inner.length > 0) {
      reasons.push(`${inner.length} un-transcribed gap(s) inside the video need re-processing.`);
    }
  }

  return {
    coverage,
    coveredSeconds,
    gaps,
    tailGapSeconds: tailUncovered ? tail : 0,
    lastCoveredSecond: cursor,
    needsWork: reasons.length > 0,
    reasons,
  };
}

export function mergeSegments(primary: Segment[] | undefined | null, extra: Segment[] | undefined | null): Segment[] {
  const all = [...(primary || []), ...(extra || [])]
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Segment[] = [];
  for (const seg of all) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(seg);
      continue;
    }
    const overlap = Math.min(prev.end, seg.end) - Math.max(prev.start, seg.start);
    const smaller = Math.min(prev.end - prev.start, seg.end - seg.start);
    const dup = smaller > 0 && overlap / smaller > 0.6;
    if (seg.start >= prev.start && seg.end <= prev.end + 0.01) {
      if ((seg.text || '').length > (prev.text || '').length) out[out.length - 1] = seg;
      continue;
    }
    if (dup) {
      if ((seg.text || '').length > (prev.text || '').length) {
        prev.start = Math.min(prev.start, seg.start);
        prev.end = Math.max(prev.end, seg.end);
        prev.text = seg.text;
        prev.words = seg.words && seg.words.length ? seg.words : prev.words;
      } else {
        prev.end = Math.max(prev.end, seg.end);
      }
      continue;
    }
    out.push(seg);
  }
  return out;
}
