import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });
await app.register(multipart, { limits: { fileSize: 512 * 1024 * 1024 } });

const DATA = path.resolve(process.env.SYNTHENIQ_DATA ?? './data');
await mkdir(DATA, { recursive: true });

app.get('/health', async () => ({ ok: true, name: 'Syntheniq API' }));

app.post('/v1/projects', async () => {
  const id = randomUUID();
  return { id, status: 'created' };
});

app.post('/v1/projects/:projectId/upload', async (req, reply) => {
  const file = await req.file();
  if (!file) return reply.code(400).send({ error: 'video file required' });
  const projectId = (req.params as { projectId: string }).projectId;
  const dir = path.join(DATA, projectId);
  await mkdir(dir, { recursive: true });
  const filename = `${randomUUID()}-${file.filename}`;
  const output = path.join(dir, filename);
  await pipeline(file.file, createWriteStream(output));
  return { projectId, filename, path: output, status: 'uploaded' };
});

app.post('/v1/projects/:projectId/analyze', async (req) => {
  const projectId = (req.params as { projectId: string }).projectId;
  return { projectId, status: 'queued', stages: ['media-check', 'transcription', 'story-analysis', 'clip-ranking'] };
});

app.listen({ port: Number(process.env.PORT ?? 8787), host: '0.0.0.0' });
