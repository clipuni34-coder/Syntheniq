// Syntheniq — caption engine: word timestamps → phrase events → ASS track.
// Enhanced with TikTok-style animated captions: bounce, pop, slide effects,
// bottom-third positioning with semi-transparent backgrounds, dynamic styling.
import fs from 'node:fs';
import type { Word } from '../../types.js';
import type { MotionCue } from '../editorial/motion.js';
import type { AnalysisData } from '../../types.js';

export interface CaptionEvent {
  start: number;
  end: number;
  text: string;
}

export type KineticWordEffect =
  | 'typewriter'
  | 'pop'
  | 'slide_left'
  | 'slide_right'
  | 'bounce'
  | 'highlight'
  | 'color_swap'
  | 'pulse'
  | 'scale_up'
  | 'slide_in'
  | 'none';

export interface KineticWord {
  start: number;
  end: number;
  text: string;
  effect: KineticWordEffect;
  emphasis: number;
  layer: number;
}

export interface KineticCaptionEvent {
  start: number;
  end: number;
  words: KineticWord[];
  style: string;
}

export function toKineticWords(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  motionCues?: MotionCue[],
  analysis?: AnalysisData
): KineticWord[] {
  const clipLen = Math.max(0.1, clipEnd - clipStart);
  const ks = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
    .filter((w) => w.end > clipStart + 0.05 && w.start < clipEnd - 0.05)
    .map((w) => ({
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipLen, Math.max(w.start - clipStart + 0.08, w.end - clipStart)),
      text: String(w.word || '').trim(),
      effect: 'none' as KineticWordEffect,
      emphasis: 0,
      layer: 0,
    }))
    .filter((w) => w.text.length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  // Theme-aware caption intensity
  const theme = (analysis?.structure?.stats?.theme as string) || 'general';
  const themeIntensity: Record<string, number> = {
    shock: 0.9,
    listicle: 0.75,
    tutorial: 0.6,
    cinematic: 0.5,
    general: 0.7,
  };
  const baseIntensity = themeIntensity[theme] || 0.7;

  const cueDurations = (motionCues || []).filter((c) => c.kind === 'emphasis').map((c) => c.duration);
  const avgCueDur = cueDurations.length ? cueDurations.reduce((a, b) => a + b, 0) / cueDurations.length : 1.5;

  for (let i = 0; i < ks.length; i++) {
    const w = ks[i];
    const isPunctuation = /^[.,!?;:'"…]$/.test(w.text);
    const dur = w.end - w.start;
    const isFirstWord = i === 0;
    const isEndSentence = /[.!?…]$/.test(w.text);

    if (isPunctuation && (w.text === '!' || w.text === '?')) {
      // Strong punctuation gets bounce + pop for maximum emphasis
      w.effect = 'bounce';
      w.emphasis = Math.min(1, baseIntensity + 0.3);
      w.layer = Math.floor(w.emphasis * 12);
    } else if (isPunctuation) {
      w.effect = 'pop';
      w.emphasis = baseIntensity;
      w.layer = 5;
    } else if (dur > 0.15) {
      const intensity = Math.min(1, dur / avgCueDur);
      // First word gets scale-up entrance
      if (isFirstWord) {
        w.effect = 'scale_up';
        w.emphasis = Math.min(1, intensity + 0.2);
        w.layer = 8;
      } else if (isEndSentence) {
        // End of sentence words get highlight
        w.effect = 'highlight';
        w.emphasis = intensity;
        w.layer = 6;
      } else if (intensity > 0.8) {
        w.effect = 'bounce';
        w.emphasis = intensity;
        w.layer = Math.floor(intensity * 3);
      } else if (intensity > 0.6) {
        w.effect = 'slide_in';
        w.emphasis = intensity;
        w.layer = 4;
      } else if (intensity > 0.4) {
        w.effect = 'pulse';
        w.emphasis = intensity;
        w.layer = 3;
      } else {
        w.effect = 'typewriter';
        w.emphasis = intensity;
        w.layer = 1;
      }
    } else if (dur > 0.08) {
      // Short words get subtle pop
      w.effect = 'pop';
      w.emphasis = dur / 0.15 * 0.5;
      w.layer = 3;
    }

    // Motion cues override for emphasis moments
    if (motionCues) {
      for (const cue of motionCues) {
        if (w.start <= cue.t - clipStart && w.end >= cue.t - clipStart && cue.kind === 'emphasis') {
          w.effect = 'bounce';
          w.emphasis = Math.min(1, (cue.intensity || 0.7) + 0.3);
          w.layer = 10;
        }
      }
    }
  }

  return ks;
}

export function buildKineticCaptions(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  motionCues?: MotionCue[],
  analysis?: AnalysisData,
  {
    maxWords = 5,
    maxDur = 1.8,
  }: { maxWords?: number; maxDur?: number } = {}
): KineticCaptionEvent[] {
  const kinetic = toKineticWords(words, clipStart, clipEnd, motionCues, analysis);
  const clipLen = Math.max(0.1, clipEnd - clipStart);

  const events: KineticCaptionEvent[] = [];
  let group: KineticWord[] = [];

  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    let end = group[group.length - 1].end;
    end = Math.max(end, start + 0.35);

    const maxLayer = Math.max(...group.map((w) => w.layer), 0);
    let style = 'neutral';
    const hasBounce = group.some((w) => w.effect === 'bounce');
    const hasSlideIn = group.some((w) => w.effect === 'slide_in');
    const hasScaleUp = group.some((w) => w.effect === 'scale_up');
    const hasPulse = group.some((w) => w.effect === 'pulse');
    const hasPop = group.some((w) => w.effect === 'pop');
    if (hasBounce) style = 'emphatic';
    else if (hasScaleUp) style = 'entrance';
    else if (hasSlideIn) style = 'dynamic';
    else if (hasPulse) style = 'rhythmic';
    else if (hasPop) style = 'punchy';

    events.push({
      start,
      end: round3(Math.min(clipLen, end)),
      words: [...group],
      style,
    });
    group = [];
  };

  for (const w of kinetic) {
    const wouldStart = group.length ? group[0].start : w.start;
    const tooLong = group.length > 0 && w.end - wouldStart > maxDur;
    if (group.length >= maxWords || tooLong) flush();
    group.push(w);
    if (/[.!?…,:;]$/.test(w.text) && group.length >= 2) flush();
  }
  flush();

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].end > events[i + 1].start - 0.04) {
      events[i].end = round3(Math.max(events[i].start + 0.2, events[i + 1].start - 0.04));
    }
  }

  return events;
}

