// Syntheniq — caption engine: word timestamps → phrase events → ASS track.
import fs from 'node:fs';
import type { Word } from '../../types.js';

export interface CaptionEvent {
  start: number;
  end: number;
  text: string;
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
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    'Style: Default,Inter,72,&H00FFFFFF,&H000019FF,&H80000000,&H80000000,-1,0,0,0,100,100,0.5,0,1,3,1,2,60,60,300,1',
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
