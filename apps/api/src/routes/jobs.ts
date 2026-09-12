// Syntheniq — job status: polling (GET /v1/jobs/:id) and live SSE
// (GET /v1/jobs/:id/events).
import type { FastifyInstance } from 'fastify';
import * as jobs from '../lib/jobs.js';

export async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.getJob(id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });
    return job;
  });

  app.get('/v1/jobs/:id/events', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.getJob(id);
    if (!job) return reply.code(404).send({ error: 'Job not found' });

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    raw.write(': connected\n\n');

    let closed = false;
    const send = (snapshot: unknown) => {
      if (closed) return;
      try {
        raw.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      } catch {
        // ignore
      }
      const status = (snapshot as { status?: string }).status;
      if (status === 'done' || status === 'error') {
        setTimeout(() => {
          try {
            raw.end();
          } catch {
            // ignore
          }
        }, 300);
      }
    };

    const unsubscribe = jobs.subscribe(id, send);
    const heartbeat = setInterval(() => {
      if (!closed) {
        try {
          raw.write(': ping\n\n');
        } catch {
          // ignore
        }
      }
    }, 20000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (unsubscribe) unsubscribe();
    };
    req.raw.on('close', cleanup);
  });
}
