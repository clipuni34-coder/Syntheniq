#!/usr/bin/env python3
"""Re-apply render watchdog (hung hyperframes render → SIGKILL process group, 40 min).
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

print('render watchdog...')

patch('apps/api/src/pipeline/render.ts',
"import { execFile } from 'node:child_process';",
"import { execFile, spawn } from 'node:child_process';",
'render: import spawn')

patch('apps/api/src/pipeline/render.ts',
"""  log(`[render] ${path.basename(compDir)}: hyperframes render (${fps}fps, standard, 1 worker)`);
  try {
    await pexecFile(
      bin,
      [
        'render',
        compDir,
        '-o',
        outMp4,
        '--fps',
        String(fps),
        '--quality',
        'standard',
        '--workers',
        '1',
        '--video-frame-format',
        'jpg',
        '--frames-cache-dir',
        hfFrames,
      ],
      {
        cwd: ROOT,
        timeout: 45 * 60 * 1000,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...toolEnv(), TMPDIR: hfTmp },
      },
    );
  } catch (e: any) {
    const tail = String((e as any).stderr || '').split('\\n').slice(-12).join(' | ');
    log(`[render] FAILED: ${tail || e.message}`);
    throw new Error(`hyperframes render failed: ${tail || e.message}`.slice(0, 2000));
  }""",
"""  log(`[render] ${path.basename(compDir)}: hyperframes render (${fps}fps, standard, 1 worker)`);
  const renderArgs = [
    'render',
    compDir,
    '-o',
    outMp4,
    '--fps',
    String(fps),
    '--quality',
    'standard',
    '--workers',
    '1',
    '--video-frame-format',
    'jpg',
    '--frames-cache-dir',
    hfFrames,
  ];
  try {
    // Watchdog: hyperframes can HANG with its chrome child dead (swiftshader on
    // CPU-only boxes). A SIGTERM timeout does not help because the CLI waits on
    // the dead child — so run in its own process group and SIGKILL the whole
    // group past the limit. The pipeline's 1 retry then re-renders (proven:
    // caught a 51-min hang live).
    await new Promise<void>((resolve, reject) => {
      const child = spawn(bin, renderArgs, {
        cwd: ROOT,
        detached: true,
        env: { ...toolEnv(), TMPDIR: hfTmp },
      });
      let tail = '';
      const pump = (d: Buffer) => {
        tail += d.toString();
        if (tail.length > 65536) tail = tail.slice(-65536);
      };
      child.stdout?.on('data', pump);
      child.stderr?.on('data', pump);
      let settled = false;
      const watchdog = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        reject({ message: 'render watchdog: killed hung render after 40 min', stderr: '' });
      }, 40 * 60 * 1000);
      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        reject({ message: err.message, stderr: tail });
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (code === 0) resolve();
        else reject({ message: `exit code ${code}`, stderr: tail });
      });
    });
  } catch (e: any) {
    const tail = String((e as any).stderr || '').split('\\n').slice(-12).join(' | ');
    log(`[render] FAILED: ${tail || e.message}`);
    throw new Error(`hyperframes render failed: ${tail || e.message}`.slice(0, 2000));
  }""",
'render: hung-render watchdog (process-group SIGKILL at 40 min)')

print('render watchdog done')
