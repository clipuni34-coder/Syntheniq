import fs from 'node:fs/promises';
import path from 'node:path';
import { ASSETS_DIR } from '../config.js';
import type { CompSpec, CompSegment } from './prep.js';
import type { Graphic } from './graphics.js';
import type { Transcript } from './types.js';
import {
  emphasisCode,
  emphasisGlyph,
  entranceFor,
  fxMotionCode,
  fxMotionHtml,
  motionFxCss,
  rootMotionCode,
  structuralMotion,
} from './motion.js';

const ACCENTS = ['#9ee7ff', '#ffb35c', '#7dffa8', '#ff7ab8', '#c5a4ff', '#ffe066'];

interface CaptionWord {
  text: string;
  t: number; // comp time
  kp: boolean;
  punct?: boolean;
}
interface CaptionLine {
  id: string;
  start: number;
  end: number;
  words: CaptionWord[];
}

/**
 * Generate a HyperFrames composition (index.html) for one clip.
 * Contract (official HyperFrames docs, 2026-09):
 *  - root <div data-composition-id data-width=1080 data-height=1920>
 *  - primitive clips (video/audio) with data-start/data-duration/data-track-index, class="clip"
 *  - one paused GSAP timeline registered per composition on window.__timelines
 *  - framework owns media playback + clip lifecycle; scripts animate only
 */
