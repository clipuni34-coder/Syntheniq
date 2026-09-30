#!/usr/bin/env python3
"""Re-apply UI-verification fixes (post reset #7):
1. server: deep links — /project serves project.html (Next.js static export)
2. jobs: done() marks ALL stages done (was: 5 stages stuck 'running' in UI)
3. transcribe: strip whisper carry-over leading hyphens ("-by" -> "by")
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

print('ui fixes...')

# ── server.ts: deep links for static-export pages ───────────────────────
patch('apps/api/src/server.ts',
"""    if (p.startsWith('/v1')) return reply.code(404).send({ error: 'not found' });
    if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    try {""",
"""    if (p.startsWith('/v1')) return reply.code(404).send({ error: 'not found' });
    if (req.method !== 'GET') return reply.code(404).send({ error: 'not found' });
    // deep links: /project → project.html (Next.js static export pages)
    if (p !== '/' && p !== '' && !p.includes('..')) {
      const fsP = await import('node:fs/promises');
      for (const cand of [path.join(WEB_OUT_DIR, `${p}.html`), path.join(WEB_OUT_DIR, p, 'index.html')]) {
        try {
          await fsP.access(cand);
          reply.header('content-type', 'text/html');
          return reply.send(await fsP.readFile(cand));
        } catch {
          /* try next candidate */
        }
      }
    }
    try {""",
'server: deep links (/project → project.html)')

# ── jobs.ts: done() finishes every stage ────────────────────────────────
patch('apps/api/src/jobs.ts',
"""  done(msg: string): void {
    this.state.status = 'done';
    this.state.progress = 1;
    this.state.error = undefined; // a retried-to-success must not keep showing the old error
    if (this.state.stages['complete']) this.state.stages['complete'] = { status: 'done', progress: 1, detail: msg };""",
"""  done(msg: string): void {
    this.state.status = 'done';
    this.state.progress = 1;
    this.state.error = undefined; // a retried-to-success must not keep showing the old error
    for (const k of Object.keys(this.state.stages) as StageName[]) {
      this.state.stages[k] = { ...this.state.stages[k], status: 'done', progress: 1 };
    }
    if (this.state.stages['complete']) this.state.stages['complete'] = { status: 'done', progress: 1, detail: msg };""",
'jobs: done() marks all stages done')

# ── transcribe.ts: whisper carry-over hyphen tokens ─────────────────────
patch('apps/api/src/pipeline/transcribe.ts',
"""      words: (s.words || []).map((w: any) => ({
        start: w.start,
        end: w.end,
        word: String(w.word || ''),
        isFiller: FILLER.has(String(w.word || '').toLowerCase().replace(/[^a-z]/gi, '')),
      })),""",
"""      words: (s.words || []).map((w: any) => {
        // whisper sometimes emits carry-over tokens like "-by" / "-word" for
        // "word by word"; strip the leading hyphen (keeps real hyphenated words).
        const word = String(w.word || '').replace(/^-+/, '');
        return {
          start: w.start,
          end: w.end,
          word,
          isFiller: FILLER.has(word.toLowerCase().replace(/[^a-z]/gi, '')),
        };
      }),""",
'transcribe: strip carry-over leading hyphens')

print('ui fixes done')
