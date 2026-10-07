// Syntheniq — production job manager.
//
// Jobs live in the configured store (Postgres in production), so they
// survive process restarts. One or more workers claim jobs atomically
// (see JobStore.claimNext) with leases + heartbeats: if a worker dies,
// its lease expires and another worker reclaims the orphan.
//
// Progress subscriptions poll the store, so SSE works identically whether
// the job runs in this process or on another worker.
import type { JobPublic } from '../types.js';
import { getStore } from './database.js';

export type JobHandler = (job: JobPublic) => Promise<unknown>;

export async function createJob(
  type: string,
  label: string,
  meta: Record<string, unknown> = {}
): Promise<JobPublic> {
  return (await getStore()).enqueue(type, label, meta);
}

export async function getJob(id: string): Promise<JobPublic | null> {
  return (await getStore()).get(id);
}

export async function updateJob(
  id: string,
  patch: { progress?: number; message?: string; meta?: Record<string, unknown> } = {}
): Promise<JobPublic | null> {
  return (await getStore()).update(id, patch);
}

export async function finishJob(id: string, result: Record<string, unknown> = {}): Promise<JobPublic | null> {
  return (await getStore()).finish(id, result);
}

export async function failJob(id: string, err: unknown): Promise<JobPublic | null> {
  return (await getStore()).fail(id, err);
}

export async function findActiveJob(
  type: string,
  projectId: string,
  clipId?: string
): Promise<JobPublic | null> {
  return (await getStore()).findActive(type, projectId, clipId);
}

// Poll-based subscription: emits the current snapshot immediately, then on
// every observed change. Works across processes.
export function subscribe(id: string, listener: (job: JobPublic) => void): () => void {
  let stopped = false;
  let lastUpdated = '';
  const check = async () => {
    if (stopped) return;
    try {
      const job = await getJob(id);
      if (!job || stopped) return;
      if (job.updatedAt !== lastUpdated) {
        lastUpdated = job.updatedAt;
        listener(job);
      }
    } catch {
      // transient store hiccup — keep polling
    }
  };
  void check();
  const timer = setInterval(check, 500);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export interface WorkerOptions {
  id?: string;
  handlers: Record<string, JobHandler>;
  concurrency?: number;
  pollMs?: number;
  leaseSec?: number;
  maxAttempts?: number;
  onClaim?: (job: JobPublic) => void;
}

export interface WorkerHandle {
  id: string;
  stop(): Promise<void>;
  stats(): { claimed: number; running: number };
}

function workerId(): string {
  return `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
}

export function startWorker(opts: WorkerOptions): WorkerHandle {
  const id = opts.id || workerId();
  const concurrency = Math.max(1, opts.concurrency || 1);
  const pollMs = opts.pollMs ?? 1000;
  const leaseSec = opts.leaseSec ?? 30;
  const maxAttempts = opts.maxAttempts ?? 3;
  let stopped = false;
  let claimed = 0;
  const inflight = new Set<Promise<unknown>>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const pump = async () => {
    if (stopped) return;
    try {
      const store = await getStore();
      while (!stopped && inflight.size < concurrency) {
        const job = await store.claimNext(id, leaseSec, maxAttempts);
        if (!job) break;
        claimed++;
        if (opts.onClaim) {
          try {
            opts.onClaim(job);
          } catch {
            // ignore listener errors
          }
        }
        const task = runClaimed(store, job, id, leaseSec, opts.handlers).finally(() => {
          inflight.delete(task);
        });
        inflight.add(task);
      }
    } catch {
      // store unavailable — back off and retry
    }
    if (!stopped) {
      timer = setTimeout(pump, pollMs);
      if (timer.unref) timer.unref();
    }
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    await Promise.allSettled([...inflight]);
  };

  void pump();
  return { id, stop, stats: () => ({ claimed, running: inflight.size }) };
}

async function runClaimed(
  store: Awaited<ReturnType<typeof getStore>>,
  job: JobPublic,
  owner: string,
  leaseSec: number,
  handlers: Record<string, JobHandler>
): Promise<void> {
  const heartbeat = setInterval(() => {
    store.renewLease(job.id, owner, leaseSec).catch(() => undefined);
  }, Math.max(1000, Math.floor((leaseSec * 1000) / 3)));
  if (heartbeat.unref) heartbeat.unref();
  try {
    // Duplicate guard: if an older active job already covers this work,
    // this claim is redundant — fail fast instead of double-processing.
    const meta = (job.meta || {}) as Record<string, unknown>;
    if (typeof meta.projectId === 'string' && (job.type === 'analyze' || job.type === 'export')) {
      const first = await store.findActive(
        job.type,
        meta.projectId,
        typeof meta.clipId === 'string' ? meta.clipId : undefined
      );
      if (first && first.id !== job.id) {
        await store.fail(job.id, `Superseded: ${job.type} already running as ${first.id}`);
        return;
      }
    }
    const handler = handlers[job.type];
    if (!handler) {
      await store.fail(job.id, `No worker handler for job type "${job.type}"`);
      return;
    }
    await handler(job);
  } catch (err) {
    try {
      await store.fail(job.id, err);
    } catch {
      // ignore
    }
  } finally {
    clearInterval(heartbeat);
  }
}
