import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { requireRole, viewer, type Services } from './auth.js';
import { audit, transaction, type Db } from './db.js';
import { ApiError, data, empty, id, invalid, notFound, read, safeText, version } from './http.js';
import { editable, lockActor, matchVersion, scopedModule, type ModuleRow } from './modules.js';

type Topic = {
  id: string; module_id: string; title: string; description: string; position: number;
  status: 'DRAFT' | 'PUBLISHED'; version: number; published_at: Date | null;
  required_count?: number; completed_count?: number;
};
type Material = {
  id: string; topic_id: string; title: string; summary: string; type: 'TEXT' | 'LINK'; position: number;
  status: 'DRAFT' | 'PUBLISHED'; is_required: boolean; version: number; published_at: Date | null;
  text_body: string | null; external_url: string | null; completed_at?: Date | null;
};

const topicFields = { title: safeText(120), description: z.string().trim().max(2000).optional() };
const topicCreate = z.strictObject(topicFields);
const topicEdit = z.strictObject({ ...topicFields, title: topicFields.title.optional(), version });
const contentFields = {
  title: safeText(120), summary: z.string().trim().max(500), type: z.enum(['TEXT', 'LINK']), required: z.boolean(),
  textBody: safeText(20000), externalUrl: z.string().trim().max(2048).startsWith('https://').pipe(z.url({ protocol: /^https$/ })).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, 'Do not include credentials in the URL'),
};
const materialFields = z.strictObject({ ...contentFields, summary: contentFields.summary.optional(), required: contentFields.required.optional(),
  textBody: contentFields.textBody.optional(), externalUrl: contentFields.externalUrl.optional() });
const materialEdit = materialFields.partial().extend({ version });
const versionBody = z.strictObject({ version });

export function readingProgress(completed: number, total: number) {
  return { completed, total, percent: total === 0 ? null : Math.floor((200 * completed + total) / (2 * total)) };
}

function topicDto(row: Topic, learner: boolean) {
  const details = { id: row.id, title: row.title, description: row.description, position: row.position, status: row.status };
  if (!learner) return { ...details, version: row.version, publishedAt: row.published_at };
  const progress = readingProgress(row.completed_count ?? 0, row.required_count ?? 0);
  return { ...details, progress, learningState: progress.percent === 100 ? 'COMPLETE' : 'AVAILABLE', requirements: [] };
}

function materialDto(row: Material, learner: boolean, detail = false) {
  return {
    id: row.id, title: row.title, summary: row.summary, position: row.position, status: row.status, type: row.type, required: row.is_required,
    ...(learner ? { completedAt: row.completed_at ?? null } : { version: row.version, publishedAt: row.published_at }),
    ...(detail ? { textBody: row.text_body, externalUrl: row.external_url } : {}),
  };
}

const topicSelect = `SELECT t.*,
  (SELECT count(*)::int FROM materials m WHERE m.topic_id = t.id AND m.status = 'PUBLISHED' AND m.is_required) AS required_count,
  (SELECT count(*)::int FROM materials m JOIN material_completions c ON c.material_id = m.id AND c.student_id = $2
    WHERE m.topic_id = t.id AND m.status = 'PUBLISHED' AND m.is_required) AS completed_count FROM topics t`;

async function getTopic(db: Db, moduleId: string, topicId: string, studentId: string | null) {
  const row = (await db.query<Topic>(topicSelect + " WHERE t.module_id = $1 AND t.id = $3 AND ($2::uuid IS NULL OR t.status = 'PUBLISHED')", [moduleId, studentId, topicId])).rows[0];
  if (!row) notFound();
  return row;
}

function materialQuery(filter = '') {
  return `SELECT m.*, c.completed_at FROM materials m LEFT JOIN material_completions c ON c.material_id = m.id AND c.student_id = $2
    WHERE m.topic_id = $1 AND ($2::uuid IS NULL OR m.status = 'PUBLISHED')` + filter;
}

async function getMaterial(db: Db, topicId: string, materialId: string, studentId: string | null) {
  const row = (await db.query<Material>(materialQuery(' AND m.id = $3'), [topicId, studentId, materialId])).rows[0];
  if (!row) notFound();
  return row;
}

