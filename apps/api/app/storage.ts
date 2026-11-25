import { randomUUID } from 'node:crypto';
import { mkdir, open, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from './config.js';

export interface StorageAdapter {
  put(bytes: Uint8Array, contentType: string): Promise<string>;
  open(key: string): Promise<Readable>;
  remove(key: string): Promise<void>;
}

function validateKey(key: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(key)) throw new Error('Invalid storage key');
  return key;
}

export function createStorage(config: Config): StorageAdapter {
  if (config.STORAGE_DRIVER === 's3') {
    const client = new S3Client({});
    const Bucket = config.S3_BUCKET;
    return {
      async put(bytes, contentType) {
        const key = randomUUID();
        await client.send(new PutObjectCommand({ Bucket, Key: 'staged/' + key, Body: bytes, ContentType: contentType }));
        return key;
      },
      async open(key) {
        const result = await client.send(new GetObjectCommand({ Bucket, Key: 'staged/' + validateKey(key) }));
        if (!result.Body) throw new Error('Missing storage response body');
        return result.Body as Readable;
      },
      async remove(key) {
        await client.send(new DeleteObjectCommand({ Bucket, Key: 'staged/' + validateKey(key) }));
      },
    };
  }
  return {
    async put(bytes) {
      const key = randomUUID();
      await mkdir(config.UPLOAD_DIR, { recursive: true, mode: 0o700 });
      await writeFile(join(config.UPLOAD_DIR, key), bytes, { mode: 0o600, flag: 'wx' });
      return key;
    },
    async open(key) {
      const handle = await open(join(config.UPLOAD_DIR, validateKey(key)), 'r');
      return handle.createReadStream();
    },
    async remove(key) {
      await rm(join(config.UPLOAD_DIR, validateKey(key)), { force: true });
    },
  };
}
