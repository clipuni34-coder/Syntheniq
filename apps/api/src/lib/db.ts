// Syntheniq — project metadata access. Delegates to the configured store
// (Postgres in production, JSON document in development). All async.
import type { Project } from '../types.js';
import { getStore } from './database.js';

export async function listProjects(): Promise<Project[]> {
  return (await getStore()).listProjects();
}

export async function getProject(id: string): Promise<Project | null> {
  return (await getStore()).getProject(id);
}

export async function createProject(name: string): Promise<Project> {
  return (await getStore()).createProject(name);
}

export async function updateProject(id: string, patch: Partial<Project>): Promise<Project> {
  return (await getStore()).updateProject(id, patch);
}

export async function removeProject(id: string): Promise<{ id: string }> {
  return (await getStore()).removeProject(id);
}
