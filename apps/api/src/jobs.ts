import path from 'node:path';
import { loadAiConfig } from './config.js';
import type { Analysis, ClipState, JobState, MediaInfo, Plan, StageName } from './pipeline/types.js';
import { runPipeline } from './pipeline/index.js';
import { loadJob, newJobState, projectDir, saveJob } from './store.js';

/**
 * In-process job runner (personal workstation: one pipeline at a time).
 * State is persisted to job.json after every mutation so status survives restarts.
 */
export class Job {
  state: JobState;
  cancelRequested = false;
  private saving: Promise<void> = Promise.resolve();

  constructor(state: JobState) {
    this.state = state;
  }

  private persist(): void {
    this.saving = this.saving.then(() => saveJob(this.state)).catch(() => {});
  }

  log(level: 'info' | 'warn' | 'error', msg: string): void {
    this.state.logs.push({ t: new Date().toISOString(), level, msg });
    if (this.state.logs.length > 400) this.state.logs = this.state.logs.slice(-400);
    // eslint-disable-next-line no-console
    console.log(`[${this.state.id.slice(0, 8)}] ${level}: ${msg}`);
    this.persist();
  }

  setStage(stage: StageName, detail?: string): void {
    this.state.stage = stage;
    if (this.state.stages[stage]) {
      this.state.stages[stage]!.status = 'running';
      if (detail) this.state.stages[stage]!.detail = detail;
    }
    this.persist();
  }

  finishStage(stage: StageName, detail?: string): void {
    if (this.state.stages[stage]) {
      this.state.stages[stage]!.status = 'done';
      this.state.stages[stage]!.progress = 1;
      if (detail) this.state.stages[stage]!.detail = detail;
    }
    this.persist();
  }

  stageProgress(fraction: number): void {
    // fraction is within the whole pipeline; map to overall progress
    this.state.progress = Math.min(0.999, Math.max(this.state.progress, fraction));
    if (this.state.stage && this.state.stages[this.state.stage]) {
      this.state.stages[this.state.stage]!.progress = Math.min(1, fraction * 1.6);
    }
    this.persist();
  }

  setMedia(m: MediaInfo): void {
    this.state.media = m;
    this.finishStage('media-check');
  }
  setTranscript(t: JobState['transcript']): void {
    this.state.transcript = t;
    this.finishStage('transcribe');
  }
  setAnalysis(a: Analysis): void {
    this.state.analysis = a;
    this.finishStage('analyze');
  }
  setPlan(p: Plan): void {
    this.state.plan = p;
    this.finishStage('plan');
  }
  setClips(clips: ClipState[]): void {
    this.state.clips = clips;
    this.persist();
  }
  setProviders(p: JobState['providers']): void {
    this.state.providers = p;
    this.persist();
  }

  done(msg: string): void {
    this.state.status = 'done';
    this.state.progress = 1;
    this.state.error = undefined; // a retried-to-success must not keep showing the old error
    for (const k of Object.keys(this.state.stages) as StageName[]) {
      this.state.stages[k] = { ...this.state.stages[k], status: 'done', progress: 1 };
    }
    if (this.state.stages['complete']) this.state.stages['complete'] = { status: 'done', progress: 1, detail: msg };
    this.log('info', `pipeline ${msg}`);
  }
  failed(msg: string): void {
    if (this.state.status === 'error') return; // idempotent
    this.state.status = 'error';
    this.state.error = msg;
    if (this.state.stage && this.state.stages[this.state.stage]) {
      this.state.stages[this.state.stage]!.status = 'error';
      this.state.stages[this.state.stage]!.detail = msg;
    }
    this.log('error', `pipeline failed: ${msg}`);
  }
  cancelled(msg: string): void {
    if (this.state.status === 'cancelling') this.state.status = 'cancelled';
    this.state.error = msg;
    this.log('warn', msg);
  }
}

const active = new Map<string, Job>();

export function getActiveJob(projectId: string): Job | undefined {
  return active.get(projectId);
}

export async function startPipeline(projectId: string): Promise<Job> {
  if (active.size >= 1) {
    // personal workstation: serialize. Mark queued; start when current finishes.
    let state = await loadJob(projectId);
    if (!state) {
      state = newJobState(projectId);
      await saveJob(state);
    }
    state.status = 'queued';
    await saveJob(state);
    queued.push(projectId);
    return new Job(state);
  }
  const job = await hydrateJob(projectId);
  active.set(projectId, job);
  runOne(projectId).catch((e) => job.failed((e as Error).message));
  return job;
}

const queued: string[] = [];

async function hydrateJob(projectId: string): Promise<Job> {
  let state = await loadJob(projectId);
  if (!state) {
    state = newJobState(projectId);
    await saveJob(state);
  }
  // Resume guard: a job left "running" by a crash can RESUME from the last
  // completed stage (intermediate artifacts are persisted on disk).
  if (state.status === 'running' || state.status === 'cancelling') {
    state.status = 'interrupted';
    state.error = 'interrupted by server restart — retry resumes from the last completed stage';
  }
  const job = new Job(state);
  job.state.status = 'running';
  await saveJob(job.state);
  return job;
}

async function runOne(projectId: string): Promise<void> {
  const job = active.get(projectId)!;
  try {
    await runPipeline(job, projectDir(projectId));
    if (job.state.status !== 'cancelled') job.done('complete');
  } catch (e) {
    const msg = (e as Error).message;
    if (job.state.status !== 'cancelled' && !msg.includes('cancelled')) job.failed(msg);
  } finally {
    active.delete(projectId);
    await saveJob(job.state).catch(() => {});
    const next = queued.shift();
    if (next) startPipeline(next).catch(() => {});
  }
}

export async function cancelPipeline(projectId: string): Promise<boolean> {
  const job = active.get(projectId);
  if (job) {
    job.cancelRequested = true;
    job.state.status = 'cancelling';
    await saveJob(job.state);
    return true;
  }
  return false;
}

export { loadAiConfig };
