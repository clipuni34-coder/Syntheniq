// Syntheniq — quality control for kinetic caption rendering.
// Validates that word-level animations don't cause timing conflicts or
// visual overload, and provides repair strategies.
import type { KineticCaptionEvent, KineticWord } from './captions.js';
import type { MotionCue } from '../editorial/motion.js';

export interface CaptionQCResult {
  ok: boolean;
  issues: string[];
  warnings: string[];
  stats: {
    eventCount: number;
    wordCount: number;
    maxLayer: number;
    totalDuration: number;
    avgWordsPerEvent: number;
  };
}

export interface CaptionQCFix {
  fixed: boolean;
  changes: string[];
  events: KineticCaptionEvent[];
}

const MAX_OVERLAP_RATIO = 0.8;
const MAX_WORD_DURATION = 2.5;
const MAX_CONCURRENT_EFFECTS = 5;
const MIN_WORD_GAP = 0.05;

function calcStats(events: KineticCaptionEvent[]): CaptionQCResult['stats'] {
  const wordCount = events.reduce((sum, ev) => sum + ev.words.length, 0);
  const totalDuration = events.reduce((sum, ev) => sum + (ev.end - ev.start), 0);
  const maxLayer = events.reduce((max, ev) => Math.max(max, ...ev.words.map((w) => w.layer), 0), 0);
  return {
    eventCount: events.length,
    wordCount,
    maxLayer,
    totalDuration: Math.round(totalDuration * 1000) / 1000,
    avgWordsPerEvent: events.length ? Math.round((wordCount / events.length) * 100) / 100 : 0,
  };
}

export function validateCaptions(
  events: KineticCaptionEvent[],
  cues: MotionCue[] = []
): CaptionQCResult {
  const issues: string[] = [];
  const warnings: string[] = [];

  if (events.length === 0) {
    return { ok: false, issues: ['No caption events to validate'], warnings: [], stats: calcStats(events) };
  }

  for (const ev of events) {
    if (ev.words.length === 0) {
      issues.push(`Event at ${ev.start}s has no words`);
    }

    for (const w of ev.words) {
      if (w.end - w.start > MAX_WORD_DURATION) {
        warnings.push(`Word "${w.text.slice(0, 20)}" at ${w.start}s lasts ${(w.end - w.start).toFixed(2)}s — may appear static`);
      }
      if (!Object.values(['typewriter', 'pop', 'slide_left', 'slide_right', 'bounce', 'highlight', 'none']).includes(w.effect)) {
        warnings.push(`Unknown effect "${w.effect}" on word "${w.text.slice(0, 20)}" at ${w.start}s`);
      }
    }

    for (let i = 1; i < ev.words.length; i++) {
      const prev = ev.words[i - 1];
      const curr = ev.words[i];
      if (curr.start - prev.end < -MIN_WORD_GAP) {
        issues.push(`Overlapping words in event at ${ev.start}s: "${prev.text}" and "${curr.text}"`);
      }
    }
  }

  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];
    if (prev.end > curr.start) {
      const overlap = prev.end - curr.start;
      const ratio = overlap / (prev.end - prev.start);
      if (ratio > MAX_OVERLAP_RATIO) {
        issues.push(`Event at ${prev.start}s overlaps event at ${curr.start}s by ${(overlap * 100).toFixed(0)}ms`);
      } else {
        warnings.push(`Minor event overlap at ${curr.start}s (${(overlap * 100).toFixed(0)}ms)`);
      }
    }
  }

  const emphasisCues = cues.filter((c) => c.kind === 'emphasis');
  if (emphasisCues.length > MAX_CONCURRENT_EFFECTS) {
    warnings.push(`Too many emphasis cues (${emphasisCues.length}) may cause visual overload`);
  }

  const highIntensityCues = cues.filter((c) => (c.intensity || 0.5) > 0.9);
  for (const cue of highIntensityCues) {
    warnings.push(`Very high intensity cue (${(cue.intensity || 1).toFixed(2)}) at ${cue.t}s may be jarring`);
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    stats: calcStats(events),
  };
}

export function repairCaptions(
  events: KineticCaptionEvent[],
  cues: MotionCue[] = []
): CaptionQCFix {
  const changes: string[] = [];
  const fixedEvents: KineticCaptionEvent[] = JSON.parse(JSON.stringify(events));

  for (const ev of fixedEvents) {
    for (const w of ev.words) {
      if (w.end - w.start > MAX_WORD_DURATION) {
        const newEnd = w.start + MAX_WORD_DURATION;
        changes.push(`Capped word "${w.text.slice(0, 20)}" duration from ${(w.end - w.start).toFixed(2)}s to ${MAX_WORD_DURATION}s`);
        w.end = newEnd;
      }

      for (let i = 1; i < ev.words.length; i++) {
        const prev = ev.words[i - 1];
        const curr = ev.words[i];
        if (curr.start - prev.end < -MIN_WORD_GAP) {
          curr.start = prev.end + MIN_WORD_GAP;
          changes.push(`Fixed overlapping word "${curr.text.slice(0, 20)}" in event at ${ev.start}s`);
        }
      }
    }
  }

  for (let i = 1; i < fixedEvents.length; i++) {
    const prev = fixedEvents[i - 1];
    const curr = fixedEvents[i];
    if (prev.end > curr.start) {
      const overlap = prev.end - curr.start;
      if (overlap > 0.1) {
        prev.end = curr.start - 0.05;
        prev.end = Math.max(prev.start + 0.35, prev.end);
        changes.push(`Shrunk event at ${prev.start}s to prevent overlap with event at ${curr.start}s`);
      }
    }
  }

  const highIntensityCues = cues.filter((c) => (c.intensity || 0.5) > 0.9);
  if (highIntensityCues.length > 0) {
    changes.push(`Warning: ${highIntensityCues.length} high-intensity cues remain — consider manual review`);
  }

  const result = validateCaptions(fixedEvents, cues);

  return {
    fixed: result.ok || changes.length > 0,
    changes,
    events: fixedEvents,
  };
}

export function checkCaptionReadability(events: KineticCaptionEvent[]): {
  ok: boolean;
  avgReadTime: number;
  issues: string[];
} {
  const issues: string[] = [];
  const readSpeeds: number[] = [];

  const CHAR_PER_SECOND = 15;

  for (const ev of events) {
    for (const w of ev.words) {
      const dur = w.end - w.start;
      const chars = w.text.length;
      if (dur > 0) {
        const cps = chars / dur;
        readSpeeds.push(cps);
        if (cps > CHAR_PER_SECOND * 2.5) {
          issues.push(`Word "${w.text.slice(0, 20)}" at ${w.start}s reads very fast (${cps.toFixed(0)} chars/s)`);
        }
      }
    }
  }

  const avgReadTime = readSpeeds.length
    ? readSpeeds.reduce((a, b) => a + b, 0) / readSpeeds.length
    : 0;

  return {
    ok: issues.length === 0,
    avgReadTime: Math.round(avgReadTime * 100) / 100,
    issues,
  };
}
