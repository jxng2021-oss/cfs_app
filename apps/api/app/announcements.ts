import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { ApiError, data, id, invalid, notFound, read, safeText, version } from './http.js';
import { type LearningScope, withLearning } from './learning-access.js';
import { matchVersion } from './modules.js';

const fields = z.strictObject({ title: safeText(120), body: safeText(5000), isPinned: z.boolean() });
const optimistic = z.strictObject({ version });
type Record = {
  id: string;
  title: string;
  body: string;
  is_pinned: boolean;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  published_at: Date | null;
  updated_at: Date;
  version: number;
};
function dto(row: Record, student: boolean) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    isPinned: row.is_pinned,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    ...(!student ? { status: row.status, version: row.version } : {}),
  };
}
async function owned(scope: LearningScope, announcementId: string) {
  const { rows } = await scope.db.query<Record>('SELECT * FROM announcements WHERE module_id=$1 AND id=$2', [
    scope.module.id,
    announcementId,
  ]);
  if (!rows[0]) notFound();
  return rows[0];
}

export function announcementRoutes(services: Services) {
  const router = Router();
  const path = '/modules/:moduleId/announcements';
  const choice = path + '/:announcementId';
  const lecturer = requireRole('LECTURER');
  router.get(path, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { rows } = await scope.db.query<Record>(
          "SELECT * FROM announcements WHERE module_id=$1 AND (NOT $2::boolean OR status='PUBLISHED') ORDER BY is_pinned DESC,published_at DESC NULLS LAST,id",
          [scope.module.id, !!scope.studentId],
        );
        return rows.map((item) => dto(item, !!scope.studentId));
      }),
    ),
  );
  router.post(path, lecturer, async (req, res) => {
    const input = read(fields.extend({ isPinned: fields.shape.isPinned.default(false) }), req.body);
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { rows } = await scope.db.query<Record>(
          'INSERT INTO announcements (module_id,title,body,is_pinned,updated_at) VALUES ($1,$2,$3,$4,$5) RETURNING *',
          [scope.module.id, input.title, input.body, input.isPinned, scope.now],
        );
        return dto(rows[0], false);
      }),
      201,
    );
  });
  router.patch(choice, lecturer, async (req, res) => {
    const input = read(fields.partial().extend({ version }), req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const item = await owned(scope, id(req, 'announcementId'));
        if (item.status === 'ARCHIVED')
          throw new ApiError(409, 'INVALID_STATE', 'This archived announcement is read-only.');
        matchVersion(input.version, item.version);
        const { rows } = await scope.db.query<Record>(
          'UPDATE announcements SET title=$2,body=$3,is_pinned=$4,updated_at=$5,version=version+1 WHERE id=$1 RETURNING *',
          [item.id, input.title ?? item.title, input.body ?? item.body, input.isPinned ?? item.is_pinned, scope.now],
        );
        return dto(rows[0], false);
      }),
    );
  });
  for (const action of ['publish', 'archive'] as const) {
    router.post(choice + '/' + action, lecturer, async (req, res) => {
      const input = read(optimistic, req.body);
      data(
        res,
        await withLearning(services, req, res, true, async (scope) => {
          const item = await owned(scope, id(req, 'announcementId'));
          matchVersion(input.version, item.version);
          const publish = action === 'publish';
          if (item.status !== (publish ? 'DRAFT' : 'PUBLISHED'))
            throw new ApiError(409, 'INVALID_STATE', 'The announcement cannot make this transition.');
          const { rows } = await scope.db.query<Record>(
            'UPDATE announcements SET status=$2,published_at=$3,archived_at=$4,updated_at=$5,version=version+1 WHERE id=$1 RETURNING *',
            [
              item.id,
              publish ? 'PUBLISHED' : 'ARCHIVED',
              publish ? scope.now : item.published_at,
              publish ? null : scope.now,
              scope.now,
            ],
          );
          return dto(rows[0], false);
        }),
      );
    });
  }
  router.delete(choice, lecturer, async (req, res) => {
    await withLearning(services, req, res, true, async (scope) => {
      const item = await owned(scope, id(req, 'announcementId'));
      if (item.status !== 'DRAFT')
        throw new ApiError(409, 'INVALID_STATE', 'Only draft announcements can be deleted.');
      await scope.db.query('DELETE FROM announcements WHERE id=$1', [item.id]);
    });
    res.status(204).end();
  });
  return router;
}
