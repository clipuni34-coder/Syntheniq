import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadAiConfig } from '../config.js';
import { AiRouter } from '../ai/router.js';
import type { Analysis, ClipState, JobState, MediaInfo, Plan, Transcript } from './types.js';
import { energyBuckets, extractAudioWav16k, ffprobe, framePng, makeThumbnail, mediaSignals } from './media.js';
import { transcribeAuto } from './transcribe.js';
import { runAnalyze } from './analyze.js';
import { runPlan } from './plan.js';
import { prepClipMedia, type CompSpec } from './prep.js';
import { generateComposition } from './compose.js';
import { lintComposition, qcClip, renderComposition } from './render.js';
import { editorialQc, trimOverload } from './qc-editorial.js';
import { packageClips, pickFont } from './package.js';
import type { Job } from '../jobs.js';

/**
 * The full pipeline:
 * media-check → audio → transcribe → (video-understand + analyze) → plan(+review)
 * → prep-media → render (HyperFrames) → package → qc → complete
 */
export async function runPipeline(job: Job, projectDir: string): Promise<void> {
  const log = (level: 'info' | 'warn' | 'error', msg: string) => job.log(level, msg);
  const cfg = loadAiConfig();
  const router = new AiRouter(cfg, (m) => log('info', m), null);
  const t0 = Date.now();
  job.log('info', 'pipeline start');

  // ── 1. media-check ───────────────────────────────────────────────────
  job.setStage('media-check');
  const sourceFile = await findSource(projectDir);
  if (!sourceFile) throw new Error('no source video found in project directory');
  const media = await ffprobe(sourceFile);
  job.setMedia(media);
  log('info', `media: ${media.duration.toFixed(1)}s @ ${media.fps}fps, ${media.width}x${media.height}, audio=${media.hasAudio}`);
  if (!media.hasAudio) throw new Error('source video has no audio track — transcription-based editing is impossible');
  if (media.duration < 30) log('warn', 'source is under 30s — few or no clips may be usable');
  await checkCancelled(job);

  const has = async (p: string) => fs.access(p).then(() => true, () => false);

  // ── 2. audio ─────────────────────────────────────────────────────────
  job.setStage('audio');
  const wav = path.join(projectDir, 'audio.wav');
  if (await has(wav)) {
    log('info', 'audio: reusing persisted audio.wav (resume)');
  } else {
    await extractAudioWav16k(sourceFile, wav);
    log('info', 'audio extracted (16kHz mono)');
  }
  await checkCancelled(job);

  // ── 3. transcribe ────────────────────────────────────────────────────
  job.setStage('transcribe');
  const transcriptPath = path.join(projectDir, 'transcript.json');
  let transcript: Transcript;
  let transcriptProvider: string | undefined;
  if (await has(transcriptPath)) {
    transcript = JSON.parse(await fs.readFile(transcriptPath, 'utf8'));
    transcriptProvider = job.state.transcript?.model;
    log('info', `transcribe: reusing persisted transcript (${transcript.segments.length} segments) (resume)`);
  } else {
    const t = await transcribeAuto(wav, media.duration, (m) => log('info', m));
    transcript = t.transcript;
    transcriptProvider = t.provider;
    await fs.writeFile(transcriptPath, JSON.stringify(transcript, null, 1));
  }
  job.setTranscript({
    words: transcript.segments.reduce((a, s) => a + s.words.length, 0),
    segments: transcript.segments.length,
    coverage: transcript.segments.length ? Math.min(1, Math.max(...transcript.segments.map((s) => s.end)) / media.duration) : 0,
    model: transcriptProvider || `faster-whisper ${process.env.SYNTHENIQ_WHISPER_MODEL || 'small'}`,
  });
  const signals = await mediaSignals(wav, media.duration);
  router.signals = { transcript, media, silences: signals.silences, energy: signals.energy };
  log('info', `signals: ${signals.silences.length} silences, ${signals.energy.length} energy buckets`);
  await checkCancelled(job);

  // ── 4. analyze (optional multimodal frame pass + story analysis) ─────
  job.setStage('analyze');
  const analysisPath = path.join(projectDir, 'analysis.json');
  let analysis: Analysis;
  let analyzeProviders: { video?: string; analyze: string };
  if (await has(analysisPath)) {
    analysis = JSON.parse(await fs.readFile(analysisPath, 'utf8'));
    analyzeProviders = { analyze: job.state.providers.analyze || 'persisted' };
    log('info', `analyze: reusing persisted analysis (${analysis.moments.length} moments) (resume)`);
  } else {
    const aiChainHasProvider = router.chainFor('video').some((p) => p !== 'heuristic');
    let frames;
    if (aiChainHasProvider) {
      log('info', 'video-understand: sampling 16 frames for multimodal analysis');
      frames = await sampleFrames(sourceFile, media.duration);
    }
    const out = await runAnalyze(router, { media, transcript, signals, frames });
    analysis = out.analysis;
    analyzeProviders = out.providers;
    await fs.writeFile(analysisPath, JSON.stringify(analysis, null, 1));
  }
  job.setAnalysis(analysis);
  router.signals.analysis = analysis;
  log(
    'info',
    `analysis: ${analysis.topics.length} topics, ${analysis.moments.length} candidate moments, ${analysis.deadAir.length} dead-air spans (via ${analyzeProviders.analyze}${analyzeProviders.video ? `, frames via ${analyzeProviders.video}` : ''})`,
  );
  await checkCancelled(job);

  // ── 5. plan (+ independent second-pass review) ───────────────────────
  job.setStage('plan');
  const planPath = path.join(projectDir, 'plan.json');
  let plan: Plan;
  let planProviders: { plan: string; review?: string };
  if (await has(planPath)) {
    plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    planProviders = { plan: job.state.providers.plan || 'persisted' };
    log('info', `plan: reusing persisted plan (${plan.clips.length} clips) (resume)`);
  } else {
    const out = await runPlan(router, media, transcript, analysis, signals.energy);
    plan = out.plan;
    planProviders = out.providers;
    await fs.writeFile(planPath, JSON.stringify(plan, null, 1));
  }
  job.setPlan(plan);
  log(
    'info',
    `plan: ${plan.clips.length} clips via ${planProviders.plan}${planProviders.review ? ` (review: ${planProviders.review})` : ''} — ${plan.clips
      .map((c) => `${c.id}[${c.sourceStart.toFixed(0)}-${c.sourceEnd.toFixed(0)}s]`)
      .join(' ')}`,
  );

  // ── editorial QC: pacing, hook strength, effect budget, payoff (spec §19) ─
  const edq = editorialQc(plan);
  for (const w of edq.warnings) log('warn', `editorial: ${w}`);
  for (const iss of edq.issues) log('warn', `editorial: ${iss}`);
  if (edq.issues.length) {
    // revise the plan and continue — a weak plan is repaired, never just reported
    const trimmed = trimOverload(plan);
    if (trimmed) {
      await fs.writeFile(planPath, JSON.stringify(plan, null, 1));
      job.setPlan(plan);
      log('info', 'editorial: plan revised (overloaded cues trimmed) — continuing');
    }
  } else if (!edq.warnings.length) {
    log('info', 'editorial: plan clean (hook, pacing, visual budget, payoff placement)');
  }
  await checkCancelled(job);

  // ── clip state ───────────────────────────────────────────────────────
  const clips: ClipState[] = plan.clips.map((c) => ({ id: c.id, title: c.title, status: 'pending', files: {} }));
  job.setClips(clips);

  // ── 6-8. prep + render per clip ──────────────────────────────────────
  job.setStage('prep-media');
  const specs: CompSpec[] = [];
  for (let i = 0; i < plan.clips.length; i++) {
    await checkCancelled(job);
    const c = plan.clips[i];
    job.stageProgress(0.3 + (0.3 * (i + 0.5)) / plan.clips.length);
    const specPath = path.join(projectDir, 'media', c.id, 'spec.json');
    if (await has(specPath)) {
      const spec = JSON.parse(await fs.readFile(specPath, 'utf8')) as CompSpec;
      specs.push(spec);
      log('info', `prep: ${c.id} reusing persisted media (resume)`);
    } else {
      const spec = await prepClipMedia(c, i, media, projectDir, (m) => log('info', m));
      specs.push(spec);
    }
  }

  job.setStage('render');
  const filesDir = path.join(projectDir, 'files');
  await fs.mkdir(filesDir, { recursive: true });
  const keyphrases = analysis.keyphrases;
  for (let i = 0; i < plan.clips.length; i++) {
    await checkCancelled(job);
    const c = plan.clips[i];
    const spec = specs[i];
    clips[i].status = 'rendering';
    job.setClips(clips);
    job.stageProgress(0.55 + (0.45 * i) / plan.clips.length);
    const compDir = path.join(projectDir, 'comp', c.id);
    const mediaClipDir = path.join(projectDir, 'media', c.id);
    await fs.writeFile(path.join(mediaClipDir, 'spec.json'), JSON.stringify(spec, null, 1));
    const outMp4 = path.join(filesDir, `${c.id}.mp4`);
    try {
      if (await has(outMp4) && job.state.clips.find((x) => x.id === c.id)?.status === 'done') {
        log('info', `render: ${c.id} already rendered (resume)`);
      } else {
        log('info', `render: ${c.id} starting (${spec.totalDur.toFixed(1)}s @ ${spec.fps}fps)`);
        await generateComposition(spec, mediaClipDir, compDir, transcript, keyphrases, i);
        // pre-render checks: captions present + official composition linter
        // (caption markup may live in a sub-composition file, e.g. compositions/fx.html)
        const compFiles = await fs.readdir(path.join(compDir, 'compositions')).catch(() => [] as string[]);
        let capHtml = await fs.readFile(path.join(compDir, 'index.html'), 'utf8');
        for (const f of compFiles) {
          if (f.endsWith('.html')) capHtml += await fs.readFile(path.join(compDir, 'compositions', f), 'utf8');
        }
        const capLines = (capHtml.match(/class="cap-line"/g) || []).length;
        if (capLines === 0) log('warn', `qc-pre: ${c.id}: composition has NO caption lines — captions will be empty`);
        else log('info', `qc-pre: ${c.id}: ${capLines} caption lines in composition`);
        await lintComposition(compDir, (m) => log('info', m));
        // one automatic retry on render failure (transient browser/encode errors)
        try {
          await renderComposition(compDir, outMp4, spec.fps, (m) => log('info', m));
        } catch (firstErr) {
          log('warn', `render: ${c.id} first attempt failed — auto-retrying: ${(firstErr as Error).message.slice(0, 200)}`);
          await new Promise((r) => setTimeout(r, 3000));
          await renderComposition(compDir, outMp4, spec.fps, (m) => log('info', m));
        }
        const qc = await qcClip(outMp4, spec.totalDur, spec.fps);
        if (!qc.ok) log('warn', `qc: ${c.id}: ${qc.issues.join('; ')}`);

        // ── variant render: a genuinely different hook on the SAME edit ──
        const v = c.variants?.[0];
        if (v && v.hookText && v.hookText !== c.hookText) {
          const vFile = `${c.id}_v1.mp4`;
          const vOut = path.join(filesDir, vFile);
          try {
            if (clips[i].variant?.status === 'done' && (await has(vOut))) {
              log('info', `render: ${c.id} variant already rendered (resume)`);
            } else {
              log('info', `render: ${c.id} variant starting — hook: ${String(v.hookText).slice(0, 60)}`);
              const vCompDir = path.join(projectDir, 'comp', `${c.id}_v1`);
              await generateComposition(spec, mediaClipDir, vCompDir, transcript, keyphrases, i, {
                variant: { hookText: v.hookText, title: v.title },
              });
              await lintComposition(vCompDir, (m) => log('info', m));
              try {
                await renderComposition(vCompDir, vOut, spec.fps, (m) => log('info', m));
              } catch {
                log('warn', `render: ${c.id} variant first attempt failed — auto-retrying`);
                await new Promise((r) => setTimeout(r, 3000));
                await renderComposition(vCompDir, vOut, spec.fps, (m) => log('info', m));
              }
              const vQc = await qcClip(vOut, spec.totalDur, spec.fps);
              if (!vQc.ok) log('warn', `qc: ${c.id} variant: ${vQc.issues.join('; ')}`);
              const vState = { hookText: v.hookText, title: v.title ?? v.hookText, status: 'done' as const, mp4: vFile, thumb: undefined as string | undefined };
              clips[i].variant = vState;
              try {
                const vThumb = path.join(filesDir, `${c.id}_v1_thumb.jpg`);
                const vT = Math.max(0.1, Math.min(c.thumbnail.sourceTime, media.duration - 0.2));
                await makeThumbnail(sourceFile, vT, String(v.hookText).slice(0, 32), vThumb, media, await pickFont());
                vState.thumb = `${c.id}_v1_thumb.jpg`;
              } catch (e) {
                log('warn', `render: ${c.id} variant thumbnail failed: ${(e as Error).message}`);
              }
              log('info', `render: ${c.id} variant done → ${vFile}`);
            }
          } catch (ve) {
            // a failed variant never sinks the main clip
            clips[i].variant = { hookText: v.hookText, title: v.title ?? v.hookText, status: 'error' };
            log('warn', `render: ${c.id} variant failed (main clip unaffected): ${(ve as Error).message.slice(0, 200)}`);
          }
        }
      }
      clips[i].status = 'done';
      clips[i].files.mp4 = `${c.id}.mp4`;
      clips[i].duration = spec.totalDur;
      clips[i].fps = spec.fps;
      job.setClips(clips);
      job.stageProgress(0.55 + (0.45 * (i + 1)) / plan.clips.length);
      log('info', `render: ${c.id} done → ${c.id}.mp4`);
    } catch (e) {
      clips[i].status = 'error';
      clips[i].error = (e as Error).message.slice(0, 500);
      job.setClips(clips);
      log('error', `render: ${c.id} failed: ${clips[i].error}`);
    }
  }
  const rendered = clips.filter((c) => c.status === 'done');
  if (!rendered.length) throw new Error('all clip renders failed — see logs');

  // ── 9. package (metadata + thumbnails) ───────────────────────────────
  job.setStage('package');
  router.signals.packageInput = {
    clips: plan.clips.map((c, i) => ({
      index: i,
      title: c.title,
      hookText: c.hookText,
      sourceStart: c.sourceStart,
      sourceEnd: c.sourceEnd,
      cta: c.cta.text,
      topic: analysis.topics.find((t) => t.end > c.sourceStart && t.start < c.sourceEnd)?.summary || '',
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
      variants: c.variants,
    })),
    keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
  };
  const allMetaPresent = await Promise.all(
    plan.clips.map((c) => has(path.join(filesDir, `${c.id}_meta.json`))),
  );
  let packages;
  let packageProvider: string;
  if (allMetaPresent.every(Boolean)) {
    packages = await Promise.all(
      plan.clips.map(async (c) => JSON.parse(await fs.readFile(path.join(filesDir, `${c.id}_meta.json`), 'utf8'))),
    );
    packageProvider = job.state.providers.package || 'persisted';
    log('info', 'package: reusing persisted metadata + thumbnails (resume)');
  } else {
    const out = await packageClips(router, plan.clips, media, transcript, analysis, projectDir, plan.notes);
    packages = out.packages;
    packageProvider = out.provider;
  }
  for (let i = 0; i < plan.clips.length; i++) {
    const c = plan.clips[i];
    await fs.writeFile(path.join(filesDir, `${c.id}_meta.json`), JSON.stringify(packages[i], null, 2));
    if (clips[i].status === 'done') {
      clips[i].files.meta = `${c.id}_meta.json`;
      const thumb = path.join(filesDir, `${c.id}_thumb.jpg`);
      try {
        await fs.access(thumb);
        clips[i].files.thumb = `${c.id}_thumb.jpg`;
      } catch {
        /* no thumb */
      }
    }
  }
  job.setClips(clips);
  log('info', `package: metadata written for ${plan.clips.length} clips (via ${packageProvider})`);

  // ── 10. qc (final) ───────────────────────────────────────────────────
  job.setStage('qc');
  const issues: string[] = [];
  for (const c of rendered) {
    const mp4 = path.join(filesDir, `${c.files.mp4}`);
    const spec = specs[plan.clips.findIndex((p) => p.id === c.id)];
    const qc = await qcClip(mp4, spec.totalDur, spec.fps);
    if (!qc.ok) issues.push(`${c.id}: ${qc.issues.join('; ')}`);
  }
  if (issues.length) log('warn', `qc issues: ${issues.join(' | ')}`);
  log('info', `qc: ${rendered.length}/${plan.clips.length} clips passed`);

  job.setStage('complete');
  job.setProviders({
    transcribe: `faster-whisper ${process.env.SYNTHENIQ_WHISPER_MODEL || 'small'}`,
    analyze: analyzeProviders.analyze,
    plan: planProviders.plan,
    package: packageProvider,
    video: analyzeProviders.video,
    review: planProviders.review,
  });
  job.done(`complete in ${((Date.now() - t0) / 1000).toFixed(0)}s — ${rendered.length} clips`);
}

