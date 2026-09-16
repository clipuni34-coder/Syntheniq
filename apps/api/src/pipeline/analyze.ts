import type { AiRouter } from '../ai/router.js';
import type { Analysis, MediaInfo, MediaSignals, Transcript } from './types.js';
import { ANALYZE_SYSTEM, transcriptText } from './prompts.js';

export interface AnalyzeContext {
  media: MediaInfo;
  transcript: Transcript;
  signals: MediaSignals;
  frames?: { t: number; dataUrl: string; b64: string; mimeType: string }[];
}

/**
 * Stage: story analysis.
 * 1) Optional multimodal pass: sample frames → VIDEO_UNDERSTAND (video task).
 * 2) Main ANALYZE call (transcript + silence/energy + visual notes).
 */
export async function runAnalyze(router: AiRouter, ctx: AnalyzeContext): Promise<{ analysis: Analysis; providers: { video?: string; analyze: string } }> {
  let visualNotes = '';
  let videoProvider: string | undefined;
  const useFrames = Boolean(ctx.frames?.length);
  if (useFrames) {
    const { VIDEO_UNDERSTAND_SYSTEM } = await import('./prompts.js');
    const frameList = ctx.frames!
      .map((f, i) => `Frame ${i + 1} @ ${f.t.toFixed(1)}s`)
      .join(', ');
    try {
      const res = await router.call({
        task: 'video',
        system: VIDEO_UNDERSTAND_SYSTEM,
        input: `The video is ${ctx.media.duration.toFixed(0)}s long. Frames are sampled in time order: ${frameList}.\nDescribe each frame and give overall visual notes with approximate times.`,
        images: ctx.frames!.map((f) => ({ data: f.b64, mimeType: f.mimeType })),
        json: true,
        maxTokens: 4000,
        temperature: 0.2,
      });
      const j = res.json as any;
      if (j && Array.isArray(j.frames)) {
        visualNotes = JSON.stringify(j, null, 1);
        videoProvider = `${res.provider}/${res.model}`;
      }
    } catch (e) {
      // Visual pass is non-blocking; continue transcript-only.
      router.log?.(`video-understand failed, continuing transcript-only: ${(e as Error).message}`);
    }
  }

  const silenceList = ctx.signals.silences
    .filter((s) => s.end - s.start >= 0.35)
    .map((s) => `${s.start.toFixed(1)}-${s.end.toFixed(1)}s`)
    .join(', ');
  const energyPeaks = [...ctx.signals.energy]
    .sort((a, b) => b.rms - a.rms)
    .slice(0, 12)
    .map((e) => `${e.t}s(${e.rms.toFixed(2)})`)
    .join(', ');

  const input = [
    `Media: ${ctx.media.duration.toFixed(1)}s, ${ctx.media.fps}fps, ${ctx.media.width}x${ctx.media.height}.`,
    `Detected silence gaps (s): ${silenceList || 'none'}`,
    `Loudest 1s buckets (time(rms 0-1)): ${energyPeaks || 'n/a'}`,
    visualNotes ? `Visual analysis from sampled frames:\n${visualNotes}` : '',
    'Transcript:\n' + transcriptText(ctx.transcript),
  ]
    .filter(Boolean)
    .join('\n\n');

  const res = await router.call({
    task: 'analyze',
    system: ANALYZE_SYSTEM,
    input,
    json: true,
    maxTokens: 8000,
    temperature: 0.2,
  });
  const analysis = normalizeAnalysis(res.json, ctx.media.duration) as Analysis;
  if (visualNotes) analysis.visualNotes = visualNotes.slice(0, 4000);
  return { analysis, providers: { video: videoProvider, analyze: `${res.provider}/${res.model}` } };
}

function normalizeAnalysis(raw: unknown, duration: number): any {
  const a = (raw || {}) as any;
  const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
  return {
    language: typeof a.language === 'string' ? a.language : 'en',
    tone: typeof a.tone === 'string' ? a.tone : 'neutral',
    topics: (Array.isArray(a.topics) ? a.topics : [])
      .map((t: any) => ({
        start: num(t.start),
        end: num(t.end),
        title: String(t.title ?? '').slice(0, 80),
        summary: String(t.summary ?? '').slice(0, 300),
        energy: Math.min(1, Math.max(0, num(t.energy, 0.5))),
        emotion: String(t.emotion ?? 'neutral'),
        importance: Math.min(1, Math.max(0, num(t.importance, 0.5))),
      }))
      .filter((t: any) => t.end > t.start)
      .sort((x: any, y: any) => x.start - y.start),
    keyphrases: (Array.isArray(a.keyphrases) ? a.keyphrases : []).map((k: any) => ({
      text: String(k.text ?? '').slice(0, 40),
      times: (Array.isArray(k.times) ? k.times : []).map((t: any) => num(t)).filter((t: number) => t >= 0 && t <= duration),
    })),
    deadAir: (Array.isArray(a.deadAir) ? a.deadAir : [])
      .map((d: any) => ({ start: num(d.start), end: num(d.end), reason: String(d.reason ?? 'dead air') }))
      .filter((d: any) => d.end > d.start && d.end - d.start < 60),
    fillerNotes: String(a.fillerNotes ?? ''),
    moments: (Array.isArray(a.moments) ? a.moments : [])
      .map((m: any) => ({
        start: num(m.start),
        end: num(m.end),
        hook: clampScore(m.hook),
        curiosity: clampScore(m.curiosity),
        payoff: clampScore(m.payoff),
        standalone: clampScore(m.standalone),
        emotion: clampScore(m.emotion),
        visual: clampScore(m.visual),
        reason: String(m.reason ?? ''),
      }))
      .filter((m: any) => m.end > m.start + 3)
      .sort((x: any, y: any) => x.start - y.start),
  };
}

function clampScore(v: unknown): number {
  const n = typeof v === 'number' && isFinite(v) ? v : 5;
  return Math.min(10, Math.max(0, Math.round(n)));
}
