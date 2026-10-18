import path from 'node:path';
import fs from 'node:fs';
import type { EditDecision } from '../editorial/plan.js';
import type { MotionCue } from '../editorial/motion.js';
import { ensureDir } from '../../lib/paths.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export type SfxType = 'whoosh' | 'swoosh' | 'pop' | 'click' | 'hum' | 'tone' | 'impact' | 'footsteps' | 'cheer' | 'swish';

export interface SoundEffect {
  id: string;
  type: SfxType;
  start: number;
  duration: number;
  intensity: number;
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SFX_DIR = path.resolve(__dirname, '../../../sfx_assets');

const SFX_DURATIONS: Record<SfxType, number> = {
  whoosh: 2.0,
  swoosh: 1.5,
  pop: 0.3,
  click: 0.1,
  hum: 3.0,
  tone: 1.0,
  impact: 0.5,
  footsteps: 1.0,
  cheer: 2.0,
  swish: 0.8,
};

const SFX_ASSETS: Record<SfxType, string[]> = {
  whoosh: ['whoosh_1.wav', 'whoosh_2.wav'],
  swoosh: ['swoosh.wav'],
  swish: ['swish.wav'],
  pop: ['pop.wav', 'pop_hard.wav'],
  click: ['click.wav'],
  hum: ['hum.wav'],
  tone: ['tone.wav'],
  impact: ['impact.wav', 'impact_soft.wav'],
  footsteps: ['footsteps.wav', 'footsteps_alt.wav'],
  cheer: ['cheer.wav', 'cheer_short.wav'],
};

function selectAsset(sfxType: SfxType, intensity: number): string {
  const assets = SFX_ASSETS[sfxType];
  if (!assets || assets.length === 0) {
    const fallback = SFX_ASSETS.click[0];
    return fallback;
  }
  if (assets.length === 1) return assets[0];
  const idx = Math.max(0, Math.min(assets.length - 1, Math.floor(intensity * assets.length)));
  return assets[idx];
}

export function resolveSfxAsset(sfxType: SfxType, intensity: number): string {
  return path.join(SFX_DIR, selectAsset(sfxType, intensity));
}

export function getAvailableSfx(): Record<SfxType, string[]> {
  const result: Record<SfxType, string[]> = {} as Record<SfxType, string[]>;
  for (const type of Object.keys(SFX_ASSETS) as SfxType[]) {
    result[type] = [];
    for (const asset of SFX_ASSETS[type]) {
      const fullPath = path.join(SFX_DIR, asset);
      if (fs.existsSync(fullPath)) {
        result[type].push(asset);
      }
    }
  }
  return result;
}

export async function loadSfxFile(
  sfxType: SfxType,
  intensity: number,
  outDir: string,
  id: string
): Promise<string> {
  ensureDir(outDir);
  const outFile = path.join(outDir, `${sfxType}-${id}.wav`);

  const assetFile = selectAsset(sfxType, intensity);
  const srcPath = path.join(SFX_DIR, assetFile);

  if (!fs.existsSync(srcPath)) {
    throw new Error(`SFX asset not found: ${srcPath}`);
  }

  fs.copyFileSync(srcPath, outFile);

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
  const cacheDir = ensureDir(path.join(ctx.clipDir, 'sfx'));

  onProgress(0.2, 'Planning sound effects');

  let placedCount = 0;

  for (const cue of motionCues) {
    const intensity = Math.max(0.1, Math.min(1, (cue.intensity || 0.5) * 2));

    const sfxType: SfxType = cue.kind === 'transition' || cue.kind === 'punch_in'
      ? 'whoosh'
      : cue.kind === 'impact'
      ? 'impact'
      : cue.intensity && cue.intensity > 0.8
      ? 'cheer'
      : cue.intensity && cue.intensity > 0.6
      ? 'swish'
      : cue.intensity && cue.intensity < 0.3
      ? 'hum'
      : 'click';

    const id = randomUUID();
    const dur = SFX_DURATIONS[sfxType];
    const start = cue.t;

    if (start > ctx.clipDuration) continue;

    const sfx: SoundEffect = { id, type: sfxType, start, duration: dur, intensity };
    effects.push(sfx);

    try {
      const audioFile = await loadSfxFile(sfxType, intensity, cacheDir, id);
      audioFiles.push(audioFile);
      notes.push(`Placed ${sfxType} at ${start.toFixed(2)}s (intensity ${intensity.toFixed(2)})`);
      placedCount++;
    } catch (e) {
      notes.push(`Failed to load ${sfxType}: ${(e as Error).message}`);
    }
  }

  if (effects.length === 0 && motionCues.length > 0) {
    const id = randomUUID();
    const sfxType: SfxType = 'whoosh';
    const sfx: SoundEffect = { id, type: sfxType, start: 0, duration: SFX_DURATIONS[sfxType], intensity: 0.5 };
    effects.push(sfx);
    try {
      const audioFile = await loadSfxFile(sfxType, 0.5, cacheDir, id);
      audioFiles.push(audioFile);
      placedCount++;
    } catch (e) {
      notes.push(`Default SFX failed: ${(e as Error).message}`);
    }
  }

  onProgress(1, `Loaded ${placedCount} sound effects`);

  return { effects, audioFiles, notes };
}

export function buildSfxMixFilters(effects: SoundEffect[], audioFiles: string[]): {
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
    const vol = clamp(eff.intensity || 0.7, 0.3, 1.2);
    delays.push(`[i${i}]adelay=${delayMs}|${delayMs},volume=${vol.toFixed(2)}[d${i}]`);
  });

  const filters = [...delays];
  if (delays.length > 0) {
    const mixingInputs = delays.map((_, i) => `[d${i}]`).join('');
    filters.push(`${mixingInputs}amix=inputs=${delays.length}:normalize=0:dropout_transition=2`);
  }

  return { filters, inputs };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
