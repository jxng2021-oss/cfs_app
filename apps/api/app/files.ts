import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireRole, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import { inspectUpload, mib } from './file-validation.js';
import { ApiError, data, id, notFound, read } from './http.js';
import { lockActor, scopedModule } from './modules.js';
import { reconcileExpired } from './quiz-engine.js';
import { denyLocked, releaseRequirements, topicLocked } from './release-store.js';
import type { StorageAdapter } from './storage.js';

const purposes = z.enum(['MATERIAL', 'SUBMISSION']);
type Purpose = z.infer<typeof purposes>;
export type FileRow = {
  id: string;
  owner_id: string;
  purpose: Purpose;
  storage_key: string;
  original_filename: string;
  extension: string;
  detected_content_type: string;
  size_bytes: number;
  status: 'STAGED' | 'ATTACHED' | 'DELETING';
  expires_at: Date | null;
};
type Binding = {
  module_id: string;
  student_id: string | null;
  topic_id: string | null;
  topic_status: string | null;
  material_status: string | null;
};
const multipart = multer({
  limits: { fileSize: 25 * mib + 1, files: 1, fields: 1, parts: 2, fieldSize: 32 },
  defParamCharset: 'utf8',
}).single('file');

export function fileDto(file: Pick<FileRow, 'id' | 'original_filename' | 'size_bytes'>) {
  return {
    id: file.id,
    originalFilename: file.original_filename,
    sizeBytes: file.size_bytes,
    downloadUrl: '/api/v1/files/' + file.id + '/download',
  };
}

export async function attachFile(
  db: Db,
  fileId: string,
  ownerId: string,
  purpose: Purpose,
  now: Date,
  limits?: { allowedExtensions: string[]; maxFileMiB: number },
) {
  const file = (await db.query<FileRow>('SELECT * FROM files WHERE id=$1 FOR UPDATE', [fileId])).rows[0];
  if (!file || file.owner_id !== ownerId || file.purpose !== purpose) notFound();
  if (file.status === 'ATTACHED')
    throw new ApiError(409, 'FILE_ALREADY_ATTACHED', 'This upload has already been attached.');
  if (file.status !== 'STAGED' || !file.expires_at || file.expires_at <= now)
    throw new ApiError(409, 'FILE_EXPIRED', 'Upload the file again because this staged upload has expired.');
  if (limits && !limits.allowedExtensions.includes(file.extension))
    throw new ApiError(415, 'UNSUPPORTED_FILE_TYPE', 'This assessment does not allow the file’s format.');
  if (limits && file.size_bytes > limits.maxFileMiB * mib)
    throw new ApiError(413, 'FILE_TOO_LARGE', 'The file exceeds this assessment’s size limit.');
  await db.query("UPDATE files SET status='ATTACHED',expires_at=NULL,attached_at=$2 WHERE id=$1", [file.id, now]);
  return file;
}

export async function discardMaterialFile(db: Db, fileId: string | null) {
  if (!fileId) return;
  await db.query(
    "UPDATE files f SET status='DELETING' WHERE f.id=$1 AND f.purpose='MATERIAL' AND NOT EXISTS (SELECT 1 FROM materials m WHERE m.file_id=f.id)",
    [fileId],
  );
}

async function discardClaimed(db: Db, storage: StorageAdapter, file: FileRow) {
  await storage.remove(file.storage_key);
  await db.query("DELETE FROM files WHERE id=$1 AND status='DELETING'", [file.id]);
}

export async function cleanupUploads(services: Services, storage: StorageAdapter) {
  const lease = await services.pool.connect();
  try {
    const {
      rows: [{ acquired }],
    } = await lease.query<{ acquired: boolean }>('SELECT pg_try_advisory_lock(81290103) AS acquired');
    if (!acquired) return { removed: 0, pending: 0 };
    try {
      const now = await services.clock(lease);
      const { rows } = await lease.query<FileRow>(
        `UPDATE files SET status='DELETING' WHERE id IN (
           SELECT id FROM files WHERE status='DELETING' OR (status='STAGED' AND expires_at <= $1)
           ORDER BY created_at,id LIMIT 100 FOR UPDATE SKIP LOCKED
         ) RETURNING *`,
        [now],
      );
      let removed = 0;
      for (const file of rows) {
        try {
          await discardClaimed(lease, storage, file);
          removed++;
        } catch {
          console.error(JSON.stringify({ event: 'staged_upload_cleanup_deferred' }));
        }
      }
      return { removed, pending: rows.length - removed };
    } finally {
      await lease.query('SELECT pg_advisory_unlock(81290103)');
    }
  } finally {
    lease.release();
  }
}

