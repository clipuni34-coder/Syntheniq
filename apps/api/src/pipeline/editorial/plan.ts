// Syntheniq — edit-decision layer: plans the complete clip structure
// before any FFmpeg rendering. Translates emotion trajectory + retention
// beats + motion cues into a concrete EditDecision with segments,
// keyframe-style cuts, and transition metadata.
import type { Segment, Word, EnergyPoint, Span } from '../../types.js';
import type { EmotionEvent, EmotionTrajectory, EmotionIntelligence } from './emotion.js';
import type { RetentionPlan, RetentionBeat } from './retention.js';
import type { MotionPlan, MotionCue, MediaInfo } from './motion.js';

export interface EditSegment {
  id: string;
  start: number;
  end: number;
  duration: number;
  source: string;
  title: string;
  purpose: 'hook' | 'narrative' | 'payoff' | 'transition' | 'closer' | 'bridge' | 'curiosity';
  transitions: { in: string | null; out: string | null };
  cues: MotionCue[];
  notes: string[];
}

export interface EditDecision {
  id: string;
  title: string;
  duration: number;
  segments: EditSegment[];
  motion: MotionPlan;
  retention: RetentionPlan;
  emotion: EmotionIntelligence;
  summary: string;
  media: MediaInfo;
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const r2 = (n: number): number => Math.round(n * 100) / 100;

function durationOf(segments: Segment[]): number {
  if (!segments.length) return 0;
  return Math.max(...segments.map((s) => s.end));
}

function findKeyphrases(
  segments: Segment[],
  emotionEvents: EmotionEvent[],
  retentionBeats: RetentionBeat[]
): Array<{ text: string; start: number; end: number; emphasis: number }> {
  const keyphrases: Array<{ text: string; start: number; end: number; emphasis: number }> = [];

  for (const event of emotionEvents) {
    if (event.type === 'revelation' || event.type === 'payoff' || event.type === 'crisis') {
      const seg = segments.find((s) => s.start <= event.t && s.end >= event.t);
      if (seg && segText(seg).trim()) {
        keyphrases.push({
          text: segText(seg).slice(0, 80),
          start: event.t - 1,
          end: event.t + 2,
          emphasis: clamp01(event.intensity * 0.7 + 0.3),
        });
      }
    }
  }

  for (const beat of retentionBeats) {
    if (beat.role === 'teaser' || beat.role === 'payoff' || beat.role === 'curiosity') {
      const seg = segments.find((s) => s.start <= beat.start && s.end >= beat.start);
      if (seg && segText(seg).trim()) {
        if (!keyphrases.some((kp) => Math.abs(kp.start - beat.start) < 1.5)) {
          keyphrases.push({
            text: segText(seg).slice(0, 80),
            start: beat.start,
            end: beat.end,
            emphasis: clamp01(beat.confidence),
          });
        }
      }
    }
  }

  return keyphrases
    .sort((a, b) => a.start - b.start)
    .slice(0, 8);
}

function segText(s: Segment): string {
  return (s as any).text || '';
}

function planSegments(
  editStart: number,
  editEnd: number,
  segments: Segment[],
  words: Word[],
  emotionEvents: EmotionEvent[],
  retentionBeats: RetentionBeat[],
  media: MediaInfo
): EditSegment[] {
  const editSegments: EditSegment[] = [];

  const relevantEvents = emotionEvents.filter((e) => e.t >= editStart && e.t <= editEnd);
  const relevantBeats = retentionBeats.filter((b) => b.end > editStart && b.start < editEnd);

  const keyphrases = findKeyphrases(segments, relevantEvents, relevantBeats);

  const cutPoints: number[] = [editStart];

  for (const event of relevantEvents) {
    if (event.type === 'crisis' || event.type === 'revelation' || event.type === 'payoff') {
      cutPoints.push(clamp01(event.t), event.t);
    }
  }

  for (const beat of relevantBeats) {
    if (['teaser', 'payoff', 'curiosity'].includes(beat.role)) {
      cutPoints.push(r2(beat.start), r2(beat.end));
    }
  }

  cutPoints.push(editEnd);

  const uniqueCuts = [...new Set(cutPoints)]
    .filter((t) => t >= editStart && t <= editEnd)
    .sort((a, b) => a - b);

  if (uniqueCuts.length < 2) {
    uniqueCuts.splice(1, 0, editStart + (editEnd - editStart) / 2);
  }

  for (let i = 0; i < uniqueCuts.length - 1; i++) {
    const start = uniqueCuts[i];
    const end = uniqueCuts[i + 1];
    const dur = end - start;
    if (dur < 1.5) continue;

    const segStart = start;
    const segEnd = end;
    const midpoint = (segStart + segEnd) / 2;

    let purpose: EditSegment['purpose'] = 'narrative';
    let title = `segment-${i + 1}`;
    const notes: string[] = [];

    const eventAt = relevantEvents.find((e) => Math.abs(e.t - midpoint) < dur / 2);
    const beatAt = relevantBeats.find((b) => b.start <= midpoint && b.end >= midpoint);

    if (eventAt) {
      if (eventAt.type === 'crisis') {
        purpose = 'narrative';
        title = 'conflict';
        notes.push(`Emotional crisis: ${eventAt.label}`);
      } else if (eventAt.type === 'revelation') {
        purpose = 'payoff';
        title = 'revelation';
        notes.push(`Key revelation at ${r2(eventAt.t)}s`);
      }
    } else if (beatAt) {
      purpose = beatAt.role === 'teaser' ? 'hook' : beatAt.role === 'payoff' ? 'payoff' : beatAt.role === 'curiosity' ? 'curiosity' : 'narrative';
      title = beatAt.label;
      notes.push(`Retention role: ${beatAt.role}`);
    }

    if (i === 0) {
      purpose = 'hook';
      title = 'opening';
      if (relevantEvents.find((e) => e.type === 'hook')) {
        notes.push('Opening hook detected');
      }
    }

    if (i === uniqueCuts.length - 2) {
      purpose = 'closer';
      title = 'closing';
      notes.push('End of clip');
    }

    if (notes.length === 0) {
      notes.push('Narrative segment');
    }

    editSegments.push({
      id: `seg-${i + 1}`,
      start: r2(segStart),
      end: r2(segEnd),
      duration: r2(dur),
      source: 'main',
      title,
      purpose,
      transitions: { in: null, out: null },
      cues: [],
      notes,
    });
  }

  return editSegments;
}

function applyTransitions(segments: EditSegment[]): EditSegment[] {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (i > 0) {
      const prev = segments[i - 1];
      if (prev.purpose === 'hook' || prev.purpose === 'payoff') {
        seg.transitions.in = 'flash';
      } else if (prev.purpose === 'narrative' && seg.purpose === 'payoff') {
        seg.transitions.in = 'wipe';
      } else {
        seg.transitions.in = 'dissolve';
      }
    }
    if (i < segments.length - 1) {
      const next = segments[i + 1];
      if (seg.purpose === 'payoff' && next.purpose === 'narrative') {
        seg.transitions.out = 'wipe';
      } else if (seg.purpose === 'hook') {
        seg.transitions.out = 'flash';
      } else {
        seg.transitions.out = 'dissolve';
      }
    }
  }
  return segments;
}

