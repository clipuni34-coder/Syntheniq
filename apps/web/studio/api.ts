// Syntheniq studio — API client, job follower and formatters.

export interface Scores {
  hook: number;
  curiosity: number;
  payoff: number;
  standalone: number;
  emotion: number;
  visual: number;
}

export interface Clip {
  id: string;
  rank: number;
  start: number;
  end: number;
  duration: number;
  title: string;
  excerpt: string;
  scores: Scores;
  total: number;
  reasons: string[];
  captions?: { file: string | null; events: number };
  poster?: boolean;
  exported: { file: string; bytes: number; verified: Record<string, unknown>; exportedAt: string } | null;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  media: {
    filename: string;
    originalName?: string;
    bytes?: number;
    mime?: string;
    probe?: { duration: number; width: number; height: number; hasAudio: boolean };
    uploadedAt?: string;
  } | null;
  analysis: { clipCount: number; provider: string; topScore: number } | null;
  activeJob?: { id: string; type: string; clipId?: string } | null;
  notes: string[];
}

export interface Job {
  id: string;
  type: string;
  label: string;
  status: 'running' | 'done' | 'error';
  progress: number;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
  meta: Record<string, unknown>;
}

export interface ClipsData {
  projectId: string;
  provider: string;
  language: string | null;
  coverage: { ratio: number; coveredSeconds: number; durationSeconds: number } | null;
  stats: Record<string, unknown>;
  notes: string[];
  clips: Clip[];
  timeline: { duration: number; waveform: { t: number; rms: number }[]; sceneCuts: number[] };
}

export function apiBase(): string {
  const configured = (process.env.NEXT_PUBLIC_API_URL || '').replace(/\/$/, '');
  if (configured) return configured;
  if (typeof window !== 'undefined') {
    // Single-origin mode: the API serves the built web app itself.
    if (window.location.port === '8787') return window.location.origin;
  }
  return 'http://localhost:8787';
}

export async function api<T = Record<string, unknown>>(path: string, opts: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...((opts.headers as Record<string, string>) || {}) };
  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(apiBase() + path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export function mediaUrl(path: string): string {
  return apiBase() + path;
}

export function uploadVideo(
  projectId: string,
  file: File,
  onProgress: (loaded: number, total: number) => void
): Promise<Project> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${apiBase()}/v1/projects/${encodeURIComponent(projectId)}/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded, e.total);
    };
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        // ignore
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as unknown as Project);
      else reject(new Error((data.error as string) || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Upload failed — the connection dropped. Try again.'));
    const form = new FormData();
    form.append('video', file, file.name);
    xhr.send(form);
  });
}

export function followJob(
  jobId: string,
  handlers: { onUpdate: (job: Job) => void; onDone: (job: Job) => void; onError: (err: Error) => void }
): () => void {
  const { onUpdate, onDone, onError } = handlers;
  let finished = false;
  let source: EventSource | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const cleanup = () => {
    if (source) {
      source.close();
      source = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };
  const done = (job: Job) => {
    if (finished) return;
    finished = true;
    cleanup();
    onDone(job);
  };
  const fail = (err: Error) => {
    if (finished) return;
    finished = true;
    cleanup();
    onError(err);
  };
  const handle = (job: Job) => {
    onUpdate(job);
    if (job.status === 'done') done(job);
    else if (job.status === 'error') fail(new Error(job.error || 'Job failed'));
  };
  const poll = async () => {
    if (finished) return;
    try {
      const job = await api<Job>(`/v1/jobs/${encodeURIComponent(jobId)}`);
      handle(job);
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)));
    }
  };

  try {
    source = new EventSource(`${apiBase()}/v1/jobs/${encodeURIComponent(jobId)}/events`);
    source.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data) as Job);
      } catch {
        // ignore malformed frames
      }
    };
    source.onerror = () => {
      if (!finished && source) {
        source.close();
        source = null;
        pollTimer = setInterval(poll, 1500);
        void poll();
      }
    };
  } catch {
    pollTimer = setInterval(poll, 1500);
    void poll();
  }
  return () => {
    finished = true;
    cleanup();
  };
}

/* ---------- formatters -------------------------------------------------- */

export function fmtClock(s: number): string {
  s = Math.max(0, Math.floor(s || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return (h > 0 ? h + ':' : '') + mm + ':' + String(sec).padStart(2, '0');
}

export function fmtBytes(b?: number | null): string {
  if (b === undefined || b === null) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return (i === 0 ? v : v.toFixed(1)) + ' ' + u[i];
}

export function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}
