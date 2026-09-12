// Syntheniq — start an analysis job (202 + job id; progress via /v1/jobs).
import type { FastifyInstance } from 'fastify';
import * as db from '../lib/db.js';
import * as jobs from '../lib/jobs.js';
import { CLIPS_DEFAULT, CLIPS_MAX } from '../config.js';
import { runAnalysis } from '../pipeline/index.js';

export async function analyzeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects/:id/analyze', async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (!project.media) {
      return reply.code(409).send({ error: 'Upload a video before running analysis' });
    }
    // Idempotent while running: re-attach instead of double-analyzing.
    if (project.activeJob?.type === 'analyze') {
      const existing = jobs.getJob(project.activeJob.id);
      if (existing && existing.status === 'running') {
        reply.code(202);
        return { jobId: existing.id, job: existing };
      }
      await db.updateProject(project.id, { activeJob: null });
    }
    const body = (req.body || {}) as { maxClips?: number };
    const maxClips = Math.max(1, Math.min(CLIPS_MAX, parseInt(String(body.maxClips || CLIPS_DEFAULT), 10) || CLIPS_DEFAULT));
    const job = jobs.createJob('analyze', `Analyze ${project.name}`, { projectId: project.id });
    await db.updateProject(project.id, { activeJob: { id: job.id, type: 'analyze' } });
    setImmediate(() => runAnalysis(project.id, job.id, { maxClips }));
    reply.code(202);
    return { jobId: job.id, job };
  });
}
