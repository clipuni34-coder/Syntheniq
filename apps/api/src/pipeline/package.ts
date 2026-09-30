import fs from 'node:fs/promises';
import path from 'node:path';
import type { AiRouter } from '../ai/router.js';
import type { Analysis, ClipMeta, ClipPlan, MediaInfo, Transcript } from './types.js';
import { PACKAGE_SYSTEM } from './prompts.js';
import { makeThumbnail } from './media.js';

const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
  'C:\\Windows\\Fonts\\arialbd.ttf',
];

export async function pickFont(): Promise<string> {
  for (const f of FONT_CANDIDATES) {
    try {
      await fs.access(f);
      return f;
    } catch {
      /* next */
    }
  }
  return FONT_CANDIDATES[0];
}

/** Stage: per-clip publish metadata (LLM or heuristic fallback) + thumbnails. */
export async function packageClips(
  router: AiRouter,
  clips: ClipPlan[],
  media: MediaInfo,
  transcript: Transcript,
  analysis: Analysis,
  projectDir: string,
  planNotes?: string,
): Promise<{ metas: ClipMeta[]; packages: import('./types.js').ClipPackage[]; provider: string }> {
  const topicFor = (c: ClipPlan) => {
    const t = analysis.topics.find((t) => t.end > c.sourceStart && t.start < c.sourceEnd);
    return t ? `${t.title} — ${t.summary}` : '';
  };
  const wordsFor = (c: ClipPlan) =>
    transcript.segments
      .filter((s) => s.end > c.sourceStart && s.start < c.sourceEnd)
      .map((s) => s.text)
      .join(' ')
      .slice(0, 1200);

  const input = {
    clips: clips.map((c, i) => ({
      index: i,
      title: c.title,
      hookText: c.hookText,
      cta: c.cta.text,
      topic: topicFor(c),
      content: wordsFor(c),
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
      variants: c.variants,
    })),
  };

  const res = await router.call({
    task: 'package',
    system: PACKAGE_SYSTEM,
    input: JSON.stringify(input, null, 1),
    json: true,
    maxTokens: 8000,
    temperature: 0.4,
  });

  const raw = (res.json as any) || {};
  const rawClips = Array.isArray(raw.clips) ? raw.clips : [];
  const metas: ClipMeta[] = clips.map((c, i) => {
    const r = rawClips[i] ?? {};
    const hashtags = (Array.isArray(r.hashtags) ? r.hashtags : [])
      .map((h: string) => String(h).replace(/^#?/, '#'))
      .filter((h: string) => h.length > 1)
      .slice(0, 8);
    const fallbackTags = hashtags.length ? hashtags : analysis.keyphrases.slice(0, 5).map((k) => '#' + k.text.replace(/\s+/g, ''));
    const variants = (Array.isArray(r.variants) ? r.variants : [])
      .slice(0, 3)
      .map((v: any) => ({
        title: v.title ? String(v.title).slice(0, 120) : undefined,
        hookText: v.hookText ? String(v.hookText).slice(0, 80) : undefined,
        note: v.note ? String(v.note).slice(0, 160) : undefined,
      }))
      .filter((v: any) => v.title || v.hookText);
    const hook = c.hookText;
    return {
      title: String(r.title || c.title || hook).slice(0, 95),
      angle: String(r.angle || 'Direct value / tip').slice(0, 120),
      caption: String(r.caption || `${hook} ${fallbackTags.slice(0, 4).join(' ')}`.trim()).slice(0, 2200),
      tiktokCaption: String(r.tiktokCaption || `${hook} ${fallbackTags.slice(0, 4).join(' ')} #shorts`.trim()).slice(0, 2200),
      instagramCaption: String(r.instagramCaption || `${hook}\n\n${fallbackTags.slice(0, 5).join(' ')} #shorts`.trim()).slice(0, 2200),
      youtubeDescription: String(
        r.youtubeDescription || `${hook}. ${topicFor(c) || 'Watch the full moment from the original long-form video.'} ${fallbackTags.slice(0, 3).join(' ')}`.trim(),
      ).slice(0, 5000),
      description: String(r.description || topicFor(c) || hook).slice(0, 600),
      hashtags: fallbackTags,
      cta: String(r.cta || c.cta.text).slice(0, 80),
      variants: variants.length ? variants : c.variants,
    };
  });

  // thumbnails (FFmpeg drawtext on the AI-picked hero frame)
  const font = await pickFont();
  const outDir = path.join(projectDir, 'files');
  await fs.mkdir(outDir, { recursive: true });
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const thumbPath = path.join(outDir, `${c.id}_thumb.jpg`);
    try {
      const t = Math.max(0.1, Math.min(c.thumbnail.sourceTime, media.duration - 0.2));
      await makeThumbnail(media.path, t, c.thumbnail.text, thumbPath, media, font);
    } catch (e) {
      router.log?.(`[package] thumbnail failed for ${c.id}: ${(e as Error).message}`);
    }
  }

  // full publish package per clip (spec §13): + source timestamps + edit rationale
  const packages = clips.map((c, i) => {
    const moment = analysis.moments.find((m) => c.sourceStart >= m.start - 2 && c.sourceEnd <= m.end + 8)
      || analysis.moments.find((m) => Math.abs((m.start + m.end) / 2 - (c.sourceStart + c.sourceEnd) / 2) < 20);
    const keptSecs = c.segments.reduce((a, s) => a + (s.end - s.start), 0).toFixed(1);
    const rationale =
      `${moment?.reason || 'Strong standalone moment per story analysis.'} ` +
      `Source ${fmt(c.sourceStart)}–${fmt(c.sourceEnd)}; kept ${keptSecs}s of dialogue ` +
      `(${c.punchIns.length} punch-in${c.punchIns.length === 1 ? '' : 's'}, ${c.cutaways.length} B-roll cutaway${c.cutaways.length === 1 ? '' : 's'}, ` +
      `${c.callouts.length} text callout${c.callouts.length === 1 ? '' : 's'}), dead air removed, music: ${c.music}. ` +
      (planNotes || '');
    return {
      title: metas[i].title,
      angle: metas[i].angle,
      captions: {
        tiktok: metas[i].tiktokCaption,
        instagram: metas[i].instagramCaption,
        youtube: metas[i].youtubeDescription,
      },
      description: metas[i].description,
      hashtags: metas[i].hashtags,
      cta: metas[i].cta,
      source: { start: c.sourceStart, end: c.sourceEnd },
      rationale: rationale.slice(0, 1200),
      variants: metas[i].variants,
      generatedBy: `${res.provider}/${res.model}`,
    };
  });

  return { metas, packages, provider: `${res.provider}/${res.model}` };
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(1).padStart(4, '0');
  return m > 0 ? `${m}:${s}` : `${s}s`;
}
