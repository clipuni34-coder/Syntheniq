import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR } from '../config.js';
import type { ClipPlan, MediaInfo, MotionCue, MotionStyle } from './types.js';
import { cutAudioWav, cutSegment, mixAudio } from './media.js';
import { buildSpecMotion } from './motion.js';
import type { Graphic } from './graphics.js';

export interface CompSegment {
  file: string; // basename in comp assets
  compStart: number;
  compDur: number;
  srcStart: number;
  srcEnd: number;
}

export interface CompSpec {
  clipId: string;
  fps: number;
  totalDur: number;
  segments: CompSegment[];
  cutaways: { file: string; compStart: number; compDur: number }[];
  punchIns: { compTime: number; zoom: number }[];
  callouts: { compTime: number; text: string; style: string }[];
  hookText: string;
  ctaText: string;
  music: string;
  energy: number;
  audioFile: string; // mixed.m4a basename
  motion: MotionCue[]; // comp-time motion cues (visual + SFX)
  motionStyle: MotionStyle;
  graphics: (Graphic & { compTime: number })[]; // visual-storytelling graphics (comp time)
}

/** Map a source-timeline time to composition time for this clip (null if cut away). */
export function srcToComp(segments: CompSegment[], t: number): number | null {
  for (const s of segments) {
    if (t >= s.srcStart - 0.02 && t <= s.srcEnd + 0.02) return s.compStart + (t - s.srcStart);
  }
  return null;
}

/**
 * Stage: prep-media — cut kept segments (reframed 1080x1920, silent),
 * cut B-roll cutaways, build the final audio mix (voice + ducked music + SFX).
 */