function applyCues(
  segments: EditSegment[],
  motionPlan: MotionPlan,
  editStart: number,
  editEnd: number
): EditSegment[] {
  for (const cue of motionPlan.cues) {
    const segIdx = segments.findIndex((s) => cue.t >= s.start + editStart && cue.t <= s.end + editStart);
    if (segIdx >= 0) {
      const seg = segments[segIdx];
      if (seg.cues.length < 3) {
        seg.cues.push(cue);
      }
    }
  }
  return segments;
}

export function buildEditDecision(
  input: {
    startTime: number;
    endTime: number;
    segments: Segment[];
    words: Word[];
    energyCurve: EnergyPoint[];
    silences: Span[];
    media: MediaInfo;
  },
  analysis: {
    emotion: EmotionIntelligence;
    retention: RetentionPlan;
    motion: MotionPlan;
  }
): EditDecision {
  const { startTime, endTime, segments, words, energyCurve, silences, media } = input;
  const { emotion, retention, motion } = analysis;

  const segs = segments.filter((s) => s.end > startTime && s.start < endTime);
  const relevantEvents = emotion.events.filter((e) => e.t >= startTime && e.t <= endTime);
  const relevantBeats = retention.beats.filter((b) => b.end > startTime && b.start < endTime);

  let editSegments = planSegments(startTime, endTime, segs, words, relevantEvents, relevantBeats, media);
  editSegments = applyTransitions(editSegments);
  editSegments = applyCues(editSegments, motion, startTime, endTime);

  const duration = r2(endTime - startTime);
  const title = `Clip ${r2(startTime)}–${r2(endTime)}s`;
  const summary = `${editSegments.length} segments | ${editSegments.filter((s) => s.purpose === 'hook').length} hooks | ${editSegments.filter((s) => s.purpose === 'payoff').length} payoffs`;

  return {
    id: `edit-${r2(startTime)}-${r2(endTime)}`,
    title,
    duration,
    segments: editSegments,
    motion,
    retention,
    emotion,
    summary,
    media,
  };
}
