// Syntheniq — video upload: validate, store, probe, mark uploaded.
// In R2 mode the bytes are mirrored to durable storage before the project
// is marked uploaded, so any worker can fetch them later.
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { MAX_UPLOAD_MB } from '../config.js';
import * as db from '../lib/db.js';
import { sourceDir, ensureDir } from '../lib/paths.js';
import { getStorage, isR2, keys } from '../storage/index.js';
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
    const project = await db.getProject(id);
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
    // Belt and suspenders: enforce the size cap on bytes actually received,
    // not just the multipart limit (truncated streams must 413, not 422).
    let received = 0;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        received += (chunk as Buffer).length;
        cb(null, chunk);
      },
    });
    try {
      await pipeline(file.file, counter, createWriteStream(dest));
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
    const truncated = (file.file as { truncated?: boolean }).truncated === true;
    if (truncated || received > MAX_UPLOAD_MB * 1024 * 1024) {
      fs.rmSync(dest, { force: true });
      return reply.code(413).send({ error: `File exceeds the ${MAX_UPLOAD_MB} MB limit` });
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

    let r2Key: string | undefined;
    if (isR2()) {
      try {
        r2Key = (await getStorage().mirror(dest, keys.source(id, filename))).key;
      } catch (err) {
        fs.rmSync(dest, { force: true });
        return reply.code(502).send({ error: `Durable storage unavailable: ${(err as Error).message}` });
      }
    }

    const updated = await db.updateProject(id, {
      status: 'uploaded',
      notes: [],
      analysis: null,
      media: {
        filename,
        r2Key,
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
