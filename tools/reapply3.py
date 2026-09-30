#!/usr/bin/env python3
"""Re-apply compose.ts patches: render the visual-storytelling graphics in the
fx overlay composition (browser-safe: all markup/CSS precomputed in Node, the
script only runs gsap animations on static elements — spec §27)."""
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

P = 'apps/api/src/pipeline/compose.ts'
print('compose patches...')

patch(P,
"""import type { CompSpec, CompSegment } from './prep.js';""",
"""import type { CompSpec, CompSegment } from './prep.js';
import type { Graphic } from './graphics.js';""",
'compose: import Graphic')

patch(P,
"""    callouts: spec.callouts.map((c) => ({ t: r3(c.compTime), text: c.text })),
  };""",
"""    callouts: spec.callouts.map((c) => ({ t: r3(c.compTime), text: c.text })),
    graphics: (spec.graphics || []).map((g, i) => ({
      i,
      t: r3(g.compTime),
      type: g.type,
      value: g.value || '',
      from: g.from || '',
      to: g.to || '',
    })),
  };""",
'compose: data.graphics')

patch(P,
"""    <div class="callout-wrap">
${spec.callouts.map((c, i) => `      <div class="callout" id="call${i}">${esc(c.text)}</div>`).join('\\n')}
    </div>""",
"""    <div class="callout-wrap">
${spec.callouts.map((c, i) => `      <div class="callout" id="call${i}">${esc(c.text)}</div>`).join('\\n')}
    </div>
    <div class="gfx-wrap">
${(spec.graphics || []).map((g, i) => graphicPanelHtml(g, i)).join('\\n')}
    </div>""",
'compose: gfx HTML')

patch(P,
"""      [data-composition-id="fx"] .callout { display:inline-block; font-size:76px; font-weight:800; color:${accent};
        text-shadow:0 3px 0 rgba(0,0,0,.55), 0 6px 22px rgba(0,0,0,.7); }""",
"""      [data-composition-id="fx"] .callout { display:inline-block; font-size:76px; font-weight:800; color:${accent};
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
      [data-composition-id="fx"] .gfx-vs { font-size:46px; font-weight:800; color:${accent}; text-shadow:0 3px 14px rgba(0,0,0,.8); }""",
'compose: gfx CSS')

patch(P,
"""      // CTA
      ${entranceFor(tempo, spec.motionStyle?.emotion).code('#cta', r3(spec.totalDur - 2.4))}""",
"""      // CTA
      ${entranceFor(tempo, spec.motionStyle?.emotion).code('#cta', r3(spec.totalDur - 2.4))}
      // visual-storytelling graphics (stat/progress/list/comparison/timeline)
      ${gfxCode()}""",
'compose: gfx GSAP')

# helper function at the bottom of compose.ts
patch(P,
"""function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}""",
"""function r3(n: number): number {
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
      .join('\\n')}</div>`;
  if (t === 'comparison')
    return `      <div class="gfx gfx-compare" id="gfx${i}"><div class="gfx-cmp"><div class="gfx-side">${esc(g.a || '')}</div><div class="gfx-vs">VS</div><div class="gfx-side">${esc(g.b || '')}</div></div><div class="gfx-title">${esc(g.title || '')}</div></div>`;
  // timeline
  const items = (g.items || []).map((it) => (typeof it === 'string' ? { when: '', label: it } : it));
  return `      <div class="gfx gfx-timeline" id="gfx${i}">${items
    .map((it) => `        <div class="gfx-item"><span class="gfx-n">${esc(it.when || '')}</span><span class="gfx-it">${esc(it.label)}</span></div>`)
    .join('\\n')}${g.title ? `<div class="gfx-title">${esc(g.title)}</div>` : ''}</div>`;
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
    '      var m = (g.value || "").match(/^([0-9]+(?:\\.[0-9]+)?)(.*)$/);',
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
  ].join('\\n      ');
}""" ,
'compose: gfx helpers')

print('compose patches done')
