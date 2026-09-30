// Syntheniq — file serving: range-capable media streaming (for <video>
// scrubbing) and plain static hosting for the built web app.
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const m = header.match(/bytes=(\d*)-(\d*)/);
  if (!m) return null;
  let start = m[1] === '' ? NaN : parseInt(m[1], 10);
  let end = m[2] === '' ? NaN : parseInt(m[2], 10);
  if (Number.isNaN(start) && Number.isNaN(end)) return null;
  if (Number.isNaN(start)) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (Number.isNaN(end)) {
    end = size - 1;
  }
  if (start >= size || end >= size || start > end) return null;
  return { start, end };
}

// Streams a media file with Range/206 support. Never throws for missing
// files — replies 404/410 style JSON via the caller's status code.
export async function sendFileWithRange(
  req: FastifyRequest,
  reply: FastifyReply,
  absPath: string,
  opts: { downloadName?: string; missingStatus?: number; missingMessage?: string } = {}
): Promise<void> {
  if (!fs.existsSync(absPath)) {
    reply.code(opts.missingStatus || 404).send({ error: opts.missingMessage || 'File not found' });
    return;
  }
  const stat = fs.statSync(absPath);
  const size = stat.size;
  const range = parseRange(req.headers.range, size);
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', contentTypeFor(absPath));
  if (opts.downloadName) {
    reply.header('Content-Disposition', `attachment; filename="${opts.downloadName}"`);
  }
  if (range) {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return reply.send(fs.createReadStream(absPath, { start: range.start, end: range.end }));
  }
  reply.header('Content-Length', size);
  return reply.send(fs.createReadStream(absPath));
}

// Serves a static directory (the exported Next.js app). Falls back to
// index.html for unknown paths so client-side routes resolve.
export function staticRoot(root: string) {
  const resolved = path.resolve(root);
  return async function handler(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const urlPath = (req.raw.url || '/').split('?')[0];
    let rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(path.join(resolved, rel));
    if (!file.startsWith(resolved + path.sep) && file !== resolved) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    try {
      const stat = fs.statSync(file);
      if (stat.isDirectory()) file = path.join(file, 'index.html');
    } catch {
      file = path.join(resolved, 'index.html');
    }
    if (!fs.existsSync(file)) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    reply.header('Content-Type', contentTypeFor(file));
    return reply.send(fs.createReadStream(file));
  };
}
