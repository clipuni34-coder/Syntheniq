// Motion-graphics engine — reusable, data-driven animation components for the
// HyperFrames layer. Every cue comes from the edit decision (ClipPlan.motion,
// produced by the AI or the heuristic engine) — nothing is hard-coded per video.
//
// Cue kinds:
//   emphasis   — caption-word treatment: underline | box | circle | arrow
//   impact     — flash + camera shake + shape accent (emotional peaks)
//   lowerThird — animated topic bar
//   pulse      — audio-reactive accent pulse (voice-energy onsets)
//   transition — segment boundary: flash | wipe | pulse (structural)
//   drift      — slow camera push on a segment (structural)
//   settle     — end-of-clip gentle zoom (structural)
//
// Determinism: no Math.random(), no Date.now() — variants are chosen by index
// and signal values only, so renders are reproducible.

import type { ClipPlan, MotionCue, MotionPlan } from './types.js';

export interface CompSeg {
  file: string;
  compStart: number;
  compDur: number;
  srcStart: number;
  srcEnd: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const num = (v: unknown, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);

const IMPERATIVES = new Set([
  'fix', 'try', 'watch', 'look', 'come', 'back', 'use', 'keep', 'stop', 'start', 'do', 'make', 'get', 'go', 'send', 'check',
]);

export function tempoFor(energy: number): MotionPlan['style'] {
  return { tempo: energy < 0.35 ? 'calm' : energy < 0.6 ? 'steady' : 'energetic' };
}

// ── heuristic editorial cues (source timeline) ────────────────────────────

export function deriveEditorialCues(input: {
  start: number;
  end: number;
  segments: { start: number; end: number }[];
  energy: { t: number; rms: number }[];
  keyphrases: { text: string; times: number[] }[];
  punchIns: { time: number; zoom: number }[];
  topics: { start: number; end: number; title: string; emotion: string; importance: number }[];
  music: string;
  energyLevel: number;
}): MotionCue[] {
  const { start, end, segments, energy, keyphrases, punchIns, topics } = input;
  const inKept = (t: number) => segments.some((s) => t >= s.start - 0.05 && t <= s.end + 0.05);
  const cues: MotionCue[] = [];

  // ── impacts: local energy peaks (emotional peaks) ──────────────────────
  const clipE = energy.filter((e) => e.t >= start && e.t <= end);
  const mean = clipE.length ? clipE.reduce((a, e) => a + e.rms, 0) / clipE.length : 0;
  const std = clipE.length ? Math.sqrt(clipE.reduce((a, e) => a + (e.rms - mean) ** 2, 0) / clipE.length) : 0;
  const peaks = clipE
    .filter((e) => e.rms > mean + 0.5 * std && e.rms >= 0.3 && e.t > start + 3 && e.t < end - 3)
    .sort((a, b) => b.rms - a.rms);
  const impacts: MotionCue[] = [];
  for (const p of peaks) {
    if (impacts.length >= 2) break;
    if (impacts.some((x) => Math.abs(x.t - p.t) < 4)) continue;
    if (punchIns.some((pi) => Math.abs(pi.time - p.t) < 1.0)) continue; // punch-in already marks this
    if (!inKept(p.t)) continue;
    impacts.push({
      kind: 'impact',
      t: p.t,
      intensity: clamp((p.rms - mean) / (std + 1e-6), 0.4, 1),
      reason: 'energy peak (emotional peak)',
    });
  }
  cues.push(...impacts);

  // ── emphasis: keyphrase treatments ─────────────────────────────────────
  let underlines = 0, boxes = 0, circles = 0, arrows = 0, trackings = 0;
  for (const kw of keyphrases.slice(0, 6)) {
    const t = kw.times.find((x) => x >= start && x <= end && inKept(x));
    if (t == null) continue;
    if (cues.some((c) => c.kind === 'emphasis' && Math.abs(c.t - t) < 1.2)) continue;
    const word = kw.text.split(/\s+/).pop() || kw.text;
    const clean = word.toLowerCase().replace(/[^a-z0-9']/g, '');
    let variant: string;
    if (arrows < 1 && IMPERATIVES.has(clean)) variant = 'arrow';
    else if (circles < 1 && impacts.some((im) => Math.abs(im.t - t) < 1.4)) variant = 'circle';
    else if (boxes < 2 && (clean.length >= 7 || /\d/.test(clean))) variant = 'box';
    else if (trackings < 2 && clean.length >= 5 && clean.length <= 12) variant = 'tracking';
    else if (underlines < 4) variant = 'underline';
    else continue;
    if (variant === 'arrow') arrows++;
    else if (variant === 'circle') circles++;
    else if (variant === 'box') boxes++;
    else if (variant === 'tracking') trackings++;
    else underlines++;
    cues.push({ kind: 'emphasis', t, variant, text: word, reason: `keyphrase "${kw.text}"` });
  }

  // ── lower thirds: topic changes ────────────────────────────────────────
  let lt = 0;
  for (const topic of topics) {
    if (lt >= 3) break;
    if (topic.end <= start || topic.start >= end) continue;
    const t = clamp(topic.start, start, end - 4);
    if (t < start + 4) continue; // hook region — avoid clutter
    if (!inKept(t)) continue;
    if (cues.some((c) => c.kind === 'lowerThird' && Math.abs(c.t - t) < 6)) continue;
    const text = String(topic.title || '').replace(/\s+/g, ' ').slice(0, 28).toUpperCase();
    if (text.length < 3) continue;
    cues.push({ kind: 'lowerThird', t, text, dur: 3.2, reason: `topic change: ${text}` });
    lt++;
  }

  // ── pulses: voice-energy onsets (audio-reactive) ───────────────────────
  const onsets: MotionCue[] = [];
  for (let i = 1; i < clipE.length; i++) {
    if (onsets.length >= 8) break;
    const e = clipE[i];
    if (e.rms - clipE[i - 1].rms > 0.08 && e.rms > 0.25) {
      if (onsets.some((o) => Math.abs(o.t - e.t) < 0.8)) continue;
      if (impacts.some((im) => Math.abs(im.t - e.t) < 1.0)) continue; // flash covers this
      if (!inKept(e.t)) continue;
      onsets.push({ kind: 'pulse', t: e.t, intensity: clamp(e.rms, 0.3, 1), reason: 'energy onset' });
    }
  }
  cues.push(...onsets);

  return cues.sort((a, b) => a.t - b.t);
}

// ── AI cue validation ─────────────────────────────────────────────────────

const KINDS = new Set(['emphasis', 'impact', 'lowerThird', 'pulse', 'transition', 'drift', 'settle']);
const CAPS: Record<string, number> = { emphasis: 8, impact: 2, lowerThird: 3, pulse: 8 };

export function sanitizeMotionCues(raw: any, start: number, end: number): MotionPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const style = {
    tempo: ['calm', 'steady', 'energetic'].includes(raw.style?.tempo) ? raw.style.tempo : 'steady',
    emotion: typeof raw.style?.emotion === 'string' ? raw.style.emotion.slice(0, 24) : undefined,
  };
  if (!Array.isArray(raw.cues)) return { cues: [], style };
  const out: MotionCue[] = [];
  const counts: Record<string, number> = {};
  for (const c of raw.cues.slice(0, 40)) {
    if (!c || !KINDS.has(c.kind)) continue;
    const t = num(c.t, -1);
    if (t < start || t > end) continue;
    counts[c.kind] = (counts[c.kind] || 0) + 1;
    if (CAPS[c.kind] != null && counts[c.kind] > CAPS[c.kind]) continue;
    const cue: MotionCue = {
      kind: c.kind,
      t,
      intensity: clamp(num(c.intensity, 0.6), 0.1, 1),
      reason: typeof c.reason === 'string' ? c.reason.slice(0, 120) : undefined,
    };
    if (c.kind === 'emphasis') {
      const word = String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 24);
      if (!word) continue;
      cue.text = word;
      cue.variant = ['underline', 'box', 'circle', 'arrow', 'tracking'].includes(c.variant) ? c.variant : 'underline';
    } else if (c.kind === 'lowerThird') {
      const text = String(c.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 28);
      if (text.length < 3) continue;
      cue.text = text.toUpperCase();
      cue.dur = clamp(num(c.dur, 3.2), 1.5, 6);
    }
    out.push(cue);
  }
  return { cues: out.sort((a, b) => a.t - b.t), style };
}

// ── spec-time assembly (comp time) + structural cues ──────────────────────

/**
 * Structural cues derived purely from the kept segments + punch-ins:
 * boundary transitions, per-segment camera drift, end settle. Always present
 * so even a legacy spec (no editorial motion) still gets camera movement.
 */
export function structuralMotion(segs: CompSeg[], punchIns: { compTime: number }[], totalDur: number): MotionCue[] {
  const cues: MotionCue[] = [];
  // structural: transitions at segment boundaries
  const gaps: number[] = [];
  for (let i = 1; i < segs.length; i++) gaps.push(segs[i].srcStart - segs[i - 1].srcEnd);
  segs.forEach((s, i) => {
    if (i === 0) return;
    const gap = gaps[i - 1];
    const variant = gap >= 1.2 ? 'flash' : i % 2 === 0 ? 'wipe' : 'pulse';
    cues.push({ kind: 'transition', t: s.compStart, variant, reason: `segment boundary (gap ${gap.toFixed(2)}s)` });
  });

  // structural: drift on segments WITHOUT a punch-in (movement vs emphasis — never both)
  segs.forEach((s, i) => {
    const hasPunch = punchIns.some((p) => p.compTime >= s.compStart - 0.05 && p.compTime < s.compStart + s.compDur);
    const hasTransitionPulse = cues.some((c) => c.kind === 'transition' && c.variant === 'pulse' && Math.abs(c.t - s.compStart) < 0.01);
    if (hasPunch || hasTransitionPulse) return;
    const amp = s.compDur > 8 ? 0.035 : 0.025;
    cues.push({ kind: 'drift', t: s.compStart, dur: s.compDur, intensity: amp, variant: 'push', reason: 'subtle camera push' });
  });

  // structural: settle into the CTA
  if (totalDur > 8) {
    cues.push({ kind: 'settle', t: totalDur - 2.6, dur: 2.6, intensity: 0.02, reason: 'settle into CTA' });
  }
  return cues.sort((a, b) => a.t - b.t);
}

/** Full spec-time cue list: editorial cues (from the edit decision) mapped to
 *  composition time + structural cues. Cues inside cut gaps are dropped. */
export function buildSpecMotion(
  plan: ClipPlan,
  segs: CompSeg[],
  punchIns: { compTime: number }[],
  totalDur: number,
): MotionCue[] {
  const srcToComp = (t: number): number | null => {
    for (const s of segs) {
      if (t >= s.srcStart - 0.02 && t <= s.srcEnd + 0.02) return s.compStart + (t - s.srcStart);
    }
    return null;
  };
  const cues: MotionCue[] = [];
  for (const c of plan.motion?.cues ?? []) {
    if (c.kind === 'transition' || c.kind === 'drift' || c.kind === 'settle') continue; // structural, derived below
    const t = srcToComp(c.t);
    if (t == null) continue; // falls in a cut gap
    cues.push({ ...c, t });
  }
  cues.push(...structuralMotion(segs, punchIns, totalDur));
  return cues.sort((a, b) => a.t - b.t);
}

// ── reusable component builders ───────────────────────────────────────────

/** Glyph injected inside a caption word span (absolute-positioned children).
 *  `arrowLeft` mirrors the arrow to the word's left when the word sits near
 *  the right edge of the frame (avoids clipping). "tracking" needs no glyph
 *  (the word's letter-spacing itself animates). */
export function emphasisGlyph(kind: string, accent: string, arrowLeft = false): string {
  switch (kind) {
    case 'box':
      return `<i class="mg-box" style="border-color:${accent}"></i>`;
    case 'circle':
      return `<svg class="mg-circle" viewBox="0 0 200 110" preserveAspectRatio="none"><ellipse cx="100" cy="55" rx="90" ry="44" fill="none" stroke="${accent}" stroke-width="9"/></svg>`;
    case 'arrow': {
      const paths = `<path d="M82 14 C 40 18, 22 44, 16 78" fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round"/><path d="M44 66 L 14 84 L 40 96" fill="none" stroke="${accent}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>`;
      const inner = arrowLeft ? `<g transform="scale(-1,1) translate(-100,0)">${paths}</g>` : paths;
      return `<svg class="mg-arrow${arrowLeft ? ' mg-arrow-l' : ''}" viewBox="0 0 100 100">${inner}</svg>`;
    }
    case 'tracking':
      return '';
    default: // underline
      return `<i class="mg-und" style="background:${accent}"></i>`;
  }
}

/** HTML for fx-layer motion components (lower thirds, impacts, pulses, transition overlays). */
export function fxMotionHtml(cues: MotionCue[], accent: string): { html: string; ids: Record<string, number[]> } {
  const parts: string[] = [];
  const ids: Record<string, number[]> = { lowerThird: [], impact: [], pulse: [], transition: [] };
  cues.forEach((c, i) => {
    if (c.kind === 'lowerThird') {
      const id = ids.lowerThird.length;
      ids.lowerThird.push(i);
      parts.push(
        `<div class="lt" id="lt${id}"><i style="background:${accent}"></i><span>${esc(c.text || '')}</span></div>`,
      );
    } else if (c.kind === 'impact') {
      const id = ids.impact.length;
      ids.impact.push(i);
      const side = id % 2 === 0 ? 'left:18%' : 'right:18%';
      parts.push(
        `<div class="impFlash" id="impF${id}"></div>` +
          `<svg class="impShape" id="impS${id}" style="${side}" viewBox="0 0 120 120">` +
          `<path d="M60 6 L72 44 L112 60 L72 76 L60 114 L48 76 L8 60 L48 44 Z" fill="${accent}"/>` +
          `</svg>`,
      );
    } else if (c.kind === 'pulse') {
      const id = ids.pulse.length;
      ids.pulse.push(i);
      parts.push(`<div class="pulse" id="pl${id}" style="background:${accent}"></div>`);
    } else if (c.kind === 'transition' && c.variant === 'wipe') {
      const id = ids.transition.length;
      ids.transition.push(i);
      parts.push(
        `<div class="wipe" id="wp${id}"><i style="background:linear-gradient(105deg, transparent, ${accent} 30%, ${accent} 70%, transparent)"></i></div>`,
      );
    } else if (c.kind === 'transition' && c.variant === 'flash') {
      const id = ids.transition.length;
      ids.transition.push(i);
      parts.push(`<div class="impFlash transFlash" id="trF${id}"></div>`);
    }
  });
  return { html: parts.join('\n    '), ids };
}

/** GSAP code (string) added to the fx timeline for fx-layer cues. */
export function fxMotionCode(cues: MotionCue[], ids: Record<string, number[]>, totalDur: number): string {
  const L: string[] = [];
  cues.forEach((c, i) => {
    if (c.kind === 'lowerThird') {
      const id = ids.lowerThird.indexOf(i);
      const t = r3(c.t);
      const out = r3(clamp(c.t + (c.dur ?? 3.2), c.t + 1.2, totalDur - 0.6));
      L.push(
        `tl.fromTo("#lt${id}", { opacity: 0 }, { opacity: 1, duration: 0.12 }, ${t});` +
          `tl.fromTo("#lt${id} i", { scaleY: 0 }, { scaleY: 1, duration: 0.22, ease: "power2.out" }, ${t});` +
          `tl.fromTo("#lt${id} span", { x: -46, opacity: 0 }, { x: 0, opacity: 1, duration: 0.3, ease: "power3.out" }, ${t + 0.06});` +
          `tl.to("#lt${id}", { opacity: 0, x: -24, duration: 0.3, ease: "power1.in" }, ${out});`,
      );
    } else if (c.kind === 'impact') {
      const id = ids.impact.indexOf(i);
      const t = r3(c.t);
      const k = r3(0.3 + (c.intensity ?? 0.6) * 0.3);
      L.push(
        `tl.fromTo("#impF${id}", { opacity: 0 }, { opacity: ${k}, duration: 0.06, ease: "power2.out" }, ${t});` +
          `tl.to("#impF${id}", { opacity: 0, duration: 0.28, ease: "power1.out" }, ${t + 0.06});` +
          `tl.fromTo("#impS${id}", { scale: 0.35, opacity: 0, rotation: -12 }, { scale: 1.05, opacity: 0.95, rotation: 0, duration: 0.22, ease: "back.out(1.8)" }, ${t + 0.03});` +
          `tl.to("#impS${id}", { scale: 0.9, opacity: 0, duration: 0.35, ease: "power1.in" }, ${t + 0.45});`,
      );
    } else if (c.kind === 'pulse') {
      const id = ids.pulse.indexOf(i);
      const t = r3(c.t);
      const a = r3(0.25 + (c.intensity ?? 0.5) * 0.3);
      L.push(
        `tl.fromTo("#pl${id}", { opacity: 0, scaleY: 1 }, { opacity: ${a}, scaleY: 2.4, duration: 0.14, ease: "power2.out" }, ${t});` +
          `tl.to("#pl${id}", { opacity: 0, scaleY: 1, duration: 0.4, ease: "power1.out" }, ${t + 0.14});`,
      );
    } else if (c.kind === 'transition' && c.variant === 'wipe') {
      const id = ids.transition.indexOf(i);
      const t = r3(c.t);
      L.push(`tl.fromTo("#wp${id} i", { x: "-130%" }, { x: "130%", duration: 0.42, ease: "power2.inOut" }, ${r3(t - 0.08)});`);
    } else if (c.kind === 'transition' && c.variant === 'flash') {
      const id = ids.transition.indexOf(i);
      const t = r3(c.t);
      L.push(`tl.fromTo("#trF${id}", { opacity: 0 }, { opacity: 0.5, duration: 0.05 }, ${r3(t - 0.04)});` +
          `tl.to("#trF${id}", { opacity: 0, duration: 0.22, ease: "power1.out" }, ${r3(t + 0.01)});`);
    }
  });
  return L.join('\n      ');
}

/**
 * GSAP code (string) added to the ROOT timeline: drifts (segment scale),
 * transition "pulse" (incoming-segment pop), impact camera shake, settle zoom.
 */
export function rootMotionCode(cues: MotionCue[], segs: CompSeg[]): string {
  const L: string[] = [];
  const segByCompStart = new Map<number, number>();
  segs.forEach((s, i) => segByCompStart.set(r3(s.compStart), i));
  for (const c of cues) {
    if (c.kind === 'drift') {
      const idx = segByCompStart.get(r3(c.t));
      if (idx == null) continue;
      const amp = r3(1 + (c.intensity ?? 0.03));
      L.push(`tl.to("#seg${idx}", { scale: ${amp}, duration: ${r3(c.dur ?? 6)}, ease: "none" }, ${r3(c.t)});`);
    } else if (c.kind === 'transition' && c.variant === 'pulse') {
      const idx = segByCompStart.get(r3(c.t));
      if (idx == null) continue;
      L.push(`tl.fromTo("#seg${idx}", { scale: 1.055 }, { scale: 1.0, duration: 0.28, ease: "power2.out" }, ${r3(c.t)});`);
    } else if (c.kind === 'impact') {
      const t = r3(c.t);
      const k = r3(0.5 + (c.intensity ?? 0.6) * 0.5);
      L.push(
        `tl.to("#root", { x: ${-8 * k}, duration: 0.05, ease: "power2.out" }, ${t});` +
          `tl.to("#root", { x: ${6 * k}, duration: 0.07 }, ${t + 0.05});` +
          `tl.to("#root", { x: ${-3 * k}, duration: 0.06 }, ${t + 0.12});` +
          `tl.to("#root", { x: 0, duration: 0.09, ease: "power1.out" }, ${t + 0.18});` +
          `tl.to("#root", { y: ${-5 * k}, duration: 0.09 }, ${t + 0.04});` +
          `tl.to("#root", { y: 0, duration: 0.12, ease: "power1.out" }, ${t + 0.16});`,
      );
    } else if (c.kind === 'settle') {
      L.push(`tl.to("#root", { scale: ${r3(1 + (c.intensity ?? 0.02))}, duration: ${r3(c.dur ?? 2.5)}, ease: "none" }, ${r3(c.t)});`);
    }
  }
  return L.join('\n    ');
}

/** CSS for fx-layer motion components. */
export function motionFxCss(): string {
  return `
      [data-composition-id="fx"] .lt { position:absolute; left:6%; right:6%; bottom:13%; z-index:48; display:flex; align-items:center; gap:22px; opacity:0; }
      [data-composition-id="fx"] .lt i { width:10px; height:56px; border-radius:5px; flex:0 0 auto; transform-origin:center; }
      [data-composition-id="fx"] .lt span { font-size:52px; font-weight:800; color:#fff; letter-spacing:-1px; text-shadow:0 3px 18px rgba(0,0,0,.7); }
      [data-composition-id="fx"] .impFlash { position:absolute; inset:0; z-index:66; background:#fff; opacity:0; pointer-events:none; }
      [data-composition-id="fx"] .transFlash { z-index:64; }
      [data-composition-id="fx"] .impShape { position:absolute; top:34%; width:130px; height:130px; z-index:65; opacity:0; }
      [data-composition-id="fx"] .pulse { position:absolute; left:0; right:0; top:4.6%; height:5px; z-index:61; opacity:0; transform-origin:center; }
      [data-composition-id="fx"] .wipe { position:absolute; inset:0; z-index:70; overflow:hidden; pointer-events:none; }
      [data-composition-id="fx"] .wipe i { position:absolute; top:-12%; bottom:-12%; left:0; width:46%; transform:skewX(-14deg); }
      [data-composition-id="fx"] .word.mgw { position:relative; }
      [data-composition-id="fx"] .word.mgt .mg-ch { display:inline-block; }
      [data-composition-id="fx"] .mg-und { position:absolute; left:6px; right:6px; bottom:-8px; height:8px; border-radius:4px; opacity:0; transform:scaleX(0); transform-origin:left center; }
      [data-composition-id="fx"] .mg-box { position:absolute; inset:-10px -12px; border:5px solid; border-radius:20px; opacity:0; }
      [data-composition-id="fx"] .mg-circle { position:absolute; left:-18%; top:-42%; width:136%; height:184%; opacity:0; }
      [data-composition-id="fx"] .mg-arrow { position:absolute; left:104%; top:-46%; width:96px; height:96px; opacity:0; }
      [data-composition-id="fx"] .mg-arrow-l { left:auto; right:104%; }`;
}

/**
 * GSAP code for emphasis glyphs (runs in the fx timeline, after captions).
 * `items` = { el: '#cap-x-wy', t: number, variant: string }
 */
export function emphasisCode(items: { el: string; t: number; variant: string }[]): string {
  return items
    .map((it) => {
      const t = r3(it.t);
      switch (it.variant) {
        case 'box':
          return `tl.fromTo("${it.el} .mg-box", { scale: 0.72, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.2, ease: "back.out(1.9)" }, ${r3(t + 0.06)});`;
        case 'circle':
          return `tl.fromTo("${it.el} .mg-circle", { scale: 0.8, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.24, ease: "back.out(1.7)" }, ${r3(t + 0.06)});`;
        case 'arrow':
          return (
            `tl.fromTo("${it.el} .mg-arrow", { scale: 0.5, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.22, ease: "back.out(1.8)" }, ${r3(t + 0.08)});` +
            `tl.to("${it.el} .mg-arrow", { y: 8, duration: 0.4, yoyo: true, repeat: 1, ease: "power1.inOut" }, ${r3(t + 0.34)});`
          );
        case 'tracking':
          // tracking-style emphasis: per-glyph x-spread from the word's center,
          // then settle back (transforms only — smooth under seek-by-frame capture)
          return (
            `tl.to("${it.el} .mg-ch", { x: (i, el) => { const s = el.parentNode.children.length; return (i - (s - 1) / 2) * 3.2; }, duration: 0.3, ease: "power3.out" }, ${t});` +
            `tl.to("${it.el} .mg-ch", { x: 0, duration: 0.55, ease: "power1.out" }, ${r3(t + 0.32)});`
          );
        default:
          return `tl.fromTo("${it.el} .mg-und", { scaleX: 0, opacity: 0 }, { scaleX: 1, opacity: 1, duration: 0.24, ease: "power3.out" }, ${r3(t + 0.05)});`;
      }
    })
    .join('\n      ');
}

/**
 * Emotion-matched entrance variant for text elements (hook, callouts, CTA).
 * `hint` = the clip's emotion tag and/or the callout style ('stat'/'quote').
 */
export function entranceFor(tempo: string, hint?: string): { name: string; code: (sel: string, t: number) => string } {
  const h = (hint || '').toLowerCase();
  const base =
    tempo === 'energetic' || /excit|hyp|joy|win|fire|power|epic|insane|crazy|stat|best/.test(h)
      ? 'pop'
      : tempo === 'calm' || /calm|peace|sad|serious|reflect|think|soft|quiet|quote/.test(h)
        ? 'rise'
        : 'slide';
  switch (base) {
    case 'pop':
      return {
        name: 'pop',
        code: (sel, t) => `tl.fromTo("${sel}", { scale: 0.55, opacity: 0 }, { scale: 1, opacity: 1, duration: 0.32, ease: "back.out(1.9)" }, ${r3(t)});`,
      };
    case 'rise':
      return {
        name: 'rise',
        code: (sel, t) => `tl.fromTo("${sel}", { y: 46, opacity: 0 }, { y: 0, opacity: 1, duration: 0.42, ease: "power3.out" }, ${r3(t)});`,
      };
    default:
      return {
        name: 'slide',
        code: (sel, t) => `tl.fromTo("${sel}", { x: -52, opacity: 0 }, { x: 0, opacity: 1, duration: 0.34, ease: "power3.out" }, ${r3(t)});`,
      };
  }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
