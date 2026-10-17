import path from 'node:path';
import fs from 'node:fs';
import { run } from '../../lib/ffmpeg.js';
import type { EditDecision } from '../editorial/plan.js';
import type { MotionCue } from '../editorial/motion.js';
import { ensureDir } from '../../lib/paths.js';
import { randomUUID } from 'node:crypto';

export type SfxType = 'whoosh' | 'swoosh' | 'pop' | 'click' | 'hum' | 'tone' | 'impact';

export interface SoundEffect {
  id: string;
  type: SfxType;
  start: number;
  duration: number;
}

export interface SfxContext {
  clipDir: string;
  clipDuration: number;
}

export interface SfxResult {
  effects: SoundEffect[];
  audioFiles: string[];
  notes: string[];
}

const SFX_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'sfx_cache');

const SFX_DURATIONS: Record<SfxType, number> = {
  whoosh: 2.0,
  swoosh: 1.5,
  pop: 0.3,
  click: 0.1,
  hum: 3.0,
  tone: 1.0,
  impact: 0.5,
};

async function generateSfxFile(
  sfxType: SfxType,
  intensity: number,
  outDir: string,
  id: string
): Promise<string> {
  ensureDir(outDir);
  const outFile = path.join(outDir, `${sfxType}-${id}.wav`);

  const dur = SFX_DURATIONS[sfxType];
  const freq = 200 + Math.round(intensity * 800);

  let filter: string;

  switch (sfxType) {
    case 'whoosh':
      filter = `anoisesrc=d=${dur}:f=white:c=pink,volume=${intensity}`;
      break;
    case 'swoosh':
      filter = `anoisesrc=d=${dur}:f=white:c=pink,volume=${intensity},afade=t=out:st=${dur - 0.3}:d=0.3`;
      break;
    case 'pop':
      filter = `sine=frequency=${freq * 2}:duration=0.05,volume=${intensity}`;
      break;
    case 'click':
      filter = `anoisesrc=d=0.05:f=white:synth=triangle,volume=${intensity}`;
      break;
    case 'hum':
      filter = `sine=frequency=${freq}:duration=${dur},volume=${intensity * 0.5},afade=t=in:st=0:d=0.2,afade=t=out:st=${dur - 0.2}:d=0.2`;
      break;
    case 'tone':
      filter = `sine=frequency=${freq}:duration=${dur},volume=${intensity}`;
      break;
    case 'impact':
      filter = `anoisesrc=d=0.1:f=white:synth=triangle,volume=${intensity}`;
      break;
    default:
      filter = `sine=frequency=440:duration=${dur},volume=${intensity}`;
  }

  await run('ffmpeg', [
    '-hide_banner', '-y',
    '-f', 'lavfi',
    '-i', filter,
    '-ar', '48000',
    '-ac', '1',
    outFile,
  ]);

  return outFile;
}

export async function applySoundEffects(
  decision: EditDecision,
  motionCues: MotionCue[],
  clipId: string,
  ctx: SfxContext,
  onProgress: (frac: number, msg: string) => void = () => undefined
): Promise<SfxResult> {
  const effects: SoundEffect[] = [];
  const audioFiles: string[] = [];
  const notes: string[] = [];
  const cacheDir = ensureDir(path.join(SFX_DIR, clipId));

  onProgress(0.2, 'Planning sound effects');

  let placedCount = 0;

  for (const cue of motionCues) {
    const intensity = Math.max(0.1, Math.min(1, (cue.intensity || 0.5) * 2));

    const sfxType: SfxType = cue.kind === 'transition'
      ? 'whoosh'
      : cue.intensity && cue.intensity > 0.7 ? 'impact'
      : cue.intensity && cue.intensity < 0.3 ? 'hum'
      : 'click';

    const id = randomUUID();
    const dur = SFX_DURATIONS[sfxType];
    const start = cue.t;

    if (start > ctx.clipDuration) continue;

    const sfx: SoundEffect = { id, type: sfxType, start, duration: dur };
    effects.push(sfx);

    try {
      const audioFile = await generateSfxFile(sfxType, intensity, cacheDir, id);
      audioFiles.push(audioFile);
      notes.push(`Placed ${sfxType} at ${start.toFixed(2)}s`);
      placedCount++;
    } catch (e) {
      notes.push(`Failed to generate ${sfxType}: ${(e as Error).message}`);
    }
  }

  if (effects.length === 0 && motionCues.length > 0) {
    const id = randomUUID();
    const sfxType: SfxType = 'whoosh';
    const sfx: SoundEffect = { id, type: sfxType, start: 0, duration: SFX_DURATIONS[sfxType] };
    effects.push(sfx);
    try {
      const audioFile = await generateSfxFile(sfxType, 0.5, cacheDir, id);
      audioFiles.push(audioFile);
      placedCount++;
    } catch (e) {
      notes.push(`Default SFX failed: ${(e as Error).message}`);
    }
  }

  onProgress(1, `Generated ${placedCount} sound effects`);

  return { effects, audioFiles, notes };
}

export function buildSfxMixFilters(effects: SoundEffect[], audioFiles: string[], hasAudio: boolean): {
  filters: string[];
  inputs: string[];
} {
  const inputs: string[] = [];
  const delays: string[] = [];

  effects.forEach((eff, i) => {
    const file = audioFiles[i];
    if (!file || !fs.existsSync(file)) return;

    inputs.push(file);
    const delayMs = Math.round(eff.start * 1000);
    delays.push(`[i${i}]adelay=${delayMs}|${delayMs}[d${i}]`);
  });

  const filters = [...delays];
  if (delays.length > 0) {
    const mixingInputs = delays.map((_, i) => `[d${i}]`).join('');
    filters.push(`${mixingInputs}amix=inputs=${delays.length}:normalize=0:dropout_transition=2`);
  }

  return { filters, inputs };
}
