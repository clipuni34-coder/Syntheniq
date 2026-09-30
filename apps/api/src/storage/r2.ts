// Syntheniq — Cloudflare R2 storage provider (S3-compatible API).
// This is the PRODUCTION storage path: required when NODE_ENV=production.
//
// Design: workers keep local working copies for FFmpeg (fast, no streaming
// rewrites), while R2 holds every durable artifact — sources, transcripts,
// analyses, posters, exports. Downloads redirect to presigned URLs so media
// bytes never proxy through the API tier.
//
// A custom S3 client can be injected (tests, MinIO-style gateways); set
// S3_FORCE_PATH_STYLE=1 for path-style endpoints.
import fs from 'node:fs';
import path from 'node:path';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { R2, R2_PRESIGN_EXPIRES, S3_FORCE_PATH_STYLE } from '../config.js';
import { StorageError, type StorageProvider } from './index.js';

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ass': 'text/plain',
  '.wav': 'audio/wav',
};

export interface S3Like {
  send(cmd: unknown): Promise<unknown>;
}

function contentTypeFor(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

export function r2Configured(): { ok: boolean; missing: string[] } {
  const missing = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (k) => !process.env[k]
  );
  return { ok: missing.length === 0, missing };
}

export function createR2Storage(injected?: S3Like): StorageProvider & {
  deletePrefix(prefix: string): Promise<{ deleted: number }>;
} {
  const { ok, missing } = r2Configured();
  if (!ok) {
    throw new Error(
      `R2 storage is selected but missing configuration: ${missing.join(', ')}. ` +
        'Set them in the environment (see .env.example).'
    );
  }
  const { endpoint, accessKeyId, secretAccessKey, bucket } = R2;
  const client: S3Like =
    injected ||
    new S3Client({
      region: 'auto',
      endpoint,
      forcePathStyle: S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId, secretAccessKey },
    });

  const send = async (op: string, key: string, cmd: unknown): Promise<any> => {
    try {
      return await client.send(cmd);
    } catch (err) {
      throw new StorageError(op, key, (err as Error).message);
    }
  };

  return {
    kind: 'r2',

    async mirror(localPath: string, key: string) {
      if (!fs.existsSync(localPath)) {
        throw new StorageError('mirror', key, `local file missing: ${localPath}`);
      }
      const body = fs.readFileSync(localPath);
      await send(
        'mirror',
        key,
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(localPath),
        })
      );
      return { key };
    },

    async fetch(key: string, localPath: string) {
      const res = (await send('fetch', key, new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
        Body?: AsyncIterable<Uint8Array>;
      };
      if (!res || !res.Body) throw new StorageError('fetch', key, 'empty response body');
      // Stream to disk (exports can be hundreds of MB — never buffer).
      await new Promise<void>((resolve, reject) => {
        fs.mkdirSync(path.dirname(localPath), { recursive: true });
        const out = fs.createWriteStream(localPath);
        out.on('error', reject);
        out.on('finish', () => resolve());
        (async () => {
          try {
            for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
              if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()));
            }
            out.end();
          } catch (err) {
            out.destroy();
            reject(err);
          }
        })();
      }).catch((err) => {
        if (err instanceof StorageError) throw err;
        throw new StorageError('fetch', key, (err as Error).message);
      });
      return { key, localPath };
    },

    async downloadUrl(key: string, opts: { downloadName?: string } = {}) {
      const cmd = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        ...(opts.downloadName
          ? { ResponseContentDisposition: `attachment; filename="${opts.downloadName}"` }
          : {}),
      });
      try {
        return await getSignedUrl(client as S3Client, cmd, { expiresIn: R2_PRESIGN_EXPIRES });
      } catch (err) {
        throw new StorageError('presign', key, (err as Error).message);
      }
    },

    async deletePrefix(prefix: string) {
      let deleted = 0;
      let token: string | undefined;
      for (;;) {
        const listed = (await send(
          'deletePrefix',
          prefix,
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token })
        )) as { Contents?: { Key?: string }[]; NextContinuationToken?: string };
        const keys = (listed.Contents || []).map((c) => c.Key).filter(Boolean) as string[];
        if (keys.length) {
          await send(
            'deletePrefix',
            prefix,
            new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } })
          );
          deleted += keys.length;
        }
        token = listed.NextContinuationToken;
        if (!token) break;
      }
      return { deleted };
    },
  };
}