async function binding(db: Db, fileId: string) {
  const { rows } = await db.query<Binding>(
    `SELECT t.module_id,NULL::uuid AS student_id,t.id AS topic_id,t.status AS topic_status,m.status AS material_status
       FROM materials m JOIN topics t ON t.id=m.topic_id WHERE m.file_id=$1
     UNION ALL
     SELECT a.module_id,s.student_id,a.topic_id,t.status,NULL FROM assignment_submissions s
       JOIN assessments a ON a.id=s.assessment_id LEFT JOIN topics t ON t.id=a.topic_id WHERE s.file_id=$1`,
    [fileId],
  );
  return rows[0];
}

export function fileRoutes(services: Services, storage: StorageAdapter) {
  const router = Router();
  const allowed = requireRole('LECTURER', 'STUDENT');
  const { pool, clock } = services;

  router.post(
    '/files/stage',
    allowed,
    (req, res, next) => {
      multipart(req, res, (error) => {
        if (error instanceof multer.MulterError) {
          next(
            error.code === 'LIMIT_FILE_SIZE'
              ? new ApiError(413, 'FILE_TOO_LARGE', 'The file exceeds the upload limit.')
              : new ApiError(422, 'VALIDATION_ERROR', 'Provide one file and its upload purpose.'),
          );
        } else if (error) {
          next(new ApiError(400, 'BAD_REQUEST', 'The file upload could not be read.'));
        } else next();
      });
    },
    async (req, res) => {
      const { purpose } = read(z.strictObject({ purpose: purposes }), req.body);
      const user = viewer(res).user;
      if (
        (user.role === 'LECTURER' && purpose !== 'MATERIAL') ||
        (user.role === 'STUDENT' && purpose !== 'SUBMISSION')
      ) {
        throw new ApiError(403, 'FORBIDDEN', 'Your role cannot upload for this purpose.');
      }
      if (!req.file) throw new ApiError(422, 'VALIDATION_ERROR', 'Choose one file to upload.');
      const bytes = req.file.buffer;
      const limit = purpose === 'SUBMISSION' ? 20 : 25;
      if (bytes.length > limit * mib)
        throw new ApiError(413, 'FILE_TOO_LARGE', 'Uploads for this purpose cannot exceed ' + limit + ' MiB.');
      const retry = await transaction(pool, async (db) => {
        await lockActor(db, res, services);
        const now = await clock(db);
        const { rows } = await db.query<{ uploads: number; window_ends_at: Date }>(
          `INSERT INTO upload_limits VALUES ($1,1,$2::timestamptz+interval '1 hour')
         ON CONFLICT (user_id) DO UPDATE SET
         uploads=CASE WHEN upload_limits.window_ends_at <= $2 THEN 1 ELSE least(upload_limits.uploads+1,21) END,
         window_ends_at=CASE WHEN upload_limits.window_ends_at <= $2 THEN excluded.window_ends_at ELSE upload_limits.window_ends_at END
         RETURNING uploads,window_ends_at`,
          [user.id, now],
        );
        return rows[0].uploads > 20 ? Math.ceil((rows[0].window_ends_at.getTime() - now.getTime()) / 1000) : null;
      });
      if (retry !== null) {
        res.set('Retry-After', String(retry));
        throw new ApiError(429, 'RATE_LIMITED', 'Too many uploads. Try again later.');
      }
      const inspected = await inspectUpload(req.file.originalname, bytes);
      const key = await storage.put(bytes, inspected.contentType);
      let staged: FileRow;
      try {
        staged = await transaction(pool, async (db) => {
          await lockActor(db, res, services);
          await db.query('SELECT 1 FROM upload_limits WHERE user_id=$1 FOR UPDATE', [user.id]);
          const now = await clock(db);
          const quota = (
            await db.query<{ count: number; bytes: string }>(
              "SELECT count(*)::int AS count,coalesce(sum(size_bytes),0)::text AS bytes FROM files WHERE owner_id=$1 AND status='STAGED' AND expires_at>$2",
              [user.id, now],
            )
          ).rows[0];
          if (quota.count >= 20 || Number(quota.bytes) + bytes.length > 200 * mib)
            throw new ApiError(
              409,
              'UPLOAD_QUOTA_EXCEEDED',
              'Remove earlier staged uploads before uploading another file.',
            );
          const result = await db.query<FileRow>(
            `INSERT INTO files (owner_id,purpose,storage_key,original_filename,extension,detected_content_type,size_bytes,sha256,status,created_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGED',$9,$9::timestamptz+interval '24 hours') RETURNING *`,
            [
              user.id,
              purpose,
              key,
              inspected.filename,
              inspected.extension,
              inspected.contentType,
              bytes.length,
              createHash('sha256').update(bytes).digest('hex'),
              now,
            ],
          );
          return result.rows[0];
        });
      } catch (error) {
        await storage
          .remove(key)
          .catch(() => console.error(JSON.stringify({ event: 'unattached_upload_cleanup_failed' })));
        throw error;
      }
      data(res, { ...fileDto(staged), purpose, extension: staged.extension, expiresAt: staged.expires_at }, 201);
    },
  );

  router.delete('/files/staged/:fileId', allowed, async (req, res) => {
    const file = await transaction(pool, async (db) => {
      await lockActor(db, res, services);
      const { rows } = await db.query<FileRow>(
        "UPDATE files SET status='DELETING' WHERE id=$1 AND owner_id=$2 AND status IN ('STAGED','DELETING') RETURNING *",
        [id(req, 'fileId'), viewer(res).user.id],
      );
      if (!rows[0]) notFound();
      return rows[0];
    });
    await discardClaimed(pool, storage, file).catch(() =>
      console.error(JSON.stringify({ event: 'staged_upload_cleanup_deferred' })),
    );
    res.status(204).end();
  });

  router.get('/files/:fileId/download', allowed, async (req, res) => {
    const fileId = id(req, 'fileId');
    const { user } = viewer(res);
    const file = await transaction(pool, async (db) => {
      const entry = (await db.query<FileRow>('SELECT * FROM files WHERE id=$1', [fileId])).rows[0];
      if (!entry || entry.status === 'DELETING') notFound();
      if (entry.status === 'STAGED') {
        const now = await clock(db);
        if (entry.owner_id !== user.id || !entry.expires_at || entry.expires_at <= now) notFound();
        return entry;
      }
      const attached = await binding(db, fileId);
      if (!attached) notFound();
      const module = await scopedModule(db, attached.module_id, user.id, user.role, true);
      const confirmed = await binding(db, fileId);
      if (!confirmed) notFound();
      if (user.role === 'STUDENT') {
        if (entry.purpose === 'SUBMISSION' && confirmed.student_id !== user.id) notFound();
        if (
          entry.purpose === 'MATERIAL' &&
          (confirmed.topic_status !== 'PUBLISHED' || confirmed.material_status !== 'PUBLISHED')
        )
          notFound();
        if (module.status !== 'ARCHIVED') await reconcileExpired(db, module.id, await clock(db), user.id);
        const rules = await releaseRequirements(db, module.id, user.id);
        if (topicLocked(rules, confirmed.topic_id)) return { locked: true as const };
      }
      return entry;
    });
    if ('locked' in file) denyLocked();
    const stream = await storage.open(file.storage_key).catch(() => notFound());
    res.attachment(file.original_filename);
    res.set({
      'Content-Type': file.detected_content_type,
      'Content-Length': String(file.size_bytes),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    await pipeline(stream, res);
  });
  return router;
}
