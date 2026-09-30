export const API: string = (typeof process !== 'undefined' && process.env.NEXT_PUBLIC_API_URL) || '';

export interface AiProviderStatus {
  id: string;
  configured: boolean;
  primary: boolean;
  inFallback: boolean;
  defaults: { deep: string; fast: string };
  taskOverrides: string[];
}

export interface AiConfigStatus {
  mode: 'ai' | 'heuristic';
  primary: string | null;
  fallback: string[];
  reviewProvider: string | null;
  providers: AiProviderStatus[];
  chains: Record<string, string[]>;
}

export interface ConfigResponse {
  authRequired: boolean;
  authorized: boolean;
  ai: AiConfigStatus;
  whisperModel: string;
}

export interface ProjectSummary {
  id: string;
  createdAt: string;
  status: string;
  stage: string | null;
  progress: number;
  title: string | null;
  clipCount: number;
  error?: string;
}

export interface ClipFile {
  mp4?: string;
  thumb?: string;
  meta?: string;
}

export interface ClipState {
  id: string;
  title: string;
  status: 'pending' | 'rendering' | 'done' | 'error';
  files: ClipFile;
  error?: string;
  duration?: number;
  fps?: number;
  variant?: {
    hookText: string;
    title: string;
    status: 'rendering' | 'done' | 'error';
    mp4?: string;
    thumb?: string;
  };
}

export interface ClipMeta {
  title: string;
  captions: { tiktok: string; instagram: string; youtube: string };
  description: string;
  hashtags: string[];
  cta: string;
  source: { start: number; end: number };
  rationale: string;
  variants: { title?: string; hookText?: string; note?: string }[];
  generatedBy?: string;
}

export interface JobState {
  id: string;
  createdAt: string;
  status: 'queued' | 'running' | 'done' | 'error' | 'interrupted' | 'cancelling' | 'cancelled';
  stage: string | null;
  progress: number;
  running: boolean;
  stages: Record<string, { status: string; progress: number; detail?: string }>;
  media?: { duration: number; fps: number; width: number; height: number; hasAudio: boolean };
  transcript?: { words: number; segments: number; coverage: number; model: string };
  plan?: { clipCount: number; clips: any[]; notes?: string };
  clips: ClipState[];
  providers: Record<string, string | undefined>;
  logs: { t: string; level: string; msg: string }[];
  error?: string;
  cancelRequested?: boolean;
}

export async function fetchConfig(): Promise<ConfigResponse | null> {
  try {
    return (await (await fetch(`${API}/v1/config`)).json()) as ConfigResponse;
  } catch {
    return null;
  }
}

export async function submitPasscode(password: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/v1/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listProjects(): Promise<ProjectSummary[]> {
  try {
    const d = (await (await fetch(`${API}/v1/projects`)).json()) as { projects: ProjectSummary[] };
    return d.projects;
  } catch {
    return [];
  }
}

export async function fetchJob(id: string): Promise<JobState | null> {
  try {
    return (await (await fetch(`${API}/v1/projects/${id}`)).json()) as JobState;
  } catch {
    return null;
  }
}

export async function createProject(): Promise<string | null> {
  try {
    const d = (await (await fetch(`${API}/v1/projects`, { method: 'POST' })).json()) as { id: string };
    return d.id;
  } catch {
    return null;
  }
}

/** XHR upload with progress callback. */
export function uploadVideo(projectId: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/v1/projects/${projectId}/upload`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload failed: ${xhr.status}`)));
    xhr.onerror = () => reject(new Error('upload failed (network)'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

export async function fetchClipMeta(projectId: string, name: string): Promise<ClipMeta | null> {
  try {
    return (await (await fetch(`${API}/v1/projects/${projectId}/files/${name}`)).json()) as ClipMeta;
  } catch {
    return null;
  }
}

export async function retryJob(id: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/v1/projects/${id}/retry`, { method: 'POST' });
    return res.ok;
  } catch {
    return false;
  }
}

export async function requestVariant(projectId: string, clipId: string, hookText: string): Promise<boolean> {
  try {
    const res = await fetch(`${API}/v1/projects/${projectId}/clips/${clipId}/variants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hookText }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export function fileUrl(projectId: string, name: string): string {
  return `${API}/v1/projects/${projectId}/files/${name}`;
}
