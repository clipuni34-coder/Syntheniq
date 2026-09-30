// Syntheniq — PgStore: Postgres persistence for production.
// Jobs survive process restarts; any number of workers claim work through
// one atomic UPDATE … FOR UPDATE SKIP LOCKED statement, so a job can never
// be double-claimed even when workers race.
//
// The `pg` Pool is injectable (queryFn) so the SQL layer is unit-testable
// without a live database; integration tests run against real Postgres.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { JobPublic, Project } from '../types.js';
import type { JobClaim, Store } from './store.js';
import { newId } from './store.js';

export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

interface JobRow {
  id: string;
  type: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'error';
  progress: number;
  message: string;
  result: Record<string, unknown> | null;
  error: string | null;
  meta: Record<string, unknown>;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

const JOB_COLS =
  'id, type, label, status, progress, message, result, error, meta, attempts, ' +
  'lease_owner, lease_expires_at, created_at, updated_at';

function rowToPublic(row: JobRow): JobPublic {
  return {
    id: row.id,
    type: row.type,
    label: row.label,
    status: row.status,
    progress: Number(row.progress) || 0,
    message: row.message || '',
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    result: (row.result as Record<string, unknown>) || null,
    error: row.error || null,
    meta: (row.meta as Record<string, unknown>) || {},
  };
}

function schemaSql(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const direct = path.join(here, 'schema.sql');
  if (fs.existsSync(direct)) return fs.readFileSync(direct, 'utf8');
  // Fallback for unusual layouts: walk up to the package root.
  return fs.readFileSync(path.join(here, '..', '..', 'src', 'lib', 'schema.sql'), 'utf8');
}

export class PgStore implements Store {
  readonly kind = 'postgres' as const;
  private db: Queryable;
  private owned: { end(): Promise<unknown> } | null;

  constructor(db: Queryable, owned: { end(): Promise<unknown> } | null = null) {
    this.db = db;
    this.owned = owned;
  }

