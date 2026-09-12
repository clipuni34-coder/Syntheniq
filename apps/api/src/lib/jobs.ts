// Syntheniq — in-process job manager with SSE fan-out.
// The seam where Redis/BullMQ or Cloudflare Queues can later be swapped in.
import { EventEmitter } from 'node:events';
import type { JobPublic, JobStatus } from '../types.js';

interface JobInternal extends JobPublic {
  emitter: EventEmitter;
}

const jobs = new Map<string, JobInternal>();
const MAX_JOBS = 200;

function publicJob(job: JobInternal): JobPublic {
  return {
    id: job.id,
    type: job.type,
    label: job.label,
    status: job.status,
    progress: job.progress,
    message: job.message,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    result: job.result,
    error: job.error,
    meta: job.meta,
  };
}

function prune(): void {
  if (jobs.size <= MAX_JOBS) return;
  const entries = [...jobs.entries()].sort((a, b) => a[1].createdAt.localeCompare(b[1].createdAt));
  for (let i = 0; i < entries.length - MAX_JOBS; i++) jobs.delete(entries[i][0]);
}

export function createJob(type: string, label: string, meta: Record<string, unknown> = {}): JobPublic {
  prune();
  const now = new Date().toISOString();
  const id = 'job-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  const job: JobInternal = {
    id,
    type,
    label,
    status: 'running' as JobStatus,
    progress: 0,
    message: 'Starting…',
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null,
    meta,
    emitter: new EventEmitter(),
  };
  job.emitter.setMaxListeners(50);
  jobs.set(id, job);
  return publicJob(job);
}

export function getJob(id: string): JobPublic | null {
  const job = jobs.get(id);
  return job ? publicJob(job) : null;
}

function emit(job: JobInternal): void {
  job.updatedAt = new Date().toISOString();
  job.emitter.emit('update', publicJob(job));
}

export function updateJob(
  id: string,
  patch: { progress?: number; message?: string; meta?: Record<string, unknown> } = {}
): JobPublic | null {
  const job = jobs.get(id);
  if (!job) return null;
  if (typeof patch.progress === 'number') {
    job.progress = Math.max(0, Math.min(100, patch.progress));
  }
  if (typeof patch.message === 'string') job.message = patch.message;
  if (patch.meta && typeof patch.meta === 'object') job.meta = { ...job.meta, ...patch.meta };
  emit(job);
  return publicJob(job);
}

export function finishJob(id: string, result: Record<string, unknown> = {}): JobPublic | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'done';
  job.progress = 100;
  job.result = result || {};
  emit(job);
  return publicJob(job);
}

export function failJob(id: string, err: unknown): JobPublic | null {
  const job = jobs.get(id);
  if (!job) return null;
  job.status = 'error';
  job.error = err instanceof Error ? err.message : String(err);
  job.message = job.error;
  emit(job);
  return publicJob(job);
}

export function subscribe(
  id: string,
  listener: (job: JobPublic) => void
): (() => void) | null {
  const job = jobs.get(id);
  if (!job) return null;
  listener(publicJob(job));
  job.emitter.on('update', listener);
  return () => {
    job.emitter.off('update', listener);
  };
}
