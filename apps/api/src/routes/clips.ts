// Syntheniq — clips, transcript and media streaming for a project.
import fs from 'node:fs';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as db from '../lib/db.js';
import { readAnalysis } from '../pipeline/index.js';
import * as p from '../lib/paths.js';
import { sendFileWithRange } from '../lib/static.js';
import type { EnergyPoint, Project } from '../types.js';

function projectOrNull(req: FastifyRequest, reply: FastifyReply): Project | null {
  const { id } = req.params as { id: string };
  const project = db.getProject(id);
  if (!project) {
    reply.code(404).send({ error: 'Project not found' });
    return null;
  }
  return project;
}

function downsample(curve: EnergyPoint[], max: number): EnergyPoint[] {
  if (!Array.isArray(curve) || curve.length <= max) return curve;
  const out: EnergyPoint[] = [];
  const factor = curve.length / max;
  for (let i = 0; i < max; i++) {
    const from = Math.floor(i * factor);
    const to = Math.min(curve.length, Math.floor((i + 1) * factor));
    let sum = 0;
    for (let j = from; j < to; j++) sum += curve[j].rms || 0;
    out.push({ t: curve[from].t, rms: Math.round((sum / Math.max(1, to - from)) * 1000) / 1000 });
  }
  return out;
}

export async function clipRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/projects/:id/clips', async (req, reply) => {
    const project = projectOrNull(req, reply);
    if (!project) return;
    const analysis = readAnalysis(project.id);
    return {
      projectId: project.id,
      provider: analysis.provider,
      language: analysis.language,
      coverage: analysis.coverage,
      stats: analysis.stats,
      notes: analysis.notes,
      clips: analysis.clips,
      timeline: {
        duration: project.media && project.media.probe ? project.media.probe.duration : 0,
        waveform: downsample((analysis.structure && analysis.structure.energyCurve) || [], 220),
        sceneCuts: ((analysis.structure && analysis.structure.sceneCuts) || []).slice(0, 500),
      },
    };
  });

  app.get('/v1/projects/:id/clips/:clipId', async (req, reply) => {
    const project = projectOrNull(req, reply);
    if (!project) return;
    const { clipId } = req.params as { clipId: string };
    const analysis = readAnalysis(project.id);
    const clip = analysis.clips.find((c) => c.id === clipId);
    if (!clip) return reply.code(404).send({ error: 'Clip not found' });
    const transcript = (analysis.transcript || []).filter((s) => s.end > clip.start && s.start < clip.end);
    return { projectId: project.id, clip, transcript };
  });

  app.get('/v1/projects/:id/transcript', async (req, reply) => {
    const project = projectOrNull(req, reply);
    if (!project) return;
    const analysis = readAnalysis(project.id);
    return {
      projectId: project.id,
      provider: analysis.provider,
      language: analysis.language,
      coverage: analysis.coverage,
      segments: analysis.transcript || [],
    };
  });

  app.get('/v1/projects/:id/source', async (req, reply) => {
    const project = projectOrNull(req, reply);
    if (!project) return;
    if (!project.media) return reply.code(409).send({ error: 'No video uploaded yet' });
    const file = p.sourceFile(project.id, project.media.filename);
    if (!fs.existsSync(file)) return reply.code(410).send({ error: 'Source file no longer on disk' });
    return sendFileWithRange(req, reply, file);
  });

  app.get('/v1/projects/:id/poster/:clipId', async (req, reply) => {
    const project = projectOrNull(req, reply);
    if (!project) return;
    const { clipId } = req.params as { clipId: string };
    if (!/^[A-Za-z0-9-]+$/.test(clipId || '')) return reply.code(400).send({ error: 'Bad clip id' });
    const file = p.posterPath(project.id, clipId);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Poster not found' });
    return sendFileWithRange(req, reply, file);
  });
}
