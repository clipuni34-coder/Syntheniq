// Syntheniq — Cloudflare R2 storage provider (S3-compatible).
//
// INTEGRATION POINT: activates only when STORAGE_DRIVER=r2, the R2_*
// secrets are set, and the optional @aws-sdk/client-s3 is installed.
import fs from 'node:fs';
import { R2 } from '../config.js';
import type { StorageProvider } from './index.js';

async function requireSdk(): Promise<any> {
  try {
    // Non-literal specifier on purpose: the package is optional, so the
    // TypeScript build must not try to resolve it.
    const pkg: string = '@aws-sdk/client-s3';
    return await import(pkg);
  } catch {
    throw new Error(
      'R2 storage needs the optional dependency @aws-sdk/client-s3. ' +
        'Install it with: npm install @aws-sdk/client-s3 --workspace @syntheniq/api'
    );
  }
}

export async function createR2Storage(): Promise<StorageProvider> {
  const { endpoint, accessKeyId, secretAccessKey, bucket } = R2;
  const missing = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'].filter(
    (k) => !process.env[k]
  );
  if (missing.length > 0) {
    throw new Error(
      `R2 storage is selected but missing configuration: ${missing.join(', ')}. ` +
        'Set them in the environment (see .env.example) or use STORAGE_DRIVER=local.'
    );
  }
  const { S3Client, PutObjectCommand, GetObjectCommand } = await requireSdk();
  const client = new S3Client({
    region: 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    kind: 'r2',
    async mirror(localPath: string, key: string) {
      const body = fs.readFileSync(localPath);
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body }));
      return { kind: 'r2', key };
    },
    async fetch(key: string, localPath: string) {
      const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      fs.writeFileSync(localPath, Buffer.concat(chunks));
      return { kind: 'r2', key, localPath };
    },
  };
}
