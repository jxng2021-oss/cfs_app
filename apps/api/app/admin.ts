import { Router } from 'express';
import { z } from 'zod';
import { adminUserDto, hashPassword, requireRole, revokeSessions, temporaryPassword, viewer, type Services, type UserRow } from './auth.js';
import { audit, transaction } from './db.js';
import { ApiError, data, email, empty, id, invalid, notFound, pageFields, paged, pgError, read, safeText } from './http.js';

const roleField = z.enum(['ADMIN', 'LECTURER', 'STUDENT']);
const userCreate = z.strictObject({ email, displayName: safeText(120), role: z.enum(['LECTURER', 'STUDENT']) });
const userEdit = z.strictObject({ displayName: safeText(120).optional(), isActive: z.boolean().optional() });
const userFilter = z.strictObject({
  ...pageFields, q: z.string().trim().max(254).optional(), role: roleField.optional(),
  isActive: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
});
const auditFilter = z.strictObject({
  ...pageFields, eventType: safeText(80).optional(), moduleId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
});

export function adminRoutes({ pool, clock }: Services) {
  const router = Router();
  router.use('/admin', requireRole('ADMIN'));

  router.get('/admin/users', async (req, res) => {
    const { q, role, isActive, page, pageSize } = read(userFilter, req.query);
    const filter = `FROM users WHERE ($1::text IS NULL OR strpos(lower(display_name), lower($1)) > 0 OR strpos(email_normalized, lower($1)) > 0)
        AND ($2::text IS NULL OR role = $2) AND ($3::boolean IS NULL OR is_active = $3)`;
    const args = [q, role, isActive];
    const result = await pool.query<UserRow & { total: number }>(`SELECT *, count(*) OVER()::int AS total ${filter} ORDER BY display_name, id LIMIT $4 OFFSET $5`, [...args, pageSize, (page - 1) * pageSize]);
    const count = result.rows[0]?.total ?? (page === 1 ? 0 : (await pool.query<{ total: number }>('SELECT count(*)::int AS total ' + filter, args)).rows[0].total);
    paged(res, result.rows.map(adminUserDto), count, page, pageSize);
  });

  router.post('/admin/users', async (req, res) => {
    const input = read(userCreate, req.body);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    try {
      const user = await transaction(pool, async db => {
        const result = await db.query<UserRow>(
          'INSERT INTO users (email_normalized, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
          [input.email, input.displayName, input.role, passwordHash],
        );
        await audit(db, viewer(res).user.id, 'USER_CREATED', 'USER', result.rows[0].id);
        return result.rows[0];
      });
      data(res, { user: adminUserDto(user), temporaryPassword: password }, 201);
    } catch (error) {
      if (pgError(error, '23505', 'users_email_normalized_key')) throw new ApiError(409, 'DUPLICATE_EMAIL', 'This email is already in use.');
      throw error;
    }
  });

  router.patch('/admin/users/:userId', async (req, res) => {
    const userId = id(req, 'userId');
    const input = read(userEdit, req.body);
    if (input.displayName === undefined && input.isActive === undefined) invalid('Provide at least one change.');
    const user = await transaction(pool, async db => {
      const current = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!current) notFound();
      if (current.role === 'ADMIN' && input.isActive !== undefined) throw new ApiError(403, 'FORBIDDEN', 'Administrator status cannot be changed here.');
      if (input.isActive === false && current.is_active && current.role === 'LECTURER') {
        const ownsModules = (await db.query("SELECT 1 FROM modules WHERE lecturer_id = $1 AND status IN ('DRAFT', 'ACTIVE') LIMIT 1", [userId])).rowCount;
        if (ownsModules) throw new ApiError(409, 'INVALID_STATE', 'Reassign this lecturer’s draft and active modules first.');
      }
      const now = await clock(db);
      const updated = (await db.query<UserRow>(
        'UPDATE users SET display_name = coalesce($2, display_name), is_active = coalesce($3, is_active), updated_at = $4 WHERE id = $1 RETURNING *',
        [userId, input.displayName, input.isActive, now],
      )).rows[0];
      if (current.is_active !== updated.is_active) {
        if (!updated.is_active) await revokeSessions(db, userId, now);
        await audit(db, viewer(res).user.id, updated.is_active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', 'USER', userId);
      }
      return updated;
    });
    data(res, adminUserDto(user));
  });

  router.post('/admin/users/:userId/reset-password', async (req, res) => {
    const userId = id(req, 'userId');
    read(empty, req.body ?? {});
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const user = await transaction(pool, async db => {
      const current = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!current) notFound();
      if (current.role === 'ADMIN') throw new ApiError(403, 'FORBIDDEN', 'Administrators must change their own passwords.');
      const now = await clock(db);
      const result = await db.query<UserRow>('UPDATE users SET password_hash = $2, must_change_password = true, updated_at = $3 WHERE id = $1 RETURNING *', [userId, passwordHash, now]);
      await revokeSessions(db, userId, now);
      await audit(db, viewer(res).user.id, 'USER_PASSWORD_RESET', 'USER', userId);
      return result.rows[0];
    });
    data(res, { user: adminUserDto(user), temporaryPassword: password });
  });

  router.get('/admin/audit-events', async (req, res) => {
    const { eventType, moduleId, from, to, page, pageSize } = read(auditFilter, req.query);
    if (from && to && new Date(from) >= new Date(to)) invalid('The end must follow the start.');
    const where = `FROM audit_events WHERE ($1::text IS NULL OR event_type = $1) AND ($2::uuid IS NULL OR module_id = $2)
      AND ($3::timestamptz IS NULL OR occurred_at >= $3) AND ($4::timestamptz IS NULL OR occurred_at < $4)`;
    const args = [eventType, moduleId, from, to];
    const result = await pool.query(`SELECT id, actor_id "actorId", event_type "eventType", module_id "moduleId",
      entity_type "entityType", entity_id "entityId", occurred_at "occurredAt", metadata, count(*) OVER()::int AS total
      ${where} ORDER BY occurred_at DESC, id LIMIT $5 OFFSET $6`, [...args, pageSize, (page - 1) * pageSize]);
    const count = result.rows[0]?.total ?? (page === 1 ? 0 : (await pool.query('SELECT count(*)::int AS total ' + where, args)).rows[0].total);
    paged(res, result.rows.map(({ total: _total, ...row }) => { void _total; return row; }), count, page, pageSize);
  });
  return router;
}
