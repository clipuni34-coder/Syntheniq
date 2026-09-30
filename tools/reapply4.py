#!/usr/bin/env python3
"""Re-apply session improvements (post reset #5):
1. heuristic packaging: complete-sentence titles, derived angle, clean hashtags
2. qcClip: frozen-composition guard (black frames + static picture)
Idempotent."""
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

print('improvement patches...')

# ── index.ts: give the heuristic packager the clip window ───────────────
patch('apps/api/src/pipeline/index.ts',
"""  router.signals.packageInput = {
    clips: plan.clips.map((c, i) => ({
      index: i,
      title: c.title,
      hookText: c.hookText,
      cta: c.cta.text,""",
"""  router.signals.packageInput = {
    clips: plan.clips.map((c, i) => ({
      index: i,
      title: c.title,
      hookText: c.hookText,
      sourceStart: c.sourceStart,
      sourceEnd: c.sourceEnd,
      cta: c.cta.text,""",
'index: packageInput window')

# ── heuristic.ts: rewrite heuristicPackage ──────────────────────────────
patch('apps/api/src/ai/heuristic.ts',
"""  else if (req.task === 'package') json = heuristicPackage(s!.packageInput || { clips: [], keyphrases: [] });""",
"""  else if (req.task === 'package') json = heuristicPackage(s!.packageInput || { clips: [], keyphrases: [] }, s!);""",
'heuristic: callHeuristic passes signals')

old_pkg = open(os.path.join(ROOT, 'apps/api/src/ai/heuristic.ts')).read()
# version-drift guard: the committed heuristic.ts already carries the evolved
# 2-arg heuristicPackage — splicing would regress it, so skip when present.
_PKG_CURRENT = 'function heuristicPackage(input: { clips: any[]; keyphrases: string[] }, s: HeuristicSignals) {'
_pkg_skip = _PKG_CURRENT in old_pkg
if _pkg_skip:
    start = end = 0
else:
    start = old_pkg.index('function heuristicPackage(input: { clips: any[]; keyphrases: string[] }) {')
    end = old_pkg.index('function r2(n: number): number {')
