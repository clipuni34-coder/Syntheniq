// Syntheniq — export a clip to a verified 9:16 MP4 and download it.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as db from '../lib/db.js';
import * as jobs from '../lib/jobs.js';
import { runExport, readAnalysis } from '../pipeline/index.js';
import * as p from '../lib/paths.js';
import { sendFileWithRange } from '../lib/static.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects/:id/clips/:clipId/export', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const analysis = readAnalysis(project.id);
    const clip = analysis.clips.find((c) => c.id === clipId);
    if (!clip) return reply.code(404).send({ error: 'Clip not found' });

    const existing = p.exportPath(project.id, clip.id);
    if (clip.exported && fs.existsSync(existing)) {
      const job = jobs.createJob('export', `Export ${clip.title}`, {
        projectId: project.id,
        clipId: clip.id,
      });
      jobs.finishJob(job.id, {
        projectId: project.id,
        clipId: clip.id,
        reused: true,
        downloadUrl: `/v1/projects/${project.id}/clips/${clip.id}/file?download=1`,
        bytes: clip.exported.bytes,
        verification: clip.exported.verified,
      });
      reply.code(202);
      return { jobId: job.id, job: jobs.getJob(job.id) };
    }

    // Idempotent while running: re-attach instead of double-rendering.
    if (project.activeJob?.type === 'export' && project.activeJob.clipId === clip.id) {
      const running = jobs.getJob(project.activeJob.id);
      if (running && running.status === 'running') {
        reply.code(202);
        return { jobId: running.id, job: running };
      }
      await db.updateProject(project.id, { activeJob: null });
    }

    const job = jobs.createJob('export', `Export ${clip.title}`, {
      projectId: project.id,
      clipId: clip.id,
    });
    await db.updateProject(project.id, { activeJob: { id: job.id, type: 'export', clipId: clip.id } });
    setImmediate(() => runExport(project.id, clip.id, job.id));
    reply.code(202);
    return { jobId: job.id, job };
  });

  app.get('/v1/projects/:id/clips/:clipId/file', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (!/^[A-Za-z0-9-]+$/.test(clipId || '')) return reply.code(400).send({ error: 'Bad clip id' });
    const file = p.exportPath(project.id, clipId);
    if (!fs.existsSync(file)) {
      return reply.code(409).send({ error: 'This clip has not been exported yet' });
    }
    const query = req.query as { download?: unknown };
    const name = `${project.name.replace(/[^A-Za-z0-9-_]+/g, '-').slice(0, 60) || 'syntheniq'}-${clipId}.mp4`;
    return sendFileWithRange(req, reply, file, {
      downloadName: query.download !== undefined ? name : undefined,
    });
  });
}