function draft(topic: Topic) {
  if (topic.status !== 'DRAFT') throw new ApiError(409, 'INVALID_STATE', 'Materials in a published topic are read-only.');
}
function payload(type: Material['type'], text: string | null | undefined, link: string | null | undefined) {
  if (type === 'TEXT' && text && !link) return [text, null] as const;
  if (type === 'LINK' && link && !text) return [null, link] as const;
  return invalid('Provide exactly the content required by the selected material type.');
}
function verifyOrder(requested: string[], existing: string[]) {
  if (requested.length !== existing.length || new Set(requested).size !== existing.length || existing.some(id => !requested.includes(id))) {
    invalid('Include every current item exactly once.');
  }
}

export function contentRoutes(services: Services) {
  const { pool, clock } = services;
  const router = Router();
  const lecturer = requireRole('LECTURER');
  const studentOnly = requireRole('STUDENT');
  const topics = '/modules/:moduleId/topics';
  const topic = topics + '/:topicId';
  const materials = topic + '/materials';
  const material = materials + '/:materialId';

  async function access<T>(req: Request, res: Response, write: boolean, run: (db: pg.PoolClient, module: ModuleRow, studentId: string | null) => Promise<T>) {
    const { user } = viewer(res);
    return transaction(pool, async db => {
      if (write) await lockActor(db, res, services);
      const module = await scopedModule(db, id(req, 'moduleId'), user.id, user.role, true);
      if (write) editable(module);
      return run(db, module, user.role === 'STUDENT' ? user.id : null);
    });
  }

  router.get(topics, async (req, res) => data(res, await access(req, res, false, async (db, module, studentId) => {
    const { rows } = await db.query<Topic>(topicSelect + " WHERE t.module_id = $1 AND ($2::uuid IS NULL OR t.status = 'PUBLISHED') ORDER BY t.position, t.id", [module.id, studentId]);
    return rows.map(row => topicDto(row, Boolean(studentId)));
  })));

  router.post(topics, lecturer, async (req, res) => {
    const input = read(topicCreate, req.body);
    data(res, await access(req, res, true, async (db, module) => {
      const { rows } = await db.query<Topic>(
        `INSERT INTO topics (module_id, title, description, position)
         SELECT $1, $2, $3, coalesce(max(position), 0) + 1 FROM topics WHERE module_id = $1 RETURNING *`,
        [module.id, input.title, input.description ?? ''],
      );
      await db.query('UPDATE modules SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [module.id]);
      return topicDto(rows[0], false);
    }), 201);
  });

  router.get(topic, async (req, res) => data(res, await access(req, res, false, async (db, module, studentId) => {
    const row = await getTopic(db, module.id, id(req, 'topicId'), studentId);
    const { rows } = await db.query<Material>(materialQuery(' ORDER BY m.position, m.id'), [row.id, studentId]);
    return { ...topicDto(row, Boolean(studentId)), materials: rows.map(value => materialDto(value, Boolean(studentId))) };
  })));

  router.patch(topic, lecturer, async (req, res) => {
    const input = read(topicEdit, req.body);
    if (input.title === undefined && input.description === undefined) invalid('Provide at least one change.');
    data(res, await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      matchVersion(input.version, row.version);
      const result = await db.query<Topic>(
        'UPDATE topics SET title = coalesce($2, title), description = coalesce($3, description), version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *',
        [row.id, input.title, input.description],
      );
      return topicDto(result.rows[0], false);
    }));
  });

  router.post(topic + '/publish', lecturer, async (req, res) => {
    const input = read(versionBody, req.body);
    data(res, await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      matchVersion(input.version, row.version);
      if (row.status !== 'DRAFT') throw new ApiError(409, 'INVALID_STATE', 'This topic is already published.');
      if (!row.required_count) invalid('Publish at least one required material before publishing the topic.');
      const publishedAt = await clock(db);
      const result = await db.query<Topic>("UPDATE topics SET status = 'PUBLISHED', published_at = $2, updated_at = $2, version = version + 1 WHERE id = $1 RETURNING *", [row.id, publishedAt]);
      await audit(db, viewer(res).user.id, 'TOPIC_PUBLISHED', 'TOPIC', row.id, module.id);
      return topicDto(result.rows[0], false);
    }));
  });

  router.put('/modules/:moduleId/topic-order', lecturer, async (req, res) => {
    const input = read(z.strictObject({ topicIds: z.array(z.uuid()), moduleVersion: version }), req.body);
    data(res, await access(req, res, true, async (db, module) => {
      matchVersion(input.moduleVersion, module.version);
      const { rows } = await db.query<Topic>('SELECT id, status FROM topics WHERE module_id = $1 ORDER BY position', [module.id]);
      verifyOrder(input.topicIds, rows.map(row => row.id));
      const published = new Set(rows.filter(row => row.status === 'PUBLISHED').map(row => row.id));
      if (input.topicIds.filter(id => published.has(id)).some((id, index) => id !== [...published][index])) {
        throw new ApiError(409, 'INVALID_STATE', 'Published topics must keep their relative order.');
      }
      await db.query('SET CONSTRAINTS topics_module_id_position_key DEFERRED');
      await db.query('UPDATE topics t SET position = ordered.position FROM unnest($1::uuid[]) WITH ORDINALITY ordered(id, position) WHERE t.id = ordered.id', [input.topicIds]);
      await db.query('UPDATE modules SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [module.id]);
      return { topicIds: input.topicIds, moduleVersion: module.version + 1 };
    }));
  });

  router.delete(topic, lecturer, async (req, res) => {
    await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      if (row.status !== 'DRAFT') throw new ApiError(409, 'INVALID_STATE', 'Published topics cannot be deleted.');
      await db.query('DELETE FROM topics WHERE id = $1', [row.id]);
      await db.query('SET CONSTRAINTS topics_module_id_position_key DEFERRED');
      await db.query('UPDATE topics SET position = position - 1 WHERE module_id = $1 AND position > $2', [module.id, row.position]);
      await db.query('UPDATE modules SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [module.id]);
    });
    res.status(204).end();
  });

  router.get(material, async (req, res) => data(res, await access(req, res, false, async (db, module, studentId) => {
    const row = await getTopic(db, module.id, id(req, 'topicId'), studentId);
    return materialDto(await getMaterial(db, row.id, id(req, 'materialId'), studentId), Boolean(studentId), true);
  })));

  router.post(materials, lecturer, async (req, res) => {
    const input = read(materialFields, req.body);
    const [text, link] = payload(input.type, input.textBody, input.externalUrl);
    data(res, await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      draft(row);
      const result = await db.query<Material>(
        `INSERT INTO materials (topic_id, title, summary, type, text_body, external_url, is_required, position)
         SELECT $1, $2, $3, $4, $5, $6, $7, coalesce(max(position), 0) + 1 FROM materials WHERE topic_id = $1 RETURNING *`,
        [row.id, input.title, input.summary ?? '', input.type, text, link, input.required ?? true],
      );
      await db.query('UPDATE topics SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [row.id]);
      return materialDto(result.rows[0], false, true);
    }), 201);
  });

  router.patch(material, lecturer, async (req, res) => {
    const input = read(materialEdit, req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    data(res, await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      draft(row);
      const item = await getMaterial(db, row.id, id(req, 'materialId'), null);
      matchVersion(input.version, item.version);
      if (item.status === 'PUBLISHED') throw new ApiError(409, 'INVALID_STATE', 'Revert this material to draft before editing.');
      const type = input.type ?? item.type;
      const [text, link] = payload(type, input.textBody ?? (type === 'TEXT' ? item.text_body : null), input.externalUrl ?? (type === 'LINK' ? item.external_url : null));
      const result = await db.query<Material>(
        `UPDATE materials SET title = coalesce($2, title), summary = coalesce($3, summary), type = $4, text_body = $5, external_url = $6,
         is_required = coalesce($7, is_required), version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [item.id, input.title, input.summary, type, text, link, input.required],
      );
      return materialDto(result.rows[0], false, true);
    }));
  });

  for (const action of ['publish', 'unpublish'] as const) {
    router.post(material + '/' + action, lecturer, async (req, res) => {
      const input = read(versionBody, req.body);
      data(res, await access(req, res, true, async (db, module) => {
        const row = await getTopic(db, module.id, id(req, 'topicId'), null);
        draft(row);
        const item = await getMaterial(db, row.id, id(req, 'materialId'), null);
        matchVersion(input.version, item.version);
        const status = action === 'publish' ? 'PUBLISHED' : 'DRAFT';
        if (item.status === status) throw new ApiError(409, 'INVALID_STATE', 'The material already has this status.');
        const now = await clock(db);
        const result = await db.query<Material>(
          'UPDATE materials SET status = $2, published_at = $3, updated_at = $4, version = version + 1 WHERE id = $1 RETURNING *',
          [item.id, status, status === 'PUBLISHED' ? now : null, now],
        );
        await db.query('UPDATE topics SET version = version + 1, updated_at = $2 WHERE id = $1', [row.id, now]);
        return materialDto(result.rows[0], false, true);
      }));
    });
  }

  router.put(topic + '/material-order', lecturer, async (req, res) => {
    const input = read(z.strictObject({ materialIds: z.array(z.uuid()), topicVersion: version }), req.body);
    data(res, await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      draft(row);
      matchVersion(input.topicVersion, row.version);
      const { rows } = await db.query<Material>('SELECT id FROM materials WHERE topic_id = $1 ORDER BY position', [row.id]);
      verifyOrder(input.materialIds, rows.map(item => item.id));
      await db.query('SET CONSTRAINTS materials_topic_id_position_key DEFERRED');
      await db.query('UPDATE materials m SET position = ordered.position FROM unnest($1::uuid[]) WITH ORDINALITY ordered(id, position) WHERE m.id = ordered.id', [input.materialIds]);
      await db.query('UPDATE topics SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [row.id]);
      return { materialIds: input.materialIds, topicVersion: row.version + 1 };
    }));
  });

  router.delete(material, lecturer, async (req, res) => {
    await access(req, res, true, async (db, module) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), null);
      draft(row);
      const item = await getMaterial(db, row.id, id(req, 'materialId'), null);
      await db.query('DELETE FROM materials WHERE id = $1', [item.id]);
      await db.query('SET CONSTRAINTS materials_topic_id_position_key DEFERRED');
      await db.query('UPDATE materials SET position = position - 1 WHERE topic_id = $1 AND position > $2', [row.id, item.position]);
      await db.query('UPDATE topics SET version = version + 1, updated_at = clock_timestamp() WHERE id = $1', [row.id]);
    });
    res.status(204).end();
  });

  router.put(material + '/completion', studentOnly, async (req, res) => {
    read(empty, req.body ?? {});
    data(res, await access(req, res, true, async (db, module, studentId) => {
      const row = await getTopic(db, module.id, id(req, 'topicId'), studentId);
      const item = await getMaterial(db, row.id, id(req, 'materialId'), studentId);
      if (!item.is_required) throw new ApiError(409, 'INVALID_STATE', 'Only required materials count toward completion.');
      const now = await clock(db);
      await db.query('INSERT INTO material_completions (student_id, material_id, completed_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [studentId, item.id, now]);
      const { rows } = await db.query<{ completed_at: Date }>('SELECT completed_at FROM material_completions WHERE student_id = $1 AND material_id = $2', [studentId, item.id]);
      return { completed: true, completedAt: rows[0].completed_at };
    }));
  });

  router.get('/modules/:moduleId/progress/me', studentOnly, async (req, res) => data(res, await access(req, res, false, async (db, module, studentId) => {
    const { rows } = await db.query<Topic>(topicSelect + " WHERE t.module_id = $1 AND t.status = 'PUBLISHED' ORDER BY t.position, t.id", [module.id, studentId]);
    const completed = rows.reduce((sum, row) => sum + (row.completed_count ?? 0), 0);
    const total = rows.reduce((sum, row) => sum + (row.required_count ?? 0), 0);
    return { overall: readingProgress(completed, total), topics: rows.map(row => topicDto(row, true)) };
  })));
  return router;
}
