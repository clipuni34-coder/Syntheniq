import path from 'node:path';
import fs from 'node:fs';
import { run } from '../../lib/ffmpeg.js';
import type { EditDecision } from '../editorial/plan.js';
import type { MotionCue } from '../editorial/motion.js';
import { ensureDir } from '../../lib/paths.js';
import { randomUUID } from 'node:crypto';

export type SfxType = 'whoosh' | 'swoosh' | 'pop' | 'click' | 'hum' | 'tone' | 'impact' | 'footsteps' | 'cheer' | 'swish';

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
const SFX_ASSETS_DIR = path.resolve(import.meta.dirname, '../../assets/sfx');

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

/** Map SFX types to pre-made CC0 asset files.
 * Uses the downloaded pop.wav, whoosh.wav, bell.wav from remotion.media.
 */
const SFX_ASSET_FILES: Partial<Record<SfxType, string>> = {
  'whoosh': 'whoosh.wav',
  'pop': 'pop.wav',
  'click': 'pop.wav',
  'tone': 'bell.wav',
  'impact': 'pop.wav',
  'swish': 'whoosh.wav',
};

/** Try to use a pre-made CC0 SFX asset instead of generating one. */
async function useSfxAsset(
  sfxType: SfxType,
  intensity: number,
  cacheDir: string,
  id: string
): Promise<string | null> {
  const assetName = SFX_ASSET_FILES[sfxType];
  if (!assetName) return null;

  const assetPath = path.join(SFX_ASSETS_DIR, assetName);
  if (!fs.existsSync(assetPath)) return null;

  // Copy the asset to cache with intensity-based volume adjustment
  const outFile = path.join(cacheDir, `${sfxType}-${id}.wav`);
  const vol = Math.max(0.1, Math.min(1, intensity));
  
  try {
    await run('ffmpeg', [
      '-hide_banner', '-y',
      '-i', assetPath,
      '-af', `volume=${vol},loudnorm=I=-14:TP=-1:LRA=7`,
      '-ar', '48000',
      '-ac', '1',
      outFile,
    ]);
    return outFile;
  } catch {
    return null;
  }
}

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
      // Rich whoosh: noise sweep with frequency glissando, EQ shaping
      filter = `anoisesrc=d=${dur}:c=pink,` +
               `asetrate=48000*${0.7 + intensity * 0.6},` +
               `atempo=${0.8 + intensity * 0.4},` +
               `aeval='sin(3.14159*t/${dur}):x=0',` +
               `aloop=loop=-1:size=1600,asetnsamples=4096,` +
               `equalizer=f=150:w=200:g=${3 + intensity * 5},` +
               `equalizer=f=3000:w=800:g=${2 + intensity * 3},` +
               `loudnorm=I=-14:TP=-1:LRA=7,` +
               `volume=${0.7 + intensity * 0.3}`;
      break;
    case 'swoosh':
      // Quick swoosh with high-frequency emphasis and fade
      filter = `anoisesrc=d=${dur}:c=pink,` +
               `asetrate=48000*${0.9 + intensity * 0.4},` +
               `atempo=${1.0 + intensity * 0.5},` +
               `highpass=f=500,` +
               `equalizer=f=1200:w=300:g=${4 + intensity * 4},` +
               `equalizer=f=4000:w=1000:g=${2 + intensity * 2},` +
               `afade=t=out:st=${dur - 0.2}:d=0.2,` +
               `loudnorm=I=-14:TP=-1:LRA=7,` +
               `volume=${0.6 + intensity * 0.4}`;
      break;
    case 'pop':
      // Sharp click-pop: filtered noise burst with high-frequency emphasis
      filter = `anoisesrc=d=${dur}:c=white,` +
               `highpass=f=200,lowpass=f=8000,` +
               `asetrate=44100*${1.0 + intensity * 0.5},atempo=${0.8},` +
               `equalizer=f=${600 + intensity * 600}:w=150:g=10,` +
               `afade=t=out:st=0:d=${dur},` +
               `volume=${intensity * 0.8}`;
      break;
    case 'click':
      filter = `anoisesrc=d=0.03:c=white,` +
               `highpass=f=500,lowpass=f=12000,` +
               `equalizer=f=1500:w=300:g=6,` +
               `volume=${intensity * 0.7}`;
      break;
    case 'hum':
      filter = `sine=frequency=${freq}:duration=${dur},` +
               `equalizer=f=60:w=80:g=${-6 + intensity * 3},` +  // reduce low hum
               `equalizer=f=220:w=100:g=${3 + intensity * 2},` +  // boost fundamental
               `equalizer=f=880:w=200:g=${2 + intensity * 1},` +  // boost 4th harmonic
               `afade=t=in:st=0:d=0.3,afade=t=out:st=${dur - 0.3}:d=0.3,` +
               `volume=${intensity * 0.3}`;
      break;
    case 'tone':
      filter = `sine=frequency=${freq}:duration=${dur},` +
               `equalizer=f=${freq}:w=${freq * 0.3}:g=${5 + intensity * 3},` +
               `equalizer=f=${freq * 2}:w=${freq * 0.3}:g=3,` +
               `volume=${intensity * 0.5}`;
      break;
    case 'impact':
      // Punchy impact: filtered noise burst with low-end punch
      {
        const impactFreq = 80 + intensity * 150;
        filter = `anoisesrc=d=0.08:c=brown,` +
                 `lowpass=f=800,` +
                 `equalizer=f=60:w=60:g=${6 + intensity * 2},` +
                 `equalizer=f=150:w=100:g=${4 + intensity * 2},` +
                 `equalizer=f=300:w=200:g=${2 + intensity * 1},` +
                 `asetrate=44100*${0.95 + intensity * 0.1},` +
                 `loudnorm=I=-12:TP=-1,` +
                 `volume=${0.5 + intensity * 0.5}`;
      }
      break;
    case 'footsteps':
      filter = `anoisesrc=d=${dur}:c=brown,` +
               `asetrate=48000*1.2,atempo=0.8,` +
               `equalizer=f=60:w=60:g=6,` +
               `equalizer=f=120:w=80:g=4,` +
               `equalizer=f=250:w=100:g=2,` +
               `lowpass=f=200,` +
               `volume=${intensity * 0.4}`;
      break;
    case 'cheer':
      filter = `anoisesrc=d=${dur}:c=pink,` +
               `sine=frequency=440:duration=${dur}:volume=${intensity * 0.3},` +
               `sine=frequency=555:duration=${dur}:volume=${intensity * 0.2},` +
               `sine=frequency=660:duration=${dur}:volume=${intensity * 0.2},` +
               `asetrate=44100*${0.9 + intensity * 0.2},` +
               `equalizer=f=1000:w=400:g=3,` +
               `equalizer=f=3000:w=1000:g=2,` +
               `afade=t=in:st=0:d=0.3,afade=t=out:st=${dur - 0.3}:d=0.3,` +
               `vibrato=f=5:d=0.5,` +
               `volume=${intensity * 0.5}`;
      break;
    case 'swish':
      filter = `anoisesrc=d=${dur}:c=pink,` +
               `asetrate=48000*1.3,atempo=1.1,` +
               `highpass=f=300,` +
               `equalizer=f=800:w=200:g=${3 + intensity * 2},` +
               `equalizer=f=2000:w=500:g=${2 + intensity * 1},` +
               `afade=t=out:st=${dur - 0.15}:d=0.15,` +
               `volume=${intensity * 0.4}`;
      break;
    default:
      filter = `sine=frequency=${freq}:duration=${dur},equalizer=f=${freq}:w=${freq * 0.3}:g=5,volume=${intensity}`;
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

    const sfx: SoundEffect = { id, type: sfxType, start, duration: dur };
    effects.push(sfx);

    try {
      const audioFile = await useSfxAsset(sfxType, intensity, cacheDir, id) 
        ?? await generateSfxFile(sfxType, intensity, cacheDir, id);
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
      const audioFile = await useSfxAsset(sfxType, 0.5, cacheDir, id)
        ?? await generateSfxFile(sfxType, 0.5, cacheDir, id);
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