async function findSource(projectDir: string): Promise<string | null> {
  const entries = await fs.readdir(projectDir);
  const src = entries.find((e) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(e));
  return src ? path.join(projectDir, src) : null;
}

async function sampleFrames(src: string, duration: number) {
  const n = 16;
  const frames: { t: number; dataUrl: string; b64: string; mimeType: string }[] = [];
  for (let i = 0; i < n; i++) {
    const t = Math.min(duration - 0.5, ((i + 0.5) / n) * duration);
    const tmp = path.join('/tmp', `hf-frame-${randomUUID()}.png`);
    try {
      await framePng(src, t, tmp, 480);
      const b64 = (await fs.readFile(tmp)).toString('base64');
      frames.push({ t: Math.round(t * 10) / 10, dataUrl: `data:image/png;base64,${b64}`, b64, mimeType: 'image/png' });
    } catch {
      /* skip frame */
    } finally {
      await fs.unlink(tmp).catch(() => {});
    }
  }
  return frames.length ? frames : undefined;
}

export async function checkCancelled(job: Job): Promise<void> {
  if (job.cancelRequested) {
    job.cancelled('cancelled by user');
    throw new Error('cancelled');
  }
}

// re-export for typing convenience
export type { MediaInfo, Plan, Transcript, JobState };
export { energyBuckets };
