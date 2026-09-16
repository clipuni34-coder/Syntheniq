import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiRouter } from '../ai/router.js';
import { loadAiConfig } from '../config.js';
import type { Analysis, ClipState, JobState, Plan, Transcript } from './types.js';
import type { CompSpec } from './prep.js';
import { generateComposition } from './compose.js';
import { renderComposition } from './render.js';
import { ffprobe, makeThumbnail } from './media.js';
import { pickFont } from './package.js';

/**
 * Render an on-demand hook variant of an already-prepped clip.
 * Reuses the pre-cut segments + mixed audio; only the composition (hook text)
 * changes, so a variant render is fast.
 */
export async function renderVariant(
  projectDir: string,
  clipId: string,
  hookText: string,
  job: JobState,
): Promise<void> {
  const log = (m: string) => {
    job.logs.push({ t: new Date().toISOString(), level: 'info', msg: m });
    job.logs = job.logs.slice(-400);
  };

  const mediaClipDir = path.join(projectDir, 'media', clipId);
  const spec: CompSpec = JSON.parse(await fs.readFile(path.join(mediaClipDir, 'spec.json'), 'utf8'));
  const plan: Plan = JSON.parse(await fs.readFile(path.join(projectDir, 'plan.json'), 'utf8'));
  const analysis: Analysis = JSON.parse(await fs.readFile(path.join(projectDir, 'analysis.json'), 'utf8'));
  const transcript: Transcript = JSON.parse(await fs.readFile(path.join(projectDir, 'transcript.json'), 'utf8'));
  const clip = plan.clips.find((c) => c.id === clipId);
  if (!clip) throw new Error(`clip ${clipId} not in plan`);

  const compDir = path.join(projectDir, 'comp', `${clipId}-var1`);
  await generateComposition(spec, mediaClipDir, compDir, transcript, analysis.keyphrases, plan.clips.findIndex((c) => c.id === clipId), {
    variant: { hookText },
  });

  const filesDir = path.join(projectDir, 'files');
  const outMp4 = path.join(filesDir, `${clipId}_var1.mp4`);
  log(`[variant] ${clipId}: rendering hook variant "${hookText}"`);
  await renderComposition(compDir, outMp4, spec.fps, log);

  // variant thumbnail = same hero frame, variant hook text
  try {
    const media = await ffprobe(await findSource(projectDir));
    const t = Math.max(0.1, Math.min(clip.thumbnail.sourceTime, media.duration - 0.2));
    await makeThumbnail(media.path, t, hookText.slice(0, 32), path.join(filesDir, `${clipId}_var1_thumb.jpg`), media, await pickFont());
  } catch {
    /* thumb optional */
  }

  const clipState: ClipState | undefined = job.clips.find((c) => c.id === clipId);
  if (clipState) {
    clipState.variant = {
      hookText,
      title: clip.title,
      status: 'done',
      mp4: `${clipId}_var1.mp4`,
      thumb: `${clipId}_var1_thumb.jpg`,
    };
  }
  log(`[variant] ${clipId}: done`);
}

async function findSource(projectDir: string): Promise<string> {
  const entries = await fs.readdir(projectDir);
  const src = entries.find((e) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(e));
  if (!src) throw new Error('source not found');
  return path.join(projectDir, src);
}

export { loadAiConfig };
