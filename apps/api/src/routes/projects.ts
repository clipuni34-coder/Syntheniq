// Syntheniq — project CRUD.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as db from '../lib/db.js';
import { projectDir } from '../lib/paths.js';

export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects', async (req) => {
    const body = (req.body || {}) as { name?: string };
    const project = await db.createProject(body.name || '');
    return project;
  });

  app.get('/v1/projects', async () => {
    return { projects: db.listProjects() };
  });

  app.get('/v1/projects/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    return project;
  });

  app.delete('/v1/projects/:id', async (req) => {
    const { id } = req.params as { id: string };
    await db.removeProject(id);
    try {
      fs.rmSync(projectDir(id), { recursive: true, force: true });
    } catch {
      // metadata is gone; leftover files are harmless
    }
    return { id };
  });
}
