// Syntheniq — promise-based wrappers around the ffmpeg/ffprobe CLIs.
import { spawn } from 'node:child_process';

export interface RunOptions {
  onStdoutLine?: ((line: string) => void) | null;
  onStderrLine?: ((line: string) => void) | null;
  timeoutMs?: number;
}

export function run(
  cmd: string,
  args: string[],
  { onStdoutLine = null, onStderrLine = null, timeoutMs = 0 }: RunOptions = {}
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBuf = '';
    let stderrBuf = '';
    let timer: ReturnType<typeof setTimeout> | null = null;

    const feed = (chunk: Buffer, which: 'out' | 'err') => {
      const text = chunk.toString('utf8');
      if (which === 'out') {
        stdout += text;
        stdoutBuf += text;
      } else {
        stderr += text;
        stderrBuf += text;
      }
      let idx: number;
      const cb = which === 'out' ? onStdoutLine : onStderrLine;
      let buf = which === 'out' ? stdoutBuf : stderrBuf;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (cb) {
          try {
            cb(line);
          } catch {
            // listener errors must never break process handling
          }
        }
      }
      if (which === 'out') stdoutBuf = buf;
      else stderrBuf = buf;
    };

    if (child.stdout) child.stdout.on('data', (c) => feed(c, 'out'));
    if (child.stderr) child.stderr.on('data', (c) => feed(c, 'err'));
    child.on('error', (err: Error & { stderr?: string }) => {
      if (timer) clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });
    child.on('close', (code: number | null) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr, code: code ?? 0 });
      else {
        const err = new Error(`${cmd} exited with code ${code}: ${tail(stderr)}`) as Error & {
          code: number | null;
          stdout: string;
          stderr: string;
        };
        err.code = code;
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      }
    });
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore
        }
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
    }
  });
}

function tail(text: string, max = 1200): string {
  const t = String(text || '').trim();
  return t.length > max ? '…' + t.slice(-max) : t;
}

export async function ffprobe(file: string): Promise<any> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'quiet',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    file,
  ]);
  return JSON.parse(stdout);
}

const availabilityCache: Record<string, boolean> = {};

export function hasCommand(cmd: string): Promise<boolean> {
  if (availabilityCache[cmd] !== undefined) return Promise.resolve(availabilityCache[cmd]);
  return run('sh', ['-c', `command -v ${cmd}`])
    .then(() => {
      availabilityCache[cmd] = true;
      return true;
    })
    .catch(() => {
      availabilityCache[cmd] = false;
      return false;
    });
}
