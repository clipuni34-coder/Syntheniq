// Syntheniq — export a clip to a verified 9:16 MP4 and download it.
// Enqueues a render job (any worker picks it up); downloads stream from disk
// locally and redirect to presigned R2 URLs in production.
import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import * as db from '../lib/db.js';
import * as jobs from '../lib/jobs.js';
import { readAnalysis } from '../pipeline/index.js';
import * as p from '../lib/paths.js';
import { sendFileWithRange } from '../lib/static.js';
import { getStorage, isR2, keys } from '../storage/index.js';

export async function exportRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects/:id/clips/:clipId/export', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const project = await db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    const analysis = await readAnalysis(project.id);
    const clip = analysis.clips.find((c) => c.id === clipId);
    if (!clip) return reply.code(404).send({ error: 'Clip not found' });

    // Verified exports are reused instead of re-rendered.
    const existing = p.exportPath(project.id, clip.id);
    let haveFile = fs.existsSync(existing);
    if (!haveFile && clip.exported && isR2()) {
      try {
        await getStorage().fetch(keys.exportFile(project.id, clip.id), existing);
        haveFile = fs.existsSync(existing);
      } catch {
        haveFile = false;
      }
    }
    if (clip.exported && haveFile) {
      const job = await jobs.createJob('export', `Export ${clip.title}`, {
        projectId: project.id,
        clipId: clip.id,
      });
      await jobs.finishJob(job.id, {
        projectId: project.id,
        clipId: clip.id,
        reused: true,
        downloadUrl: `/v1/projects/${project.id}/clips/${clip.id}/file?download=1`,
        bytes: clip.exported.bytes,
        verification: clip.exported.verified,
      });
      reply.code(202);
      return { jobId: job.id, job: await jobs.getJob(job.id) };
    }

    // Idempotent while active: re-attach instead of double-rendering.
    const active = await jobs.findActiveJob('export', project.id, clip.id);
    if (active) {
      await db.updateProject(project.id, { activeJob: { id: active.id, type: 'export', clipId: clip.id } });
      reply.code(202);
      return { jobId: active.id, job: active };
    }
    if (project.activeJob?.type === 'export') {
      await db.updateProject(project.id, { activeJob: null });
    }

    const job = await jobs.createJob('export', `Export ${clip.title}`, {
      projectId: project.id,
      clipId: clip.id,
    });
    await db.updateProject(project.id, { activeJob: { id: job.id, type: 'export', clipId: clip.id } });
    reply.code(202);
    return { jobId: job.id, job };
  });

  app.get('/v1/projects/:id/clips/:clipId/file', async (req, reply) => {
    const { id, clipId } = req.params as { id: string; clipId: string };
    const project = await db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });
    if (!/^[A-Za-z0-9-]+$/.test(clipId || '')) return reply.code(400).send({ error: 'Bad clip id' });
    const query = req.query as { download?: unknown };
    const name = `${project.name.replace(/[^A-Za-z0-9-_]+/g, '-').slice(0, 60) || 'syntheniq'}-${clipId}.mp4`;
    if (isR2()) {
      const url = await getStorage().downloadUrl(keys.exportFile(project.id, clipId), {
        downloadName: query.download !== undefined ? name : undefined,
      });
      if (url) return reply.redirect(url);
    }
    const file = p.exportPath(project.id, clipId);
    if (!fs.existsSync(file)) {
      return reply.code(409).send({ error: 'This clip has not been exported yet' });
    }
    return sendFileWithRange(req, reply, file, {
      downloadName: query.download !== undefined ? name : undefined,
    });
  });
}
