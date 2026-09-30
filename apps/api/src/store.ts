import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import type { JobState } from './pipeline/types.js';
import { STAGES } from './pipeline/types.js';

const JOB_FILE = 'job.json';

export function projectDir(projectId: string): string {
  // projectId is a UUID we generated; still sanitize to be safe.
  const safe = /^[a-zA-Z0-9_-]{8,64}$/.test(projectId) ? projectId : '';
  if (!safe) throw new Error('invalid project id');
  return path.join(DATA_DIR, safe);
}

export function newJobState(id: string): JobState {
  const stages: JobState['stages'] = {};
  for (const s of STAGES) stages[s] = { status: 'pending', progress: 0 };
  return {
    id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    stage: null,
    progress: 0,
    stages,
    clips: [],
    providers: { transcribe: '', analyze: '', plan: '', package: '' },
    logs: [],
  };
}

export async function saveJob(job: JobState): Promise<void> {
  const dir = projectDir(job.id);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${JOB_FILE}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(tmp, JSON.stringify(job, null, 1));
  await fs.rename(tmp, path.join(dir, JOB_FILE));
}

export async function loadJob(projectId: string): Promise<JobState | null> {
  try {
    const raw = await fs.readFile(path.join(projectDir(projectId), JOB_FILE), 'utf8');
    return JSON.parse(raw) as JobState;
  } catch {
    return null;
  }
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

export async function listProjects(): Promise<ProjectSummary[]> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(DATA_DIR);
  } catch {
    return [];
  }
  const out: ProjectSummary[] = [];
  for (const e of entries) {
    const job = await loadJob(e);
    if (!job) continue;
    const done = job.clips.find((c) => c.status === 'done');
    out.push({
      id: job.id,
      createdAt: job.createdAt,
      status: job.status,
      stage: job.stage,
      progress: job.progress,
      title: done?.title ?? job.plan?.clips[0]?.title ?? null,
      clipCount: job.clips.filter((c) => c.status === 'done').length,
      error: job.error,
    });
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function isProjectId(p: string): boolean {
  return /^[a-zA-Z0-9_-]{8,64}$/.test(p);
}
