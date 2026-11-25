import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireRole, viewer, type Role, type Services } from './auth.js';
import { audit, transaction, type Db } from './db.js';
import { ApiError, data, empty, id, invalid, notFound, pageFields, paged, pgError, read, safeText, version } from './http.js';

const statuses = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
type ModuleStatus = typeof statuses[number];
export type ModuleRow = {
  id: string; code: string; name: string; term: string; description: string; lecturer_id: string; status: ModuleStatus;
  version: number; activated_at: Date | null; archived_at: Date | null; created_at: Date; updated_at: Date;
};
type ModuleSummary = ModuleRow & { lecturer_name: string; enrolment_count: number; total: number };
const enrolmentStatus = z.enum(['ACTIVE', 'WITHDRAWN']);
type Enrolment = { module_id: string; student_id: string; status: z.infer<typeof enrolmentStatus>; enrolled_at: Date; withdrawn_at: Date | null; display_name?: string; total: number };
const moduleFields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,24}$/),
  name: safeText(120), term: safeText(40), description: z.string().trim().max(2000).default(''), lecturerId: z.uuid(),
};
const moduleCreate = z.strictObject(moduleFields);
const moduleEdit = moduleCreate.partial().extend({ description: z.string().trim().max(2000).optional(), version });
const moduleFilters = z.strictObject({ ...pageFields, status: z.enum(statuses).optional() });
const adminModuleFilters = moduleFilters.extend({ q: z.string().trim().max(120).optional(), lecturerId: z.uuid().optional() });
const enrolmentFilters = z.strictObject({ ...pageFields, status: enrolmentStatus.optional() });
const versionBody = z.strictObject({ version });

function moduleDto(row: ModuleRow) {
  return {
    id: row.id, code: row.code, name: row.name, term: row.term, description: row.description, status: row.status,
    version: row.version, activatedAt: row.activated_at, archivedAt: row.archived_at, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}
function adminModuleDto(row: ModuleSummary) {
  return { ...moduleDto(row), lecturer: { id: row.lecturer_id, displayName: row.lecturer_name }, activeEnrolmentCount: row.enrolment_count };
}
function enrolmentDto(row: Enrolment) {
  return { moduleId: row.module_id, studentId: row.student_id, displayName: row.display_name, status: row.status, enrolledAt: row.enrolled_at, withdrawnAt: row.withdrawn_at };
}

export function editable(module: ModuleRow) {
  if (module.status === 'ARCHIVED') throw new ApiError(409, 'MODULE_ARCHIVED', 'This archived module is read-only.');
}

export function matchVersion(expected: number, current: number) {
  if (expected !== current) throw new ApiError(409, 'VERSION_CONFLICT', 'This record has changed. Reload it and try again.', { currentVersion: String(current) });
}

export async function scopedModule(db: Db, moduleId: string, userId: string, role: Role, lock = false) {
  const select = (
    `SELECT m.* FROM modules m WHERE m.id = $1 AND (
      ($3 = 'LECTURER' AND m.lecturer_id = $2) OR
      ($3 = 'STUDENT' AND m.status <> 'DRAFT' AND EXISTS (
        SELECT 1 FROM enrolments e WHERE e.module_id = m.id AND e.student_id = $2 AND e.status = 'ACTIVE')
      ))`
  );
  const args = [moduleId, userId, role];
  const row = (await db.query<ModuleRow>(select + (lock ? ' FOR UPDATE OF m' : ''), args)).rows[0];
  if (!row) notFound();
  if (!lock) return row;
  // The enrolment can change while the first statement waits for the module lock.
  const current = (await db.query<ModuleRow>(select, args)).rows[0];
  if (!current) notFound();
  return current;
}

export async function lockActor(db: Db, res: Response, { clock, config }: Services) {
  const { user, tokenHash } = viewer(res);
  const active = (await db.query<{ is_active: boolean; must_change_password: boolean }>(
    'SELECT is_active, must_change_password FROM users WHERE id = $1 FOR SHARE', [user.id],
  )).rows[0];
  const session = (await db.query<{ revoked_at: Date | null; expires_at: Date; last_seen_at: Date }>(
    'SELECT revoked_at, expires_at, last_seen_at FROM sessions WHERE token_hash = $1 FOR SHARE', [tokenHash],
  )).rows[0];
  const now = await clock(db);
  if (!active?.is_active || active.must_change_password || !session || session.revoked_at || session.expires_at <= now
    || now.getTime() - session.last_seen_at.getTime() >= config.SESSION_IDLE_MINUTES * 60_000) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
  }
}

