// Syntheniq — JsonStore: file-backed persistence for development + tests.
// Zero setup, single process. Jobs are persisted too, so a dev restart can
// resume the queue. NOT for production (see assertProductionStores()).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import type { JobPublic, Project } from '../types.js';
import type { JobClaim, Store } from './store.js';
import { newId } from './store.js';

interface JobRow extends JobPublic {
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
}

interface Doc {
  projects: Record<string, Project>;
  jobs: Record<string, JobRow>;
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function rowToPublic(row: JobRow): JobPublic {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    progress: row.progress,
    message: row.message,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    result: row.result,
    error: row.error,
    meta: row.meta,
  };
}

export class JsonStore implements Store {
  readonly kind = 'json' as const;
  private file: string;
  private cache: Doc | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(file?: string) {
    this.file = file || path.join(DATA_DIR, 'db.json');
  }

  async ensureReady(): Promise<void> {
    this.load();
  }

  async close(): Promise<void> {
    await this.chain;
  }

  private load(): Doc {
    if (this.cache) return this.cache;
    try {
      this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      this.cache = { projects: {}, jobs: {} };
    }
    if (!this.cache || typeof this.cache !== 'object') this.cache = { projects: {}, jobs: {} };
    if (!this.cache.projects || typeof this.cache.projects !== 'object') this.cache.projects = {};
    if (!this.cache.jobs || typeof this.cache.jobs !== 'object') this.cache.jobs = {};
    return this.cache;
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.cache, null, 2));
    fs.renameSync(tmp, this.file);
  }

  private mutate<T>(fn: (doc: Doc) => T): Promise<T> {
    const run = this.chain.then(() => {
      const out = fn(this.load());
      this.persist();
      return clone(out);
    });
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<T>;
  }

  // -- projects -----------------------------------------------------------
  async listProjects(): Promise<Project[]> {
    return Object.values(this.load().projects)
      .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
      .map(clone);
  }

  async getProject(id: string): Promise<Project | null> {
    return clone(this.load().projects[id] || null);
  }

  async createProject(name: string): Promise<Project> {
    return this.mutate((doc) => {
      const now = new Date().toISOString();
      const project: Project = {
        id: newId('proj-'),
        name: String(name || 'Untitled project').slice(0, 120) || 'Untitled project',
        status: 'created',
        createdAt: now,
        updatedAt: now,
        media: null,
        analysis: null,
        notes: [],
      };
      doc.projects[project.id] = project;
      return project;
    });
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    return this.mutate((doc) => {
      const existing = doc.projects[id];
      if (!existing) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      const updated: Project = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
      doc.projects[id] = updated;
      return updated;
    });
  }

  async removeProject(id: string): Promise<{ id: string }> {
    return this.mutate((doc) => {
      if (!doc.projects[id]) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
      delete doc.projects[id];
      return { id };
    });
  }

  // -- jobs ---------------------------------------------------------------
  async enqueue(type: string, label: string, meta: Record<string, unknown> = {}): Promise<JobPublic> {
    return this.mutate((doc) => {
      const now = new Date().toISOString();
      const row: JobRow = {
        id: newId('job-'),
        type,
        label,
        status: 'queued',
        progress: 0,
        message: 'Queued…',
        createdAt: now,
        updatedAt: now,
        result: null,
        error: null,
        meta: clone(meta),
        leaseOwner: null,
        leaseExpiresAt: null,
        attempts: 0,
      };
      doc.jobs[row.id] = row;
      return rowToPublic(row);
    });
  }

  async get(id: string): Promise<JobPublic | null> {
    const row = this.load().jobs[id];
    return row ? rowToPublic(clone(row)) : null;
  }

  async update(
    id: string,
    patch: { progress?: number; message?: string; meta?: Record<string, unknown> }
  ): Promise<JobPublic | null> {
    return this.mutate((doc) => {
      const row = doc.jobs[id];
      if (!row) return null;
      if (typeof patch.progress === 'number') row.progress = Math.max(0, Math.min(100, patch.progress));
      if (typeof patch.message === 'string') row.message = patch.message;
      if (patch.meta && typeof patch.meta === 'object') row.meta = { ...row.meta, ...patch.meta };
      row.updatedAt = new Date().toISOString();
      return rowToPublic(row);
    });
  }

  async finish(id: string, result: Record<string, unknown> = {}): Promise<JobPublic | null> {
    return this.mutate((doc) => {
      const row = doc.jobs[id];
      if (!row) return null;
      row.status = 'done';
      row.progress = 100;
      row.result = clone(result) || {};
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      row.updatedAt = new Date().toISOString();
      return rowToPublic(row);
    });
  }

  async fail(id: string, err: unknown): Promise<JobPublic | null> {
    return this.mutate((doc) => {
      const row = doc.jobs[id];
      if (!row) return null;
      row.status = 'error';
      row.error = err instanceof Error ? err.message : String(err);
      row.message = row.error;
      row.leaseOwner = null;
      row.leaseExpiresAt = null;
      row.updatedAt = new Date().toISOString();
      return rowToPublic(row);
    });
  }

  async findActive(type: string, projectId: string, clipId?: string): Promise<JobPublic | null> {
    const rows = Object.values(this.load().jobs)
      .filter((j) => j.type === type && (j.status === 'queued' || j.status === 'running'))
      .filter((j) => (j.meta as Record<string, unknown>).projectId === projectId)
      .filter((j) => (clipId === undefined ? true : (j.meta as Record<string, unknown>).clipId === clipId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return rows.length ? rowToPublic(clone(rows[0])) : null;
  }

  async claimNext(owner: string, leaseSec: number, maxAttempts: number): Promise<JobClaim | null> {
    return this.mutate((doc) => {
      const now = Date.now();
      const rows = Object.values(doc.jobs)
        .filter((j) => {
          if (j.status === 'queued') return true;
          if (j.status === 'running' && j.attempts < maxAttempts) {
            const exp = j.leaseExpiresAt ? Date.parse(j.leaseExpiresAt) : 0;
            return exp < now;
          }
          return false;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const row = rows[0];
      if (!row) return null;
      row.status = 'running';
      row.attempts += 1;
      row.leaseOwner = owner;
      row.leaseExpiresAt = new Date(now + leaseSec * 1000).toISOString();
      row.updatedAt = new Date().toISOString();
      return { ...rowToPublic(row), leaseOwner: owner, attempts: row.attempts };
    });
  }

  async renewLease(id: string, owner: string, leaseSec: number): Promise<boolean> {
    return this.mutate((doc) => {
      const row = doc.jobs[id];
      if (!row || row.status !== 'running' || row.leaseOwner !== owner) return false;
      row.leaseExpiresAt = new Date(Date.now() + leaseSec * 1000).toISOString();
      return true;
    });
  }
}
