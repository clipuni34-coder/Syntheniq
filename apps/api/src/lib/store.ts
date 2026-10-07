// Syntheniq — persistence interfaces.
//
// Two implementations exist:
//   - JsonStore  (development + tests): single JSON document, zero setup.
//   - PgStore    (production): Postgres; jobs survive restarts and any number
//                of workers can claim work atomically.
//
// Select with DATABASE_URL (set → Postgres, unset → JSON). Production boot
// refuses to start on the JSON store — see assertProductionStores().
import type { JobPublic, Project } from '../types.js';

export interface ProjectStore {
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(name: string): Promise<Project>;
  updateProject(id: string, patch: Partial<Project>): Promise<Project>;
  removeProject(id: string): Promise<{ id: string }>;
}

export interface JobClaim extends JobPublic {
  leaseOwner: string;
  attempts: number;
}

export interface JobStore {
  enqueue(type: string, label: string, meta?: Record<string, unknown>): Promise<JobPublic>;
  get(id: string): Promise<JobPublic | null>;
  update(id: string, patch: { progress?: number; message?: string; meta?: Record<string, unknown> }): Promise<JobPublic | null>;
  finish(id: string, result?: Record<string, unknown>): Promise<JobPublic | null>;
  fail(id: string, err: unknown): Promise<JobPublic | null>;
  /** Find a queued/running job for deduplication guards. */
  findActive(type: string, projectId: string, clipId?: string): Promise<JobPublic | null>;
  /**
   * Atomically claim the next queued job (or a running job whose lease
   * expired — i.e. a crashed worker's orphan). Returns null when there is
   * no claimable work. Race-safe across workers.
   */
  claimNext(owner: string, leaseSec: number, maxAttempts: number): Promise<JobClaim | null>;
  /** Extend the lease while a job is still being worked on. */
  renewLease(id: string, owner: string, leaseSec: number): Promise<boolean>;
}

export interface Store extends ProjectStore, JobStore {
  kind: 'json' | 'postgres';
  /** Create tables / files. Idempotent. */
  ensureReady(): Promise<void>;
  close(): Promise<void>;
}

export function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function isProduction(): boolean {
  return (process.env.NODE_ENV || '').toLowerCase() === 'production';
}

// Fail fast when production is misconfigured. Reads process.env at call
// time so it reflects the real runtime environment.
export function assertProductionStores(): void {
  if (!isProduction()) return;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'NODE_ENV=production requires DATABASE_URL (Postgres). The JSON store is development-only.'
    );
  }
  if ((process.env.STORAGE_DRIVER || 'local').toLowerCase() !== 'r2') {
    throw new Error(
      'NODE_ENV=production requires STORAGE_DRIVER=r2. Local storage is development-only.'
    );
  }
}