const adminSelect = `SELECT m.*, u.display_name AS lecturer_name,
  (SELECT count(*)::int FROM enrolments e WHERE e.module_id = m.id AND e.status = 'ACTIVE') AS enrolment_count`;
const adminFrom = ' FROM modules m JOIN users u ON u.id = m.lecturer_id ';

async function adminDetail(db: Db, moduleId: string) {
  const row = (await db.query<ModuleSummary>(adminSelect + adminFrom + 'WHERE m.id = $1', [moduleId])).rows[0];
  if (!row) notFound();
  return adminModuleDto(row);
}
async function lockModule(db: Db, moduleId: string) {
  const row = (await db.query<ModuleRow>('SELECT * FROM modules WHERE id = $1 FOR UPDATE', [moduleId])).rows[0];
  if (!row) notFound();
  return row;
}

async function validateAccount(db: Db, accountId: string, role: 'LECTURER' | 'STUDENT', active = true) {
  const user = (await db.query<{ display_name: string; is_active: boolean }>('SELECT display_name, is_active FROM users WHERE id = $1 AND role = $2 FOR SHARE', [accountId, role])).rows[0];
  if (!user || (active && !user.is_active)) invalid('Select an active ' + role.toLowerCase() + ' account.');
  return user;
}

function moduleConflict(error: unknown): never {
  if (pgError(error, '23505', 'modules_code_term_normalized_key')) throw new ApiError(409, 'DUPLICATE_MODULE', 'That module code already exists for this term.');
  throw error;
}