new_pkg = '''/** Words that never make a good hashtag (content filler, pronouns, numbers-as-words). */
const PKG_STOP = new Set([
  'the','a','an','and','or','but','to','of','in','on','at','by','as','so','with','for','from',
  'you','your','yours','i','we','it','its','my','me','he','she','they','them','this','that',
  'these','those','is','are','was','were','be','been','am','do','does','did','done','can',
  'could','will','would','should','might','must','just','only','really','very','much','many',
  'more','most','all','any','some','no','not','nothing','time','times','thing','things','way',
  'ways','people','one','two','three','four','five','cannot','cant','dont','doesnt','wont',
  'um','uh','well','yeah','okay','ok','right','like','watch','video','videos','short','shorts',
  'back','come','comes','know','want','wants','good','great','big','small','true','actually',
  'basically','literally','completely','totally','kinda','sorta','make','makes','made','get',
  'gets','got','say','says','said','there','here','when','what','how','why','which','while',
  'second','first','next','last','final','spent','try','trying','change','changed','changes',
  'thank','thanks','thanks','try','one','week','weeks','months','month','hours','hour',
  'single','huge','view','views','read','read','view','screen','sound','fast','slow','new','old',
  'moment','decided','process','process','started','starting','stop','stopped','stopping',
]);

function cleanTag(phrase: string): string | null {
  const words = phrase
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, '')
    .split(/\\s+/)
    .filter((w) => w.length >= 3 && !PKG_STOP.has(w));
  if (!words.length) return null;
  let tag = words.join('');
  if (tag.length > 15) tag = words[0];
  return tag.length >= 3 && tag.length <= 15 ? tag : null;
}

function clipWindowText(s: HeuristicSignals, start: number, end: number): string {
  return s.transcript.segments
    .filter((sg) => sg.end > start + 0.05 && sg.start < end - 0.05)
    .map((sg) => sg.text)
    .join(' ');
}

/** Extend a hook fragment to its full sentence in the transcript (complete titles, §AI-path parity). */
function completeTitle(hook: string, s: HeuristicSignals): string {
  const base = String(hook || '').trim();
  if (base.length < 8) return base;
  // match the hook against the transcript tolerating punctuation the hook may lack
  // ("So three months ago I made" ↔ "So three months ago, I made …")
  const words = base.toLowerCase().replace(/[^a-z0-9\\s]/g, ' ').trim().split(/\\s+/).slice(0, 10);
  const esc = (w: string) => w.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&');
  const re = new RegExp(words.map((w) => esc(w)).join('[^a-z0-9]*'), 'i');
  for (const seg of s.transcript.segments) {
    const m = seg.text.match(re);
    if (!m || m.index == null) continue;
    const tail = seg.text.slice(m.index + m[0].length);
    const b = tail.match(/^[^.!?]*[.!?]/); // extend to the sentence end (raw punctuation kept)
    const full = (base + (b ? b[0] : '')).replace(/\\s+/g, ' ').trim().replace(/\\s+([,.!?])/g, '$1');
    // strip weak openers
    const cleaned = (full.replace(/^(so|um|uh|okay|ok|right|alright|yeah|actually|basically)[,\\s]+/i, '')
      .replace(/^(\\S)/, (m) => m.toUpperCase()));
    return cleaned.length >= 12 ? cleaned.slice(0, 95) : full.slice(0, 95);
  }
  return base.slice(0, 95);
}
/** Derive the narrative angle from what is actually spoken in the clip window. */
function deriveAngle(s: HeuristicSignals, start: number, end: number): string {
  const text = clipWindowText(s, start, end).toLowerCase();
  const ordinals = (text.match(/\\b(first|second|third|fourth|fifth|next|final|last)\\b/g) || []).length;
  const story = /\\b(mistake|wrong|failed|failure|learned|lesson|story|used to|three months ago|a year ago|last year|when i started)\\b/.test(text);
  const fix = /\\b(fix|fixed|changed|improvement|what i do|my process|my workflow)\\b/.test(text);
  const progress = /\\$|\\b\\d+\\s*(x|k|m|b)\\b|\\b(doubled|tripled|grew|increased|from zero|watch time|revenue|views)\\b/.test(text);
  if (story && fix) return 'Mistake → Fix (before/after)';
  if (ordinals >= 2) return 'List / how-to';
  if (ordinals >= 1 && fix) return 'List / how-to';
  if (story) return 'Personal story';
  if (progress) return 'Progression (numbers move)';
  return 'Direct value / tip';
}

/** Generic words that make bad hashtags even though they're not stopwords. */
const PKG_GENERIC = new Set(['words', 'word', 'text', 'read', 'screen', 'follow', 'sound', 'big', 'new', 'next', 'start', 'start', 'one', 'way']);

function buildHashtags(input: { keyphrases: string[] }, clip: any, s: HeuristicSignals): string[] {
  const tags: string[] = [];
  const push = (t: string | null) => {
    if (t && !tags.includes(t) && tags.length < 4) tags.push(t);
  };
  // 1. topic content words, ranked by (frequency, length, first appearance)
  //    ("…huge mistake with my editing workflow…" → workflow, editing, mistake, …)
  const topicWords = String(clip.topic || '').toLowerCase().match(/[a-z]{4,}/g) || [];
  const tfreq = new Map<string, number>();
  const tfirst = new Map<string, number>();
  topicWords.forEach((w, i) => {
    if (PKG_STOP.has(w) || PKG_GENERIC.has(w)) return;
    tfreq.set(w, (tfreq.get(w) || 0) + 1);
    if (!tfirst.has(w)) tfirst.set(w, i);
  });
  [...tfreq.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || tfirst.get(a[0])! - tfirst.get(b[0])!)
    .forEach(([w]) => push(w));
  // 2. keyphrases (multi-word first, then single words)
  const kws = [...(clip.keyphrases || []), ...input.keyphrases];
  for (const k of kws) if (String(k).includes(' ')) push(cleanTag(k));
  for (const k of kws) if (!String(k).includes(' ')) push(cleanTag(k));
  // 3. last resort: most frequent real content words spoken in the clip
  if (tags.length < 2) {
    const freq = new Map<string, number>();
    for (const w of clipWindowText(s, clip.sourceStart || 0, clip.sourceEnd || 1e9).toLowerCase().match(/[a-z]{5,}/g) || []) {
      if (!PKG_STOP.has(w) && !PKG_GENERIC.has(w)) freq.set(w, (freq.get(w) || 0) + 1);
    }
    [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).forEach(([w]) => push(w));
  }
  tags.push('shorts');
  return tags.map((t) => '#' + t);
}

function heuristicPackage(input: { clips: any[]; keyphrases: string[] }, s: HeuristicSignals) {
  const clips = input.clips.map((c: any, i: number) => {
    const hook = String(c.hookText || c.title || 'You have to see this.').trim();
    const title = completeTitle(hook, s).slice(0, 95) || 'You have to see this.';
    const angle = deriveAngle(s, c.sourceStart || 0, c.sourceEnd || s.media.duration);
    const hashtags = buildHashtags(input, c, s);
    const desc = String(c.topic || 'A moment from the full video — the key idea in under a minute.');
    return {
      index: i,
      title,
      angle,
      tiktokCaption: `${title} ${hashtags.slice(0, 4).join(' ')}`.trim(),
      instagramCaption: `${title}\\n\\n${desc}\\n\\n${hashtags.slice(0, 5).join(' ')}`.trim(),
      youtubeDescription: `${title}\\n\\n${desc}\\n\\n${hashtags.join(' ')}`.trim(),
      description: desc,
      hashtags,
      cta: 'Follow for more 🔔',
      variants: [
        { title: `${title} — take 2`.slice(0, 95), hookText: c.hookText },
      ],
    };
  });
  return { clips };
}

'''
if _pkg_skip:
    print('  = heuristic: heuristicPackage already at current signature (skip splice)')
