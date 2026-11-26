import { Router } from 'express';
import { z } from 'zod';
import { record } from './activity.js';
import { adminUserDto, hashPassword, requireRole, revokeSessions, roles, temporaryPassword, viewer, type Services, type UserRow } from './auth.js';
import { transaction } from './db.js';
import { ApiError, conflictOn, data, email, empty, id, invalid, notFound, optionalText, pageFields, paged, read, safeText } from './http.js';

const userCreate = z.strictObject({ email, displayName: safeText(120), role: z.enum(roles) });
const userEdit = z.strictObject({ displayName: safeText(120).optional(), isActive: z.boolean().optional(), role: z.enum(roles).optional() });
const userFilter = z.strictObject({
  ...pageFields, q: optionalText(254), role: z.enum(roles).optional(),
  isActive: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
});
const roleNames = { ADMIN: 'Administrator', OFFICER: 'Admissions officer', VIEWER: 'Read-only viewer' } as const;

export function userRoutes({ pool, clock }: Services) {
  const router = Router();
  router.use('/users', requireRole('ADMIN'));

  router.get('/users', async (req, res) => {
    const { q, role, isActive, page, pageSize } = read(userFilter, req.query);
    const filter = `FROM users WHERE ($1::text IS NULL OR strpos(lower(display_name), lower($1)) > 0 OR strpos(email_normalized, lower($1)) > 0)
        AND ($2::text IS NULL OR role = $2) AND ($3::boolean IS NULL OR is_active = $3)`;
    const args = [q ?? null, role ?? null, isActive ?? null];
    const [rows, total] = await Promise.all([
      pool.query<UserRow>(`SELECT * ${filter} ORDER BY display_name, id LIMIT $4 OFFSET $5`, [...args, pageSize, (page - 1) * pageSize]),
      pool.query<{ total: number }>('SELECT count(*)::int AS total ' + filter, args),
    ]);
    paged(res, rows.rows.map(adminUserDto), total.rows[0].total, page, pageSize);
  });

  router.post('/users', async (req, res) => {
    const input = read(userCreate, req.body);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const user = await transaction(pool, async db => {
      const { rows: [row] } = await db.query<UserRow>(
        'INSERT INTO users (email_normalized, display_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING *',
        [input.email, input.displayName, input.role, passwordHash],
      ).catch(error => conflictOn(error, 'users_email_normalized_key', 'DUPLICATE_EMAIL', 'This email is already in use.'));
      await record(db, viewer(res).user.id, 'USER_CREATED', 'USER', row.id, `Created ${roleNames[row.role].toLowerCase()} account for ${row.display_name}`, { role: row.role });
      return row;
    });
    data(res, { user: adminUserDto(user), temporaryPassword: password }, 201);
  });

  router.patch('/users/:userId', async (req, res) => {
    const userId = id(req, 'userId');
    const input = read(userEdit, req.body);
    if (input.displayName === undefined && input.isActive === undefined && input.role === undefined) invalid('Provide at least one change.');
    const self = viewer(res).user.id === userId;
    if (self && (input.isActive === false || (input.role && input.role !== 'ADMIN'))) {
      throw new ApiError(403, 'FORBIDDEN', 'You cannot deactivate or demote your own account.');
    }
    const user = await transaction(pool, async db => {
      const current = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR NO KEY UPDATE', [userId])).rows[0];
      if (!current) notFound();
      const now = await clock(db);
      const { rows: [updated] } = await db.query<UserRow>(
        'UPDATE users SET display_name = coalesce($2, display_name), is_active = coalesce($3, is_active), role = coalesce($4, role), updated_at = $5 WHERE id = $1 RETURNING *',
        [userId, input.displayName ?? null, input.isActive ?? null, input.role ?? null, now],
      );
      // Role and access changes take effect immediately: existing sessions end.
      if ((current.is_active && !updated.is_active) || current.role !== updated.role) await revokeSessions(db, userId, now);
      if (current.is_active !== updated.is_active) {
        await record(db, viewer(res).user.id, updated.is_active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED', 'USER', userId, `${updated.is_active ? 'Reactivated' : 'Deactivated'} ${updated.display_name}`);
      }
      if (current.role !== updated.role) {
        await record(db, viewer(res).user.id, 'USER_ROLE_CHANGED', 'USER', userId, `Changed ${updated.display_name}'s role to ${roleNames[updated.role].toLowerCase()}`, { from: current.role, to: updated.role });
      }
      if (current.display_name !== updated.display_name) await record(db, viewer(res).user.id, 'USER_UPDATED', 'USER', userId, `Renamed account to ${updated.display_name}`);
      return updated;
    });
    data(res, adminUserDto(user));
  });

  router.post('/users/:userId/reset-password', async (req, res) => {
    const userId = id(req, 'userId');
    read(empty, req.body ?? {});
    if (viewer(res).user.id === userId) throw new ApiError(403, 'FORBIDDEN', 'Change your own password from Settings instead.');
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    const user = await transaction(pool, async db => {
      const current = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!current) notFound();
      const now = await clock(db);
      const { rows: [row] } = await db.query<UserRow>('UPDATE users SET password_hash = $2, must_change_password = true, updated_at = $3 WHERE id = $1 RETURNING *', [userId, passwordHash, now]);
      await revokeSessions(db, userId, now);
      await record(db, viewer(res).user.id, 'USER_PASSWORD_RESET', 'USER', userId, `Reset the password for ${row.display_name}`);
      return row;
    });
    data(res, { user: adminUserDto(user), temporaryPassword: password });
  });

  return router;
}