function effectParams(effect: KineticWordEffect, emphasis: number): string {
  const e = Math.min(1, Math.max(0, emphasis));
  switch (effect) {
    case 'typewriter':
      return 'fs=' + Math.round(30 + e * 10) + ':alpha=<\\h,1000\\,1>';
    case 'pop':
      return 'fs=' + Math.round(50 + e * 40) + ':alpha=<0\\,1\\,,1>0:blur=0\\,5\\,0';
    case 'slide_left':
      return 'fs=40:x=' + (Math.round(-20 - e * 30)) + '->' + (Math.round(10 + e * 10));
    case 'slide_right':
      return 'fs=40:x=' + (Math.round(10 + e * 10)) + '->' + (Math.round(-20 - e * 30));
    case 'bounce':
      return 'fs=' + Math.round(40 + e * 20) + ':y=<0\\,20\\,0\\,10\\,0>';
    case 'highlight':
      return 'fs=40:boxcolor=yellow@' + (e * 0.3).toFixed(2);
    case 'color_swap':
      return 'fs=40:boxcolor=green@' + (e * 0.2).toFixed(2);
    case 'pulse':
      return 'fs=' + Math.round(40 + e * 10) + ':fs=' + Math.round(40 + e * 10) + ':alpha=<0\\,0.7\\,0>';
    case 'scale_up':
      return 'fs=' + Math.round(40 + e * 15) + ':x=50:y=50:fs=' + Math.round(40 + e * 15);
    case 'slide_in':
      return 'fs=40:y=' + Math.round(-30 - e * 20) + '->0';
    default:
      return 'fs=36';
  }
}

export function buildKineticASS(events: KineticCaptionEvent[], { title = 'Syntheniq captions' }: { title?: string } = {}): string {
  const lines = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans Bold,72,&H00FFFFFF,&H000019FF,&H80000000,&H80000000,-1,0,0,0,100,100,0.5,0,1,3,1,2,60,60,300,1',
    'Style: Emphatic,DejaVu Sans Bold,88,&H00FFFF00,&H000019FF,&H80000000,&HC0000000,-1,0,0,0,115,115,0.5,0,1,4,2,8,60,60,280,1',
    'Style: Dynamic,DejaVu Sans Bold,76,&H00FFFFFF,&H000019FF,&H80000000,&HC0000000,-1,0,0,0,108,108,1,0,1,3,2,8,60,60,280,1',
    'Style: Punchy,DejaVu Sans Bold,82,&H00FF8800,&H000019FF,&H80000000,&HC0000000,-1,0,0,0,112,112,0.8,0,1,3,2,8,60,60,280,1',
    'Style: Entrance,DejaVu Sans Bold,80,&H0019FFFF,&H000019FF,&H80000000,&HC0000000,-1,0,0,0,113,113,0.5,0,1,3,2,8,60,60,280,1',
    'Style: Rhythmic,DejaVu Sans Bold,74,&H00FF66FF,&H000019FF,&H80000000,&HC0000000,-1,0,0,0,106,106,0.7,0,1,3,2,8,60,60,280,1',
    'Style: GreenEmphasis,DejaVu Sans Bold,82,&H0000FF00,&H000019FF,&H80000000,&H80000000,-1,0,0,0,110,110,0.5,0,1,3,1,2,60,60,300,1',
    'Style: RedEmphasis,DejaVu Sans Bold,82,&H000000FF,&H000019FF,&H80000000,&H80000000,-1,0,0,0,110,110,0.5,0,1,3,1,2,60,60,300,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const ev of events) {
    const text = ev.words.map((w) => escapeAss(w.text)).join(' ');
    const styleName =
      ev.style === 'emphatic' ? 'Emphatic'
      : ev.style === 'dynamic' ? 'Dynamic'
      : ev.style === 'punchy' ? 'Punchy'
      : ev.style === 'entrance' ? 'Entrance'
      : ev.style === 'rhythmic' ? 'Rhythmic'
      : 'Default';

    const layer = ev.words.length > 0 ? Math.max(...ev.words.map((w) => w.layer), 0) : 0;

    let effect = '';
    if (ev.words.length === 1) {
      const w = ev.words[0];
      effect = effectParams(w.effect, w.emphasis);
    }

    lines.push(
      `Dialogue: ${layer}, ${fmtAssTime(ev.start)}, ${fmtAssTime(ev.end)}, ${styleName}, ,0,0,0,${effect},${text}`
    );
  }

  return lines.join('\n') + '\n';
}