else:
    open(os.path.join(ROOT, 'apps/api/src/ai/heuristic.ts'), 'w').write(old_pkg[:start] + new_pkg + old_pkg[end:])
    print('  + heuristic: heuristicPackage rewritten (title/angle/hashtags)')

# ── render.ts: frozen-composition guard in qcClip ───────────────────────
patch('apps/api/src/pipeline/render.ts',
"""  // full decode
  try {
    await pexecFile('ffmpeg', ['-v', 'error', '-i', outMp4, '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  } catch (e: any) {
    const msg = String(e.stderr || e.message).slice(0, 300);
    if (msg && !/Invalid data found/.test(msg)) issues.push(`decode errors: ${msg}`);
    else if (msg) warnings.push(`decode noise: ${msg}`);
  }""",
"""  // full decode
  try {
    await pexecFile('ffmpeg', ['-v', 'error', '-i', outMp4, '-f', 'null', '-'], { maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000 });
  } catch (e: any) {
    const msg = String(e.stderr || e.message).slice(0, 300);
    if (msg && !/Invalid data found/.test(msg)) issues.push(`decode errors: ${msg}`);
    else if (msg) warnings.push(`decode noise: ${msg}`);
  }

  // frozen-composition guard (spec §18/§27): a sub-composition that timed out
  // renders a STATIC snapshot that still probes as a perfectly valid MP4 —
  // exit code and ffprobe cannot catch it, so verify the picture actually
  // changes across the clip (captions/speaker/progress bar always move).
  try {
    const yavgs: { t: number; v: number }[] = [];
    for (let i = 1; i <= 6; i++) {
      const t = Math.max(0.1, (expectedDur * i) / 7);
      const { stdout } = await pexecFile(
        'ffmpeg',
        ['-hide_banner', '-ss', t.toFixed(2), '-i', outMp4, '-frames:v', '1', '-vf', 'signalstats,metadata=print:file=-', '-f', 'null', '-'],
        { maxBuffer: 8 * 1024 * 1024, timeout: 2 * 60 * 1000 },
      );
      const m = String(stdout).match(/lavfi\\.signalstats\\.YAVG=([0-9.]+)/);
      if (m) yavgs.push({ t, v: parseFloat(m[1]) });
    }
    if (yavgs.length >= 4) {
      const black = yavgs.find((y) => y.v < 12);
      if (black) issues.push(`frame at ${black.t.toFixed(1)}s is black (video track may not have rendered)`);
      const span = Math.max(...yavgs.map((y) => y.v)) - Math.min(...yavgs.map((y) => y.v));
      if (span < 0.15) issues.push(`picture is static across the clip (possible frozen composition snapshot)`);
    }
  } catch {
    /* signalstats unavailable — non-blocking */
  }""",
'render: frozen-composition guard')


patch('apps/api/src/server.ts',
"  if (!['error', 'interrupted', 'cancelled'].includes(job.status)) {",
"  if (!['error', 'interrupted', 'cancelled', 'done'].includes(job.status)) {",
'server: retry allows done jobs (re-process)')

print('improvement patches done')
