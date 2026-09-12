// Syntheniq — video upload: validate, store, probe, mark uploaded.
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { MAX_UPLOAD_MB } from '../config.js';
import * as db from '../lib/db.js';
import { sourceDir, ensureDir } from '../lib/paths.js';
import { probeMedia } from '../pipeline/probe.js';

const ALLOWED_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi', '.mpg', '.mpeg']);

function safeId(id: string): string {
  if (!/^[A-Za-z0-9-]+$/.test(String(id || ''))) {
    throw Object.assign(new Error('Bad project id'), { statusCode: 400 });
  }
  return id;
}

export async function uploadRoutes(app: FastifyInstance): Promise<void> {
  app.post('/v1/projects/:id/upload', async (req, reply) => {
    const id = safeId((req.params as { id: string }).id);
    const project = db.getProject(id);
    if (!project) return reply.code(404).send({ error: 'Project not found' });

    let file;
    try {
      file = await req.file();
    } catch (err) {
      const msg = (err as Error).message || '';
      const tooBig = msg.includes('File too large') || (err as any)?.code === 'FST_REQ_FILE_TOO_LARGE';
      return reply
        .code(tooBig ? 413 : 400)
        .send({ error: tooBig ? `File exceeds the ${MAX_UPLOAD_MB} MB limit` : msg || 'Upload failed' });
    }
    if (!file) return reply.code(400).send({ error: 'No video file received (field name "video")' });

    const ext = path.extname(file.filename || '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      try {
        file.file.resume();
      } catch {
        // ignore
      }
      return reply.code(400).send({
        error: `Unsupported file type "${ext || '?'}". Upload a video file (${[...ALLOWED_EXT].join(', ')}).`,
      });
    }

    const dir = ensureDir(sourceDir(id));
    const filename = `original-${Date.now()}${ext}`;
    const dest = path.join(dir, filename);
    try {
      await pipeline(file.file, createWriteStream(dest));
    } catch (err) {
      try {
        fs.rmSync(dest, { force: true });
      } catch {
        // ignore
      }
      const tooBig = ((err as Error).message || '').includes('File too large');
      return reply
        .code(tooBig ? 413 : 400)
        .send({ error: tooBig ? `File exceeds the ${MAX_UPLOAD_MB} MB limit` : (err as Error).message });
    }

    // Keep a single current source per project.
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      if (full !== dest) fs.rmSync(full, { force: true });
    }

    let probe;
    try {
      probe = await probeMedia(dest);
    } catch (err) {
      fs.rmSync(dest, { force: true });
      return reply.code(422).send({ error: `Could not read that video file (${(err as Error).message})` });
    }
    if (!probe.hasVideo || !(probe.duration > 0)) {
      fs.rmSync(dest, { force: true });
      return reply.code(422).send({ error: 'That file has no readable video stream' });
    }

    const updated = await db.updateProject(id, {
      status: 'uploaded',
      notes: [],
      analysis: null,
      media: {
        filename,
        originalName: file.filename,
        bytes: fs.statSync(dest).size,
        mime: file.mimetype,
        probe,
        uploadedAt: new Date().toISOString(),
      },
    });
    reply.code(201);
    return updated;
  });
}