export async function prepClipMedia(
  clip: ClipPlan,
  index: number,
  media: MediaInfo,
  projectDir: string,
  onLog: (msg: string) => void,
): Promise<CompSpec> {
  const mediaDir = path.join(projectDir, 'media', clip.id);
  const assetsDir = path.join(mediaDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  // ── segments (optional cold-open teaser first) ────────────────────────
  // The retention architecture may open with a brief (1.5-3.5s) teaser from
  // LATER kept footage — the only non-chronological element. After it, the
  // main narrative plays strictly chronological (lip-sync preserved).
  const teaser = clip.retention?.teaser;
  const pieces: { file: string; srcStart: number; srcEnd: number; label: string }[] = [];
  if (teaser && teaser.sourceEnd - teaser.sourceStart >= 1.2) {
    pieces.push({ file: 'teaser.mp4', srcStart: teaser.sourceStart, srcEnd: teaser.sourceEnd, label: 'cold-open teaser' });
    onLog(`[prep] ${clip.id} ${pieces[0].label}: src ${teaser.sourceStart.toFixed(1)}-${teaser.sourceEnd.toFixed(1)}s — ${teaser.reason}`);
  }
  clip.segments.forEach((s, i) =>
    pieces.push({ file: `seg-${String(i).padStart(3, '0')}.mp4`, srcStart: s.start, srcEnd: s.end, label: `seg${i}` }),
  );

  const segments: CompSegment[] = [];
  let compT = 0;
  for (const p of pieces) {
    const dur = p.srcEnd - p.srcStart;
    onLog(`[prep] ${clip.id} ${p.label}: ${p.srcStart.toFixed(1)}-${p.srcEnd.toFixed(1)}s (${dur.toFixed(1)}s)`);
    await cutSegment(media.path, path.join(assetsDir, p.file), p.srcStart, dur, media);
    const wavFile = p.file.replace(/\.mp4$/, '.wav');
    await cutAudioWav(media.path, path.join(mediaDir, wavFile), p.srcStart, dur);
    segments.push({ file: p.file, compStart: r3(compT), compDur: r3(dur), srcStart: p.srcStart, srcEnd: p.srcEnd });
    compT += dur;
  }
  const totalDur = compT;

  // ── cutaways (B-roll from other parts of the source) ─────────────────
  const cutaways: { file: string; compStart: number; compDur: number }[] = [];
  for (let k = 0; k < clip.cutaways.length; k++) {
    const c = clip.cutaways[k];
    const file = `cut-${String(k).padStart(3, '0')}.mp4`;
    // place the cutaway at the same composition time as the source-time cue if kept, else middle
    const at = srcToComp(segments, c.sourceTime) ?? totalDur / 2;
    const bias = k % 2 === 0 ? 0.22 : 0.78; // alternate framing
    await cutSegment(media.path, path.join(assetsDir, file), c.sourceTime, c.duration, media, { cropBiasX: bias });
    cutaways.push({ file, compStart: Math.max(0.3, Math.min(at, totalDur - c.duration - 0.2)), compDur: c.duration });
    onLog(`[prep] ${clip.id} cutaway${k} @ comp ${cutaways[k].compStart.toFixed(1)}s (src ${c.sourceTime.toFixed(1)}s)`);
  }

  const punchIns = clip.punchIns
    .map((p) => ({ compTime: srcToComp(segments, p.time), zoom: p.zoom }))
    .filter((p): p is { compTime: number; zoom: number } => p.compTime != null)
    .map((p) => ({ compTime: Math.max(0.2, Math.min(p.compTime, totalDur - 1.6)), zoom: p.zoom }))
    .sort((a, b) => a.compTime - b.compTime);

  // ── visual-storytelling graphics (source → comp time; cut-away ones drop) ──
  const graphics: (Graphic & { compTime: number })[] = (clip.graphics ?? [])
    .map((g): (Graphic & { compTime: number }) | null => {
      const ct = srcToComp(segments, g.t);
      if (ct == null) return null; // the moment that earned it was cut
      return { ...g, compTime: Math.max(0.4, Math.min(ct, totalDur - 3.3)) }; // full display (incl. exit) must fit
    })
    .filter((g): g is Graphic & { compTime: number } => g != null)
    .slice(0, 4);

  // ── motion-graphics cues (comp time; gap cues dropped) ────────────────
  const motion = buildSpecMotion(clip, segments, punchIns, totalDur);
  // the cold-open cut into the main narrative is a hard cut → flash transition
  if (teaser && segments.length > 1) {
    const firstMain = segments[1].compStart;
    const tr = motion.find((m) => m.kind === 'transition' && Math.abs(m.t - firstMain) < 0.02);
    if (tr) tr.variant = 'flash';
  }
  const motionStyle = clip.motion?.style ?? { tempo: clip.energy < 0.35 ? 'calm' : clip.energy < 0.6 ? 'steady' : 'energetic' };

  // ── audio mix ─────────────────────────────────────────────────────────
  const musicFile =
    clip.music === 'none'
      ? null
      : path.join(ASSETS_DIR, 'audio', 'beds', clip.music === 'drive' ? 'bed_drive.m4a' : 'bed_chill.m4a');

  const sfx: { file: string; at: number; vol: number }[] = [];
  const push = (name: string, at: number, vol: number) => {
    const t = Math.max(0, Math.min(at, totalDur - 0.1));
    sfx.push({ file: path.join(ASSETS_DIR, 'audio', 'sfx', `${name}.m4a`), at: t, vol });
  };
  push('pop', 0.05, 0.4); // hook impact
  for (const p of punchIns) push('whoosh', p.compTime, 0.5);
  for (const c of motion) {
    if (c.kind === 'impact') push('hit', c.t, 0.5 * (0.6 + (c.intensity ?? 0.6) * 0.6));
    else if (c.kind === 'lowerThird') push('whoosh', c.t, 0.22);
    else if (c.kind === 'transition' && c.variant === 'wipe') push('whoosh', c.t - 0.08, 0.18);
  }
  for (const g of graphics) {
    if (g.type === 'stat' || g.type === 'progress') push('pop', g.compTime, 0.3);
  }
  if (totalDur > 6) push('riser', totalDur - 3.0, 0.3);
  push('hit', totalDur - 2.4, 0.45); // CTA impact
  // drop SFX that fall inside a cut gap (no voice moment)
  const sfxCues = sfx.filter((s) => {
    const at = s.at;
    return segments.some((seg) => at >= seg.compStart - 0.1 && at <= seg.compStart + seg.compDur + 0.1);
  });

  const mixedFile = 'mixed.m4a';
  await mixAudio(
    segments.map((s) => ({ file: path.join(mediaDir, s.file.replace(/\.mp4$/, '.wav')), dur: s.compDur })),
    totalDur,
    musicFile && (await fileExists(musicFile)) ? musicFile : null,
    sfxCues,
    path.join(mediaDir, mixedFile),
  );

  type CalloutT = { compTime: number | null; text: string; style: 'label' | 'stat' | 'quote' };
  const callouts = clip.callouts
    .map((c): CalloutT => ({ compTime: srcToComp(segments, c.time), text: c.text, style: c.style }))
    .filter((c): c is Omit<CalloutT, 'compTime'> & { compTime: number } => c.compTime != null)
    .map((c) => ({ ...c, compTime: Math.max(0.4, Math.min(c.compTime, totalDur - 1.6)) }));

  onLog(`[prep] ${clip.id}: ${segments.length} segments, ${totalDur.toFixed(1)}s comp, ${cutaways.length} cutaways, ${punchIns.length} punch-ins, ${motion.length} motion cues, ${graphics.length} graphics`);

  return {
    clipId: clip.id,
    fps: media.fps,
    totalDur: r3(totalDur),
    segments,
    cutaways,
    punchIns,
    callouts,
    hookText: clip.hookText,
    ctaText: clip.cta.text,
    music: clip.music,
    energy: clip.energy,
    audioFile: mixedFile,
    motion,
    motionStyle,
    graphics,
  };
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