  static async connect(connectionString: string): Promise<PgStore> {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString, max: 10 });
    const store = new PgStore(
      {
        query: (text: string, params?: unknown[]) => pool.query(text, params as unknown[]),
      },
      pool
    );
    await store.ensureReady();
    return store;
  }

  async ensureReady(): Promise<void> {
    await this.db.query(schemaSql());
  }

  async close(): Promise<void> {
    if (this.owned) await this.owned.end();
  }

  // -- projects -----------------------------------------------------------
  async listProjects(): Promise<Project[]> {
    const { rows } = await this.db.query('SELECT data FROM projects ORDER BY data->>\'updatedAt\' DESC');
    return rows.map((r) => r.data as Project);
  }

  async getProject(id: string): Promise<Project | null> {
    const { rows } = await this.db.query('SELECT data FROM projects WHERE id = $1', [id]);
    return rows.length ? (rows[0].data as Project) : null;
  }

  async createProject(name: string): Promise<Project> {
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
    await this.db.query('INSERT INTO projects (id, data, updated_at) VALUES ($1, $2, now())', [
      project.id,
      JSON.stringify(project),
    ]);
    return project;
  }

  async updateProject(id: string, patch: Partial<Project>): Promise<Project> {
    const existing = await this.getProject(id);
    if (!existing) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const updated: Project = { ...existing, ...patch, id: existing.id, updatedAt: new Date().toISOString() };
    const { rows } = await this.db.query(
      'UPDATE projects SET data = $2, updated_at = now() WHERE id = $1 RETURNING data',
      [id, JSON.stringify(updated)]
    );
    if (!rows.length) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return rows[0].data as Project;
  }

  async removeProject(id: string): Promise<{ id: string }> {
    const { rows } = await this.db.query('DELETE FROM projects WHERE id = $1 RETURNING id', [id]);
    if (!rows.length) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    return { id };
  }

  // -- jobs ---------------------------------------------------------------
  async enqueue(type: string, label: string, meta: Record<string, unknown> = {}): Promise<JobPublic> {
    const id = newId('job-');
    const { rows } = await this.db.query(
      `INSERT INTO jobs (id, type, label, status, message, meta) VALUES ($1, $2, $3, 'queued', 'Queued…', $4) RETURNING ${JOB_COLS}`,
      [id, type, label, JSON.stringify(meta)]
    );
    return rowToPublic(rows[0] as unknown as JobRow);
  }

  async get(id: string): Promise<JobPublic | null> {
    const { rows } = await this.db.query(`SELECT ${JOB_COLS} FROM jobs WHERE id = $1`, [id]);
    return rows.length ? rowToPublic(rows[0] as unknown as JobRow) : null;
  }

  async update(
    id: string,
    patch: { progress?: number; message?: string; meta?: Record<string, unknown> }
  ): Promise<JobPublic | null> {
    const sets: string[] = ['updated_at = now()'];
    const params: unknown[] = [id];
    if (typeof patch.progress === 'number') {
      params.push(Math.max(0, Math.min(100, patch.progress)));
      sets.push(`progress = $${params.length}`);
    }
    if (typeof patch.message === 'string') {
      params.push(patch.message);
      sets.push(`message = $${params.length}`);
    }
    if (patch.meta && typeof patch.meta === 'object') {
      params.push(JSON.stringify(patch.meta));
      sets.push(`meta = meta || $${params.length}::jsonb`);
    }
    const { rows } = await this.db.query(
      `UPDATE jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING ${JOB_COLS}`,
      params
    );
    return rows.length ? rowToPublic(rows[0] as unknown as JobRow) : null;
  }

  async finish(id: string, result: Record<string, unknown> = {}): Promise<JobPublic | null> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'done', progress = 100, result = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${JOB_COLS}`,
      [id, JSON.stringify(result || {})]
    );
    return rows.length ? rowToPublic(rows[0] as unknown as JobRow) : null;
  }

  async fail(id: string, err: unknown): Promise<JobPublic | null> {
    const message = err instanceof Error ? err.message : String(err);
    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'error', error = $2, message = $2, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1 RETURNING ${JOB_COLS}`,
      [id, message]
    );
    return rows.length ? rowToPublic(rows[0] as unknown as JobRow) : null;
  }

  async findActive(type: string, projectId: string, clipId?: string): Promise<JobPublic | null> {
    const params: unknown[] = [type, projectId];
    let extra = '';
    if (clipId !== undefined) {
      params.push(clipId);
      extra = ` AND meta->>'clipId' = $${params.length}`;
    }
    const { rows } = await this.db.query(
      `SELECT ${JOB_COLS} FROM jobs WHERE type = $1 AND status IN ('queued','running') AND meta->>'projectId' = $2${extra} ORDER BY created_at ASC LIMIT 1`,
      params
    );
    return rows.length ? rowToPublic(rows[0] as unknown as JobRow) : null;
  }

  async claimNext(owner: string, leaseSec: number, maxAttempts: number): Promise<JobClaim | null> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_owner = $1,
         lease_expires_at = now() + make_interval(secs => $2), updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE status = 'queued'
            OR (status = 'running' AND lease_expires_at < now() AND attempts < $3)
         ORDER BY created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
       )
       RETURNING ${JOB_COLS}`,
      [owner, leaseSec, maxAttempts]
    );
    if (!rows.length) return null;
    const row = rows[0] as unknown as JobRow;
    return { ...rowToPublic(row), leaseOwner: owner, attempts: row.attempts };
  }

  async renewLease(id: string, owner: string, leaseSec: number): Promise<boolean> {
    const { rows } = await this.db.query(
      `UPDATE jobs SET lease_expires_at = now() + make_interval(secs => $3)
       WHERE id = $1 AND status = 'running' AND lease_owner = $2 RETURNING id`,
      [id, owner, leaseSec]
    );
    return rows.length > 0;
  }
}
