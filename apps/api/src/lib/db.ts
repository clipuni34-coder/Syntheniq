// Syntheniq — project metadata store (JSON document, atomic writes).
// The exported interface is the seam where Postgres/Supabase/D1 can later
// be swapped in without touching routes or the pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import type { Project } from '../types.js';

const DB_PATH = path.join(DATA_DIR, 'db.json');
let cache: { projects: Record<string, Project> } | null = null;
let chain: Promise<unknown> = Promise.resolve();

function load(): { projects: Record<string, Project> } {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    cache = { projects: {} };
  }
  if (!cache || typeof cache !== 'object') cache = { projects: {} };
  if (!cache.projects || typeof cache.projects !== 'object') cache.projects = {};
  return cache;
}

function persist(): void {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

function mutate<T>(fn: (db: { projects: Record<string, Project> }) => T): Promise<T> {
  const run = chain.then(() => {
    const out = fn(load());
    persist();
    return clone(out);
  });
  chain = run.then(
    () => undefined,
    () => undefined
  );
  return run as Promise<T>;
}

function newId(prefix: string): string {
  return prefix + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

export function listProjects(): Project[] {
  const db = load();
  return Object.values(db.projects)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))
    .map(clone);
}

export function getProject(id: string): Project | null {
  return clone(load().projects[id] || null);
}

export function createProject(name: string): Promise<Project> {
  return mutate((db) => {
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
    db.projects[project.id] = project;
    return project;
  });
}

export function updateProject(id: string, patch: Partial<Project>): Promise<Project> {
  return mutate((db) => {
    const existing = db.projects[id];
    if (!existing) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    const updated: Project = {
      ...existing,
      ...patch,
      id: existing.id,
      updatedAt: new Date().toISOString(),
    };
    db.projects[id] = updated;
    return updated;
  });
}

export function removeProject(id: string): Promise<{ id: string }> {
  return mutate((db) => {
    const existing = db.projects[id];
    if (!existing) throw Object.assign(new Error('Project not found'), { statusCode: 404 });
    delete db.projects[id];
    return { id };
  });
}