export function buildCaptionEvents(
  words: Word[] | undefined | null,
  clipStart: number,
  clipEnd: number,
  { maxWords = 4, maxDur = 1.6 }: { maxWords?: number; maxDur?: number } = {}
): CaptionEvent[] {
  const clipLen = Math.max(0.1, clipEnd - clipStart);
  const inRange = (words || [])
    .filter((w) => w && Number.isFinite(w.start) && Number.isFinite(w.end))
    .filter((w) => w.end > clipStart + 0.05 && w.start < clipEnd - 0.05)
    .map((w) => ({
      start: Math.max(0, w.start - clipStart),
      end: Math.min(clipLen, Math.max(w.start - clipStart + 0.08, w.end - clipStart)),
      word: String(w.word || '').trim(),
    }))
    .filter((w) => w.word.length > 0 && w.end > w.start)
    .sort((a, b) => a.start - b.start);

  const events: CaptionEvent[] = [];
  let group: typeof inRange = [];
  const flush = () => {
    if (!group.length) return;
    const start = group[0].start;
    let end = group[group.length - 1].end;
    end = Math.max(end, start + 0.35);
    const text = group
      .map((g) => g.word)
      .join(' ')
      .replace(/\s+([.,!?;:…%])(\s|$)/g, '$1$2')
      .trim();
    if (text) events.push({ start: round3(start), end: round3(Math.min(clipLen, end)), text });
    group = [];
  };

  for (const w of inRange) {
    const wouldStart = group.length ? group[0].start : w.start;
    const tooLong = group.length > 0 && w.end - wouldStart > maxDur;
    if (group.length >= maxWords || tooLong) flush();
    group.push(w);
    if (/[.!?…,:;]$/.test(w.word) && group.length >= 2) flush();
  }
  flush();

  for (let i = 0; i < events.length - 1; i++) {
    if (events[i].end > events[i + 1].start - 0.04) {
      events[i].end = round3(Math.max(events[i].start + 0.2, events[i + 1].start - 0.04));
    }
  }
  return events;
}

export function splitTwoLines(text: string, maxLen = 20): string {
  const clean = String(text || '').trim();
  if (clean.length <= maxLen) return clean;
  const words = clean.split(/\s+/);
  if (words.length < 2) return clean;
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return words.slice(0, best).join(' ') + '\\N' + words.slice(best).join(' ');
}

export function escapeAss(text: string): string {
  return String(text || '')
    .replace(/[{}]/g, '')
    .replace(/\\/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function fmtAssTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const cc = Math.floor((s * 100) % 100);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(ss)}.${pad(cc)}`;
}

export function buildASS(events: CaptionEvent[] | undefined | null, { title = 'Syntheniq captions' }: { title?: string } = {}): string {
  const lines = [
    '[Script Info]',
    `Title: ${title}`,
    'ScriptType: v4.00+',
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,DejaVu Sans Bold,72,&H00FFFFFF,&H000019FF,&H80000000,&H80000000,-1,0,0,0,100,100,0.5,0,1,3,1,2,60,60,300,1',
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  for (const ev of events || []) {
    const text = splitTwoLines(escapeAss(ev.text));
    lines.push(`Dialogue: 0,${fmtAssTime(ev.start)},${fmtAssTime(ev.end)},Default,,0,0,0,,${text}`);
  }
  return lines.join('\n') + '\n';
}

export function writeASS(
  filePath: string,
  events: CaptionEvent[],
  opts?: { title?: string }
): { filePath: string; eventCount: number } {
  const content = buildASS(events, opts);
  fs.writeFileSync(filePath, content, 'utf8');
  return { filePath, eventCount: events.length };
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