export async function generateComposition(
  spec: CompSpec,
  mediaDir: string, // where prep wrote assets (media/<clip>/)
  outDir: string, // comp/<clip>/ — written project dir
  transcript: Transcript,
  keyphrases: { text: string; times: number[] }[],
  clipIndex: number,
  opts: { variant?: { hookText?: string; title?: string } } = {},
): Promise<void> {
  const accent = ACCENTS[clipIndex % ACCENTS.length];
  const hookText = opts.variant?.hookText || spec.hookText;
  const ctaText = opts.variant?.title ? spec.ctaText : spec.ctaText;
  // legacy persisted specs have no motion — keep camera movement via structural cues
  const motion = spec.motion ?? structuralMotion(spec.segments, spec.punchIns, spec.totalDur);

  // ── copy assets ──────────────────────────────────────────────────────
  const assetsOut = path.join(outDir, 'assets');
  await fs.mkdir(path.join(assetsOut, 'fonts'), { recursive: true });
  for (const seg of spec.segments) {
    await fs.copyFile(path.join(mediaDir, 'assets', seg.file), path.join(assetsOut, seg.file));
  }
  for (const c of spec.cutaways) {
    await fs.copyFile(path.join(mediaDir, 'assets', c.file), path.join(assetsOut, c.file));
  }
  await fs.copyFile(path.join(mediaDir, spec.audioFile), path.join(assetsOut, spec.audioFile));
  await fs.copyFile(path.join(ASSETS_DIR, 'vendor', 'gsap.min.js'), path.join(assetsOut, 'gsap.min.js'));
  await fs.copyFile(path.join(ASSETS_DIR, 'fonts', 'Inter-Bold.woff2'), path.join(assetsOut, 'fonts', 'Inter-Bold.woff2'));
  await fs.copyFile(path.join(ASSETS_DIR, 'fonts', 'Inter-ExtraBold.woff2'), path.join(assetsOut, 'fonts', 'Inter-ExtraBold.woff2'));

  // ── captions from transcript + segment map + keyphrases ──────────────
  const lines = buildCaptions(transcript, spec, keyphrases);

  // ── punch-in list (with collision guard) ─────────────────────────────
  const piList: { seg: number; t: number; z: number }[] = [];
  for (const p of spec.punchIns) {
    const idx = spec.segments.findIndex((s) => p.compTime >= s.compStart - 0.05 && p.compTime < s.compStart + s.compDur);
    if (idx < 0) continue;
    const same = piList.filter((x) => x.seg === idx);
    if (same.some((x) => Math.abs(x.t - p.compTime) < 1.6)) continue;
    piList.push({ seg: idx, t: Math.round(p.compTime * 1000) / 1000, z: p.zoom });
  }

  const data = {
    total: spec.totalDur,
    lines: lines.map((l) => ({
      id: l.id,
      start: r3(l.start),
      words: l.words.map((w) => ({ id: `${l.id}-w${l.words.indexOf(w)}`, t: r3(w.t), kp: w.kp, text: w.text })),
    })),
    cutaways: spec.cutaways.map((c) => ({
      start: r3(c.compStart),
      dur: r3(c.compDur),
      // Ken Burns precomputed here — the browser script must not call Node helpers
      kb: c.compDur > 1.2 ? { t: r3(c.compStart + 0.2), d: r3(c.compDur - 0.4) } : null,
    })),
    callouts: spec.callouts.map((c) => ({ t: r3(c.compTime), text: c.text })),
    graphics: (spec.graphics || []).map((g, i) => ({
      i,
      t: r3(g.compTime),
      type: g.type,
      value: g.value || '',
      from: g.from || '',
      to: g.to || '',
    })),
  };

  // ── match motion "emphasis" cues to caption words ─────────────────────
  const wordEmph = new Map<string, string>(); // word element id → variant
  const emphItems: { el: string; t: number; variant: string }[] = [];
  for (const cue of motion) {
    if (cue.kind !== 'emphasis') continue;
    const want = String(cue.text || '').toLowerCase().replace(/[^a-z0-9']/g, '');
    if (want.length < 2) continue;
    let best: { id: string; t: number; d: number } | null = null;
    for (const l of lines) {
      l.words.forEach((w, wi) => {
        const wt = w.text.toLowerCase().replace(/[^a-z0-9']/g, '');
        if (wt.length < 2) return;
        const match = wt === want || want.startsWith(wt) || wt.startsWith(want);
        if (!match) return;
        const d = Math.abs(w.t - cue.t);
        if (d > 0.6) return;
        if (!best || d < best.d) best = { id: `${l.id}-w${wi}`, t: w.t, d };
      });
    }
    const b = best as { id: string; t: number; d: number } | null;
    if (b && !wordEmph.has(b.id)) {
      wordEmph.set(b.id, cue.variant || 'underline');
      emphItems.push({ el: `#${b.id}`, t: b.t, variant: cue.variant || 'underline' });
    }
  }

  // ── fx-layer motion components (lower thirds, impacts, pulses, wipes) ─
  const mfx = fxMotionHtml(motion, accent);
  const tempo = spec.motionStyle?.tempo || 'steady';

  // fx overlay = its own composition file (official docs: sub-compositions are
  // <template> files loaded via data-composition-src; the framework fetches,
  // mounts, executes the script, and auto-nests its timeline). Inline nested
  // compositions are NOT reliable — their scripts/timelines time out.
  const fxHtml = `<!-- fx overlay composition: vignette, progress bar, hook, karaoke captions, callouts, CTA -->
<template id="fx-template">
  <div id="fx-comp" data-composition-id="fx" data-width="1080" data-height="1920" data-timeline-role="captions" data-caption-root="true">
    <div id="vignette"></div>
    <div id="progress"></div>
    <div id="hook-wrap"><div id="hookText">${esc(hookText)}</div><div id="hookBar"></div></div>
    <div id="captions-root">
${lines
    .map(
      (l) =>
        `      <div class="cap-line" id="${l.id}">${l.words
          .map((w, wi) => {
            const wid = `${l.id}-w${wi}`;
            const emph = wordEmph.get(wid);
            const arrowLeft = emph === 'arrow' && wi * 2 >= l.words.length;
            // tracking words render per-glyph spans so the spread can animate
            const isTrk = emph === 'tracking';
            const inner = isTrk
              ? Array.from(w.text).map((ch) => `<span class="mg-ch">${esc(ch)}</span>`).join('')
              : esc(w.text);
            return `<span class="word${w.kp ? ' kp' : ''}${emph ? ' mgw' : ''}${isTrk ? ' mgt' : ''}" id="${wid}">${inner}${emph && !isTrk ? emphasisGlyph(emph, accent, arrowLeft) : ''}</span>`;
          })
          .join('')}</div>`,
    )
    .join('\n')}
    </div>
    <div class="callout-wrap">
${spec.callouts.map((c, i) => `      <div class="callout" id="call${i}">${esc(c.text)}</div>`).join('\n')}
    </div>
    <div class="gfx-wrap">
${(spec.graphics || []).map((g, i) => graphicPanelHtml(g, i)).join('\n')}
    </div>
    <div class="cta-wrap"><div id="cta">${esc(ctaText)}</div></div>
${mfx.html}
    <style>
      [data-composition-id="fx"] { position:relative; width:1080px; height:1920px; overflow:hidden; pointer-events:none; }
      [data-composition-id="fx"] #vignette { position:absolute; inset:0; z-index:5;
        background:radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.38) 100%),
                   linear-gradient(180deg, rgba(0,0,0,.28) 0%, transparent 10%, transparent 76%, rgba(0,0,0,.5) 100%); }
      [data-composition-id="fx"] #progress { position:absolute; top:0; left:0; height:10px; width:0%; background:${accent}; z-index:60; }
      [data-composition-id="fx"] #hook-wrap { position:absolute; top:21%; left:0; right:0; text-align:center; z-index:40; padding:0 60px; }
      [data-composition-id="fx"] #hookText { display:inline-block; font-size:88px; font-weight:800; color:#fff; line-height:1.08;
        text-shadow:0 4px 26px rgba(0,0,0,.65); text-transform:uppercase; letter-spacing:-2px; }
      [data-composition-id="fx"] #hookBar { margin:20px auto 0; height:12px; width:0%; max-width:540px; background:${accent}; border-radius:6px; }
      [data-composition-id="fx"] #captions-root { position:absolute; left:5%; right:5%; bottom:23%; z-index:45; text-align:center; height:120px; }
      [data-composition-id="fx"] .cap-line { position:absolute; left:0; right:0; bottom:0; display:flex; flex-wrap:wrap; justify-content:center; gap:14px; }
      [data-composition-id="fx"] .cap-line .word { display:inline-block; font-size:62px; font-weight:800; color:#fff; line-height:1.12;
        background:rgba(0,0,0,.62); border-radius:18px; padding:8px 20px; text-shadow:0 2px 10px rgba(0,0,0,.8); }
      [data-composition-id="fx"] .cap-line .word.kp { color:${accent}; }
      [data-composition-id="fx"] .callout-wrap { position:absolute; top:55%; left:0; right:0; text-align:center; z-index:42; }
      [data-composition-id="fx"] .callout { display:inline-block; font-size:76px; font-weight:800; color:${accent};
        text-shadow:0 3px 0 rgba(0,0,0,.55), 0 6px 22px rgba(0,0,0,.7); }
      [data-composition-id="fx"] .gfx-wrap { position:absolute; top:34%; left:4%; right:4%; z-index:43; pointer-events:none; }
      [data-composition-id="fx"] .gfx { opacity:0; will-change:transform,opacity; }
      [data-composition-id="fx"] .gfx-stat, [data-composition-id="fx"] .gfx-progress { text-align:center; }
      [data-composition-id="fx"] .gfx-num { font-size:170px; font-weight:800; color:${accent}; line-height:1;
        letter-spacing:-4px; text-shadow:0 8px 34px rgba(0,0,0,.75); }
      [data-composition-id="fx"] .gfx-progress .gfx-num { font-size:112px; letter-spacing:-2px; }
      [data-composition-id="fx"] .gfx-arrow { font-size:92px; padding:0 8px; }
      [data-composition-id="fx"] .gfx-title { margin-top:20px; text-align:center; font-size:44px; font-weight:800;
        color:#fff; text-transform:uppercase; letter-spacing:3px; text-shadow:0 3px 16px rgba(0,0,0,.85); }
      [data-composition-id="fx"] .gfx-list, [data-composition-id="fx"] .gfx-timeline { display:flex; flex-direction:column;
        gap:24px; align-items:stretch; background:rgba(5,6,7,.85); border-left:12px solid ${accent};
        border-radius:28px; padding:40px 44px; box-shadow:0 18px 60px rgba(0,0,0,.55); }
      [data-composition-id="fx"] .gfx-item { display:flex; align-items:center; gap:24px; font-size:48px; font-weight:800; color:#fff; }
      [data-composition-id="fx"] .gfx-n { display:inline-flex; align-items:center; justify-content:center; min-width:68px;
        height:68px; padding:0 16px; border-radius:18px; background:${accent}; color:#050607; font-size:42px; font-weight:800; }
      [data-composition-id="fx"] .gfx-timeline .gfx-n { min-width:auto; background:transparent; color:${accent}; border:4px solid ${accent}; }
      [data-composition-id="fx"] .gfx-compare { display:flex; flex-direction:column; gap:18px; }
      [data-composition-id="fx"] .gfx-cmp { display:flex; align-items:center; justify-content:center; gap:26px; }
      [data-composition-id="fx"] .gfx-side { flex:1; text-align:center; font-size:50px; font-weight:800; color:#fff;
        background:rgba(5,6,7,.85); border-radius:26px; padding:30px 18px; min-height:120px;
        display:flex; align-items:center; justify-content:center; box-shadow:0 14px 44px rgba(0,0,0,.5); }
      [data-composition-id="fx"] .gfx-vs { font-size:46px; font-weight:800; color:${accent}; text-shadow:0 3px 14px rgba(0,0,0,.8); }
      [data-composition-id="fx"] .cta-wrap { position:absolute; bottom:6.5%; left:0; right:0; text-align:center; z-index:50; }
      [data-composition-id="fx"] #cta { display:inline-block; font-size:46px; font-weight:800; color:#050607; background:${accent};
        padding:20px 44px; border-radius:999px; }
${motionFxCss()}
    </style>
    <script>
      const DATA = ${JSON.stringify(data)};
      const tl = gsap.timeline({ paused: true });
      // hook (entrance matched to the clip's tempo + emotion)
      ${entranceFor(tempo, spec.motionStyle?.emotion).code('#hookText', 0.08)}
      tl.fromTo("#hookBar", { width: "0%" }, { width: "100%", duration: 0.4, ease: "power2.out" }, 0.32);
      tl.to("#hookText", { opacity: 0, y: -26, duration: 0.3, ease: "power1.in" }, 2.45);
      tl.to("#hookBar", { opacity: 0, duration: 0.3, ease: "power1.in" }, 2.45);
      // progress bar
      tl.to("#progress", { width: "100%", duration: DATA.total, ease: "none" }, 0);
      // captions (kinetic / karaoke)
      DATA.lines.forEach(function (line, i) {
        if (i > 0) tl.to("#" + DATA.lines[i - 1].id, { y: -16, opacity: 0, duration: 0.14, ease: "power1.in" }, line.start);
        tl.fromTo("#" + line.id, { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.15, ease: "power2.out" }, line.start + 0.02);
        line.words.forEach(function (w) {
          if (w.kp) {
            tl.fromTo("#" + w.id, { scale: 0.5, opacity: 0, y: 12 }, { scale: 1.16, opacity: 1, y: 0, duration: 0.13, ease: "power2.out" }, w.t);
            tl.to("#" + w.id, { scale: 1.0, duration: 0.22, ease: "power1.out" }, w.t + 0.16);
          } else {
            tl.fromTo("#" + w.id, { scale: 0.6, opacity: 0, y: 10 }, { scale: 1, opacity: 1, y: 0, duration: 0.13, ease: "power2.out" }, w.t);
          }
        });
      });
      // callouts (entrance matched to the callout style + clip tempo)
      ${spec.callouts
        .map((c, i) => `      ${entranceFor(tempo, c.style).code('#call' + i, r3(c.compTime))}
      tl.to("#call${i}", { opacity: 0, scale: 1.08, duration: 0.3, ease: "power1.out" }, ${r3(c.compTime + 1.5)});`)
        .join('\n')}
      // CTA
      ${entranceFor(tempo, spec.motionStyle?.emotion).code('#cta', r3(spec.totalDur - 2.4))}
      // visual-storytelling graphics (stat/progress/list/comparison/timeline)
      ${gfxCode()}
      // motion-graphics cues (lower thirds, impacts, pulses, transitions)
      ${fxMotionCode(motion, mfx.ids, spec.totalDur)}
      // caption-word emphasis glyphs
      ${emphasisCode(emphItems)}
      tl.set({}, {}, DATA.total);
      window.__timelines["fx"] = tl;
    </script>
  </div>
</template>
`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<script src="assets/gsap.min.js"></script>
<style>
@font-face { font-family:'Inter'; src:url('assets/fonts/Inter-Bold.woff2') format('woff2'); font-weight:700; font-style:normal; }
@font-face { font-family:'Inter'; src:url('assets/fonts/Inter-ExtraBold.woff2') format('woff2'); font-weight:800; font-style:normal; }
* { margin:0; padding:0; box-sizing:border-box; }
html, body { background:#000; }
#root { position:relative; width:1080px; height:1920px; overflow:hidden; background:#000; font-family:'Inter', system-ui, -apple-system, sans-serif; }
#root > video { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
#root > video.cut { object-fit:cover; }
</style>
</head>
<body>
<div id="root" data-composition-id="root" data-start="0" data-width="1080" data-height="1920">
${spec.segments
    .map((s, i) => {
      const startAttr = i === 0 ? '0' : `seg${i - 1}`;
      return `  <video id="seg${i}" class="clip" data-start="${startAttr}" data-duration="${r3(s.compDur)}" data-track-index="0" src="assets/${s.file}" muted playsinline preload="auto"></video>`;
    })
    .join('\n')}
${spec.cutaways
    .map((c, i) => `  <video id="cut${i}" class="clip cut" data-start="${r3(c.compStart)}" data-duration="${r3(c.compDur)}" data-track-index="1" src="assets/${c.file}" muted playsinline preload="auto"></video>`)
    .join('\n')}
  <audio id="bed" class="clip" data-start="0" data-duration="${r3(spec.totalDur)}" data-track-index="9" src="assets/${spec.audioFile}"></audio>

  <!-- fx overlay sub-composition (vignette, hook, captions, callouts, CTA) -->
  <div id="fx" data-composition-id="fx" data-composition-src="compositions/fx.html" data-start="0" data-track-index="5"></div>

  <script>
    const PI = ${JSON.stringify(piList)};
    const CUTS = ${JSON.stringify(data.cutaways)};
    const tl = gsap.timeline({ paused: true });
    // motion-graphics: camera drift, transition pulses, impact shake, settle
    ${rootMotionCode(motion, spec.segments)}
    // punch-ins
    PI.forEach(function (p) {
      tl.to("#seg" + p.seg, { scale: p.z, duration: 0.4, ease: "power2.in" }, p.t);
      tl.to("#seg" + p.seg, { scale: 1.0, duration: 0.6, ease: "power1.out" }, p.t + 1.1);
    });
    // cutaway B-roll entrances (zoom-in / slide-zoom / fade, staggered by index)
    CUTS.forEach(function (c, i) {
      var v = i % 3;
      if (v === 0) {
        tl.fromTo("#cut" + i, { scale: 1.14, opacity: 0 }, { scale: 1.02, opacity: 1, duration: 0.2, ease: "power2.out" }, c.start + 0.02);
      } else if (v === 1) {
        tl.fromTo("#cut" + i, { scale: 1.14, x: -46, opacity: 0 }, { scale: 1.02, x: 0, opacity: 1, duration: 0.22, ease: "power3.out" }, c.start + 0.02);
      } else {
        tl.fromTo("#cut" + i, { scale: 1.02, opacity: 0 }, { scale: 1.02, opacity: 1, duration: 0.18, ease: "power1.out" }, c.start + 0.02);
      }
      tl.to("#cut" + i, { opacity: 0, scale: 1.07, duration: 0.18, ease: "power1.in" }, c.start + c.dur - 0.2);
      // Ken Burns: slow zoom across the B-roll (width/height — never conflicts
      // with the scale-based entrance/exit; grow-only so edges stay covered)
      if (c.kb) tl.to("#cut" + i, { width: "106%", height: "106%", duration: c.kb.d, ease: "none" }, c.kb.t);
    });
    tl.set({}, {}, ${r3(spec.totalDur)});
    window.__timelines["root"] = tl;
  </script>
</div>
</body>
</html>
`;

  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(path.join(outDir, 'compositions'), { recursive: true });
  await fs.writeFile(path.join(outDir, 'index.html'), html);
  await fs.writeFile(path.join(outDir, 'compositions', 'fx.html'), fxHtml);
}

// ── caption builder ────────────────────────────────────────────────────

function buildCaptions(transcript: Transcript, spec: CompSpec, keyphrases: { text: string; times: number[] }[]): CaptionLine[] {
  const kpWordSet = new Set(keyphrases.map((k) => k.text.toLowerCase()));
  const kpSpans: { a: number; b: number }[] = [];
  for (const kp of keyphrases) {
    const phraseDur = Math.min(2.5, kp.text.length * 0.16 + 0.5);
    for (const t of kp.times) kpSpans.push({ a: t - 0.15, b: t + phraseDur });
  }

  interface W {
    text: string;
    t: number;
    end: number;
    kp: boolean;
    punct: boolean;
  }
  const words: W[] = [];
  for (const seg of spec.segments) {
    for (const tseg of transcript.segments) {
      if (tseg.end <= seg.srcStart || tseg.start >= seg.srcEnd) continue;
      for (const w of tseg.words) {
        if (w.start < seg.srcStart || w.end > seg.srcEnd + 0.05) continue;
        const t = seg.compStart + (w.start - seg.srcStart);
        const clean = w.word.replace(/[^A-Za-z0-9']/g, '').toLowerCase();
        const isKp = (clean.length > 2 && kpWordSet.has(clean)) || kpSpans.some((s) => w.start >= s.a && w.start <= s.b);
        words.push({
          text: w.word.replace(/^[,.;:!?]+|[,.;:!?]+$/g, '') || w.word,
          t,
          end: t + (w.end - w.start),
          kp: isKp,
          punct: /[.!?]$/.test(w.word),
        });
      }
    }
  }
  words.sort((a, b) => a.t - b.t);

  const lines: CaptionLine[] = [];
  let cur: CaptionLine | null = null;
  const flush = () => {
    if (cur && cur.words.length) lines.push(cur);
    cur = null;
  };
  for (const w of words) {
    const text = w.text;
    if (!text.trim()) continue;
    const gap = cur ? w.t - cur.end : 0;
    const len = cur ? cur.words.reduce((a, x) => a + x.text.length + 1, 0) : 0;
    const lastPunct = cur && cur.words.length ? cur.words[cur.words.length - 1].punct : false;
    const needNew =
      !cur ||
      cur.words.length >= 4 ||
      len + text.length > 26 ||
      gap > 0.42 ||
      (cur.words.length >= 2 && lastPunct);
    if (needNew) {
      flush();
      cur = { id: `cap-${lines.length}`, start: w.t - 0.06, end: w.end, words: [] };
    }
    const line = cur as CaptionLine; // non-null: needNew includes !cur
    line.words.push({ text: text.toUpperCase(), t: w.t, kp: w.kp, punct: w.punct });
    line.end = w.end;
    cur = line;
  }
  flush();
  // extend line end slightly for readability
  for (const l of lines) l.end = l.end + 0.3;
  return lines;
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Static HTML for one graphic panel (all markup precomputed — browser-safe). */
function graphicPanelHtml(g: Graphic & { compTime: number }, i: number): string {
  const t = g.type;
  if (t === 'stat')
    return `      <div class="gfx gfx-stat" id="gfx${i}"><div class="gfx-num">${esc(g.value || '')}</div><div class="gfx-title">${esc(g.title || '')}</div></div>`;
  if (t === 'progress')
    return `      <div class="gfx gfx-progress" id="gfx${i}"><div class="gfx-num"><span class="gfx-from">${esc(g.from || '')}</span><span class="gfx-arrow">→</span><span class="gfx-to">${esc(g.to || '')}</span></div><div class="gfx-title">${esc(g.title || '')}</div></div>`;
  if (t === 'list')
    return `      <div class="gfx gfx-list" id="gfx${i}"><div class="gfx-title">${esc(g.title || '')}</div>${(g.items || [])
      .map((it, k) => `        <div class="gfx-item"><span class="gfx-n">${k + 1}</span><span class="gfx-it">${esc(String(it))}</span></div>`)
      .join('\n')}</div>`;
  if (t === 'comparison')
    return `      <div class="gfx gfx-compare" id="gfx${i}"><div class="gfx-cmp"><div class="gfx-side">${esc(g.a || '')}</div><div class="gfx-vs">VS</div><div class="gfx-side">${esc(g.b || '')}</div></div><div class="gfx-title">${esc(g.title || '')}</div></div>`;
  // timeline
  const items = (g.items || []).map((it) => (typeof it === 'string' ? { when: '', label: it } : it));
  return `      <div class="gfx gfx-timeline" id="gfx${i}">${items
    .map((it) => `        <div class="gfx-item"><span class="gfx-n">${esc(it.when || '')}</span><span class="gfx-it">${esc(it.label)}</span></div>`)
    .join('\n')}${g.title ? `<div class="gfx-title">${esc(g.title)}</div>` : ''}</div>`;
}

/** Browser-safe GSAP block: entrance/exit per type + count-up for stats. */
function gfxCode(): string {
  return [
    'DATA.graphics.forEach(function (g) {',
    '  var showDur = 2.6;',
    '  var el = "#gfx" + g.i;',
    '  if (g.type === "stat" || g.type === "progress") {',
    '    tl.fromTo(el, { scale: 0.7, opacity: 0, y: 26 }, { scale: 1.05, opacity: 1, y: 0, duration: 0.28, ease: "power3.out" }, g.t);',
    '    tl.to(el, { scale: 1.0, duration: 0.22, ease: "power2.out" }, g.t + 0.28);',
    '    tl.to(el, { opacity: 0, y: -20, duration: 0.3, ease: "power1.in" }, g.t + showDur);',
    '    if (g.type === "stat") {',
    '      var numEl = document.querySelector(el + " .gfx-num");',
    '      var m = (g.value || "").match(/^([0-9]+(?:\.[0-9]+)?)(.*)$/);',
    '      if (m && numEl) {',
    '        var target = parseFloat(m[1]);',
    '        var st = { n: 0 };',
    '        tl.to(st, { n: target, duration: 0.6, ease: "power1.out", onUpdate: function () {',
    '          numEl.textContent = (st.n % 1 === 0 ? Math.round(st.n) : st.n.toFixed(1)) + m[2];',
    '        } }, g.t + 0.12);',
    '      }',
    '    } else {',
    '      tl.fromTo(el + " .gfx-from", { opacity: 0, x: -30 }, { opacity: 1, x: 0, duration: 0.25, ease: "power2.out" }, g.t + 0.1);',
    '      tl.fromTo(el + " .gfx-arrow", { opacity: 0, scale: 0.4 }, { opacity: 1, scale: 1, duration: 0.2, ease: "back.out(2)" }, g.t + 0.35);',
    '      tl.fromTo(el + " .gfx-to", { opacity: 0, x: 30, scale: 0.8 }, { opacity: 1, x: 0, scale: 1, duration: 0.3, ease: "back.out(1.6)" }, g.t + 0.55);',
    '    }',
    '  } else {',
    '    tl.fromTo(el, { x: -64, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: "power2.out" }, g.t);',
    '    var items = el + " .gfx-item";',
    '    tl.fromTo(items, { x: -40, opacity: 0 }, { x: 0, opacity: 1, duration: 0.25, ease: "power2.out", stagger: 0.22 }, g.t + 0.15);',
    '    tl.to(el, { opacity: 0, x: 44, duration: 0.3, ease: "power1.in" }, g.t + showDur + 0.3);',
    '  }',
    '});',
  ].join('\n      ');
}