export function moduleRoutes({ pool, clock }: Services) {
  const router = Router();
  router.use('/admin/modules', requireRole('ADMIN'));
  router.use('/modules', requireRole('LECTURER', 'STUDENT'));

  router.get('/admin/modules', async (req, res) => {
    const { page, pageSize, q, status, lecturerId } = read(adminModuleFilters, req.query);
    const from = adminFrom + `WHERE ($1::text IS NULL OR strpos(lower(m.code || ' ' || m.name || ' ' || m.term), lower($1)) > 0)
      AND ($2::text IS NULL OR m.status = $2) AND ($3::uuid IS NULL OR m.lecturer_id = $3)`;
    const args = [q, status, lecturerId];
    const result = await pool.query<ModuleSummary>(adminSelect + ', count(*) OVER()::int AS total ' + from + ' ORDER BY m.code, m.term, m.id LIMIT $4 OFFSET $5', [...args, pageSize, (page - 1) * pageSize]);
    const count = result.rows[0]?.total ?? (page === 1 ? 0 : (await pool.query<{ total: number }>('SELECT count(*)::int AS total ' + from, args)).rows[0].total);
    paged(res, result.rows.map(adminModuleDto), count, page, pageSize);
  });

  router.post('/admin/modules', async (req, res) => {
    const input = read(moduleCreate, req.body);
    const created = await transaction(pool, async db => {
      await validateAccount(db, input.lecturerId, 'LECTURER');
      const result = await db.query<ModuleRow>(
        'INSERT INTO modules (code, name, term, description, lecturer_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
        [input.code, input.name, input.term, input.description, input.lecturerId],
      );
      await audit(db, viewer(res).user.id, 'MODULE_CREATED', 'MODULE', result.rows[0].id, result.rows[0].id);
      return adminDetail(db, result.rows[0].id);
    }).catch(moduleConflict);
    data(res, created, 201);
  });

  router.get('/admin/modules/:moduleId', async (req, res) => data(res, await adminDetail(pool, id(req, 'moduleId'))));

  router.patch('/admin/modules/:moduleId', async (req, res) => {
    const moduleId = id(req, 'moduleId');
    const input = read(moduleEdit, req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    const updated = await transaction(pool, async db => {
      if (input.lecturerId) await validateAccount(db, input.lecturerId, 'LECTURER');
      const current = await lockModule(db, moduleId);
      editable(current);
      matchVersion(input.version, current.version);
      if (current.status === 'ACTIVE' && ((input.code && input.code !== current.code) || (input.term && input.term !== current.term))) {
        throw new ApiError(409, 'INVALID_STATE', 'Module code and term are fixed after activation.');
      }
      await db.query(
        `UPDATE modules SET code = coalesce($2, code), name = coalesce($3, name), term = coalesce($4, term),
         description = coalesce($5, description), lecturer_id = coalesce($6, lecturer_id), version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1`, [moduleId, input.code, input.name, input.term, input.description, input.lecturerId],
      );
      if (input.lecturerId && input.lecturerId !== current.lecturer_id) await audit(db, viewer(res).user.id, 'MODULE_LECTURER_TRANSFERRED', 'MODULE', moduleId, moduleId);
      return adminDetail(db, moduleId);
    }).catch(moduleConflict);
    data(res, updated);
  });

  router.post('/admin/modules/:moduleId/activate', async (req, res) => {
    const moduleId = id(req, 'moduleId');
    const input = read(versionBody, req.body);
    const activated = await transaction(pool, async db => {
      const assigned = (await db.query<ModuleRow>('SELECT lecturer_id FROM modules WHERE id = $1', [moduleId])).rows[0];
      if (!assigned) notFound();
      await validateAccount(db, assigned.lecturer_id, 'LECTURER');
      const current = await lockModule(db, moduleId);
      matchVersion(input.version, current.version);
      if (current.lecturer_id !== assigned.lecturer_id || current.status !== 'DRAFT') throw new ApiError(409, 'INVALID_STATE', 'Only a draft module can be activated.');
      const now = await clock(db);
      await db.query("UPDATE modules SET status = 'ACTIVE', activated_at = $2, updated_at = $2, version = version + 1 WHERE id = $1", [moduleId, now]);
      await audit(db, viewer(res).user.id, 'MODULE_ACTIVATED', 'MODULE', moduleId, moduleId, { status: 'ACTIVE' });
      return adminDetail(db, moduleId);
    });
    data(res, activated);
  });

  router.post('/admin/modules/:moduleId/archive', async (req, res) => {
    const moduleId = id(req, 'moduleId');
    const input = read(z.strictObject({ version, confirmUnpublishedGrades: z.boolean() }), req.body);
    const archived = await transaction(pool, async db => {
      const current = await lockModule(db, moduleId);
      matchVersion(input.version, current.version);
      if (current.status !== 'ACTIVE') throw new ApiError(409, 'INVALID_STATE', 'Only an active module can be archived.');
      // Assessment and grade blockers must join this transaction when those records are introduced.
      const now = await clock(db);
      await db.query("UPDATE modules SET status = 'ARCHIVED', archived_at = $2, updated_at = $2, version = version + 1 WHERE id = $1", [moduleId, now]);
      await audit(db, viewer(res).user.id, 'MODULE_ARCHIVED', 'MODULE', moduleId, moduleId, { status: 'ARCHIVED' });
      return adminDetail(db, moduleId);
    });
    data(res, archived);
  });

  router.get('/admin/modules/:moduleId/enrolments', async (req, res) => {
    const moduleId = id(req, 'moduleId');
    await adminDetail(pool, moduleId);
    await listEnrolments(req, res, moduleId);
  });

  router.post('/admin/modules/:moduleId/enrolments', async (req, res) => {
    const moduleId = id(req, 'moduleId');
    const { studentId } = read(z.strictObject({ studentId: z.uuid() }), req.body);
    const result = await transaction(pool, async db => {
      const student = await validateAccount(db, studentId, 'STUDENT');
      editable(await lockModule(db, moduleId));
      const { rows } = await db.query<Enrolment>(
        'INSERT INTO enrolments (module_id, student_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING *', [moduleId, studentId],
      );
      if (!rows[0]) throw new ApiError(409, 'ENROLMENT_EXISTS', 'This student already has an enrolment record.');
      await audit(db, viewer(res).user.id, 'ENROLMENT_ADDED', 'ENROLMENT', studentId, moduleId, { status: 'ACTIVE' });
      return enrolmentDto({ ...rows[0], display_name: student.display_name });
    });
    data(res, result, 201);
  });

  for (const action of ['withdraw', 'reactivate'] as const) {
    router.post('/admin/modules/:moduleId/enrolments/:studentId/' + action, async (req, res) => {
      const moduleId = id(req, 'moduleId');
      const studentId = id(req, 'studentId');
      read(empty, req.body ?? {});
      const target = action === 'withdraw' ? 'WITHDRAWN' : 'ACTIVE';
      const result = await transaction(pool, async db => {
        const student = await validateAccount(db, studentId, 'STUDENT', target === 'ACTIVE');
        editable(await lockModule(db, moduleId));
        const current = (await db.query<Enrolment>('SELECT * FROM enrolments WHERE module_id = $1 AND student_id = $2 FOR UPDATE', [moduleId, studentId])).rows[0];
        if (!current) notFound();
        if (current.status === target) throw new ApiError(409, 'INVALID_STATE', 'The enrolment already has this status.');
        const withdrawnAt = target === 'WITHDRAWN' ? await clock(db) : null;
        const updated = (await db.query<Enrolment>(
          'UPDATE enrolments SET status = $3, withdrawn_at = $4 WHERE module_id = $1 AND student_id = $2 RETURNING *',
          [moduleId, studentId, target, withdrawnAt],
        )).rows[0];
        await audit(db, viewer(res).user.id, target === 'WITHDRAWN' ? 'ENROLMENT_WITHDRAWN' : 'ENROLMENT_REACTIVATED', 'ENROLMENT', studentId, moduleId, { status: target });
        return enrolmentDto({ ...updated, display_name: student.display_name });
      });
      data(res, result);
    });
  }

  router.get('/modules', async (req, res) => {
    const { page, pageSize, status } = read(moduleFilters, req.query);
    const { user } = viewer(res);
    const from = `FROM modules m WHERE ($3::text IS NULL OR m.status = $3) AND (
      ($2 = 'LECTURER' AND m.lecturer_id = $1) OR
      ($2 = 'STUDENT' AND m.status <> 'DRAFT' AND EXISTS (
        SELECT 1 FROM enrolments e WHERE e.module_id = m.id AND e.student_id = $1 AND e.status = 'ACTIVE')))`;
    const args = [user.id, user.role, status];
    const result = await pool.query<ModuleSummary>('SELECT m.*, count(*) OVER()::int AS total ' + from + ' ORDER BY code, term, id LIMIT $4 OFFSET $5', [...args, pageSize, (page - 1) * pageSize]);
    const count = result.rows[0]?.total ?? (page === 1 ? 0 : (await pool.query<{ total: number }>('SELECT count(*)::int AS total ' + from, args)).rows[0].total);
    paged(res, result.rows.map(moduleDto), count, page, pageSize);
  });

  router.get('/modules/:moduleId', async (req, res) => {
    const { user } = viewer(res);
    const module = await scopedModule(pool, id(req, 'moduleId'), user.id, user.role);
    data(res, { ...moduleDto(module), allowedActions: { manageContent: user.role === 'LECTURER' && module.status !== 'ARCHIVED' } });
  });

  router.get('/modules/:moduleId/roster', requireRole('LECTURER'), async (req, res) => {
    const { user } = viewer(res);
    await transaction(pool, async db => {
      const { id: moduleId } = await scopedModule(db, id(req, 'moduleId'), user.id, user.role, true);
      await listEnrolments(req, res, moduleId, db);
    });
  });

  async function listEnrolments(req: Request, res: Response, moduleId: string, db: Db = pool) {
    const { page, pageSize, status } = read(enrolmentFilters, req.query);
    const from = ' FROM enrolments e JOIN users u ON u.id = e.student_id WHERE e.module_id = $1 AND ($2::text IS NULL OR e.status = $2)';
    const args = [moduleId, status];
    const result = await db.query<Enrolment>('SELECT e.*, u.display_name, count(*) OVER()::int AS total ' + from + ' ORDER BY u.display_name, e.student_id LIMIT $3 OFFSET $4', [...args, pageSize, (page - 1) * pageSize]);
    const count = result.rows[0]?.total ?? (page === 1 ? 0 : (await db.query<{ total: number }>('SELECT count(*)::int AS total ' + from, args)).rows[0].total);
    paged(res, result.rows.map(enrolmentDto), count, page, pageSize);
  }

  return router;
}
