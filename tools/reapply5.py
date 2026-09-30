#!/usr/bin/env python3
"""Re-apply session feature: variant rendering chain + audio-silence QC.
Variant = a genuinely different angle (payoff-led hook) on the same edit,
rendered as a separate MP4 (spec: variants 0-2, only when a genuinely
different angle exists). Idempotent."""
import os, sys

ROOT = '/home/user/Syntheniq'

def patch(path, old, new, tag):
    p = os.path.join(ROOT, path)
    s = open(p).read()
    if new in s:
        print(f'  = {tag} (already applied)')
        return
    if old not in s:
        print(f'  ! {tag} ANCHOR MISSING — inspect {path}')
        sys.exit(1)
    s = s.replace(old, new, 1)
    open(p, 'w').write(s)
    print(f'  + {tag}')

print('variant chain + audio QC...')

# ── 1. heuristic buildClip: propose a payoff-led variant ────────────────
patch('apps/api/src/ai/heuristic.ts',
"""  // Retention architecture — continuous reasons to keep watching (see RETENTION PRINCIPLE).
  const retention = deriveRetention(start, end, kept, s, analysis);

  return {""",
"""  // Retention architecture — continuous reasons to keep watching (see RETENTION PRINCIPLE).
  const retention = deriveRetention(start, end, kept, s, analysis);

  // Variant: a genuinely different angle (payoff-led) from a later moment —
  // only when the clip holds a second strong sentence distinct from the hook.
  let variants: { hookText?: string; title?: string; note?: string }[] = [];
  {
    const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const hookNorm = norm(hookText).split(' ').slice(0, 5).join(' ');
    if (hookNorm.length > 8) {
      const sentences: string[] = [];
      for (const seg of s.transcript.segments) {
        if (seg.end <= start + 0.5 || seg.start >= end - 0.5) continue;
        for (const part of seg.text.split(/(?<=[.!?])\\s+/)) {
          const t = part.trim();
          if (t.length >= 15 && t.length <= 95) sentences.push(t);
        }
      }
      const payoff = sentences.reverse().find(
        (t) =>
          /\\b(doubled|tripled|views|watch time|retention|will change|changed|completely|from zero|\\d+)\\b/i.test(t) &&
          !norm(t).includes(hookNorm),
      );
      if (payoff) {
        const clean = payoff.replace(/\\s+/g, ' ').trim();
        variants = [{ hookText: clean.slice(0, 80), title: clean.slice(0, 120), note: 'payoff-led variant' }];
      }
    }
  }

  return {""",
'heuristic: variant proposal')

patch('apps/api/src/ai/heuristic.ts',
"""    title: hookText,
    variants: [],
    motion,""",
"""    title: hookText,
    variants,
    motion,""",
'heuristic: return variants')

# ── 2. heuristic package: real variants, not placeholders ───────────────
patch('apps/api/src/ai/heuristic.ts',
"""      variants: [
        { title: `${title} — take 2`.slice(0, 95), hookText: c.hookText },
      ],""",
"""      variants: (Array.isArray(c.variants) ? c.variants : [])
        .slice(0, 3)
        .map((v: any) => ({
          hookText: v.hookText ? String(v.hookText).slice(0, 80) : undefined,
          title: v.title ? String(v.title).slice(0, 120) : undefined,
          note: v.note ? String(v.note).slice(0, 160) : undefined,
        }))
        .filter((v: any) => v.hookText || v.title),""",
'heuristic: package real variants')

# ── 3. package.ts: AI sees the plan's variants ──────────────────────────
patch('apps/api/src/pipeline/package.ts',
"""      topic: topicFor(c),
      content: wordsFor(c),
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
    })),""",
"""      topic: topicFor(c),
      content: wordsFor(c),
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
      variants: c.variants,
    })),""",
'package: input includes plan variants')

# ── 4. index.ts: imports + packageInput + variant render ────────────────
patch('apps/api/src/pipeline/index.ts',
"""import { energyBuckets, extractAudioWav16k, ffprobe, framePng, mediaSignals } from './media.js';""",
"""import { energyBuckets, extractAudioWav16k, ffprobe, framePng, makeThumbnail, mediaSignals } from './media.js';""",
'index: import makeThumbnail')

patch('apps/api/src/pipeline/index.ts',
"""import { packageClips } from './package.js';""",
"""import { packageClips, pickFont } from './package.js';""",
'index: import pickFont')

patch('apps/api/src/pipeline/index.ts',
"""      topic: analysis.topics.find((t) => t.end > c.sourceStart && t.start < c.sourceEnd)?.summary || '',
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
    })),""",
"""      topic: analysis.topics.find((t) => t.end > c.sourceStart && t.start < c.sourceEnd)?.summary || '',
      keyphrases: analysis.keyphrases.slice(0, 8).map((k) => k.text),
      variants: c.variants,
    })),""",
'index: packageInput variants')

patch('apps/api/src/pipeline/index.ts',
"""        const qc = await qcClip(outMp4, spec.totalDur, spec.fps);
        if (!qc.ok) log('warn', `qc: ${c.id}: ${qc.issues.join('; ')}`);
      }
      clips[i].status = 'done';""",
"""        const qc = await qcClip(outMp4, spec.totalDur, spec.fps);
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
      clips[i].status = 'done';""",
'index: variant render block')

# ── 5. render.ts: audio-silence check in qcClip ─────────────────────────
patch('apps/api/src/pipeline/render.ts',
"""  if (!info.hasAudio) issues.push('no audio stream');""",
"""  if (!info.hasAudio) issues.push('no audio stream');

  // audio must actually CONTAIN sound (a broken mix can still carry a stream)
  try {
    const { stderr } = await pexecFile(
      'ffmpeg',
      ['-hide_banner', '-i', outMp4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
      { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 },
    );
    const m = String(stderr).match(/max_volume:\\s*(-?[\\d.]+)\\s*dB/);
    if (m && parseFloat(m[1]) < -50) issues.push('audio is (near) silent');
  } catch {
    /* volumedetect unavailable — non-blocking */
  }""",
'render: audio-silence QC')

print('variant chain + audio QC done')
