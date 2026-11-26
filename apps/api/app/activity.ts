import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import type { Db } from './db.js';
import { invalid, pageFields, paged, read } from './http.js';

export const entityTypes = ['APPLICANT', 'APPLICATION', 'PROGRAMME', 'INTAKE', 'SETTING', 'USER'] as const;
export type EntityType = typeof entityTypes[number];
type Metadata = Record<string, string | number | boolean | null>;

/**
 * Append an activity record. Descriptions are human-readable; metadata holds changed field names and values
 * that are safe to show (never passwords, tokens or credentials).
 */
export async function record(db: Db, actorId: string | null, action: string, entityType: EntityType, entityId: string | null, description: string, metadata: Metadata = {}) {
  await db.query(
    'INSERT INTO audit_events (actor_id, event_type, entity_type, entity_id, description, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, action, entityType, entityId, description.slice(0, 500), metadata],
  );
}

/** Field names whose values differ between two records, for change metadata. */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>) {
  return Object.keys(after).filter(key => after[key] !== undefined && String(after[key] ?? '') !== String(before[key] ?? ''));
}

const filters = z.strictObject({
  ...pageFields,
  q: z.string().trim().max(120).optional(),
  action: z.string().trim().max(60).optional(),
  entityType: z.enum(entityTypes).optional(),
  actorId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  sort: z.enum(['newest', 'oldest']).default('newest'),
});

const select = `SELECT e.id, e.event_type "action", e.entity_type "entityType", e.entity_id "entityId", e.description,
  e.occurred_at "occurredAt", e.metadata, u.id "actorId", u.display_name "actorName"`;

export function activityRoutes({ pool }: Services) {
  const router = Router();

  // The full log is an administrator tool; the history of a single record is visible to anyone who can see that record.
  router.get('/activity', requireRole('ADMIN'), async (req, res) => {
    const query = read(filters, req.query);
    if (query.from && query.to && new Date(query.from) >= new Date(query.to)) invalid('The end of the date range must follow the start.');
    const where = `FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE ($1::text IS NULL OR e.description ILIKE '%' || $1 || '%' OR e.event_type ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR e.event_type = $2) AND ($3::text IS NULL OR e.entity_type = $3) AND ($4::uuid IS NULL OR e.actor_id = $4)
        AND ($5::timestamptz IS NULL OR e.occurred_at >= $5) AND ($6::timestamptz IS NULL OR e.occurred_at < $6)`;
    const args = [query.q || null, query.action || null, query.entityType ?? null, query.actorId ?? null, query.from ?? null, query.to ?? null];
    const order = query.sort === 'oldest' ? 'e.occurred_at ASC, e.id' : 'e.occurred_at DESC, e.id';
    const [rows, total] = await Promise.all([
      pool.query(`${select} ${where} ORDER BY ${order} LIMIT $7 OFFSET $8`, [...args, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query<{ total: number }>('SELECT count(*)::int AS total ' + where, args),
    ]);
    paged(res, rows.rows, total.rows[0].total, query.page, query.pageSize);
  });

  router.get('/activity/actions', requireRole('ADMIN'), async (_req, res) => {
    const { rows } = await pool.query<{ action: string }>('SELECT DISTINCT event_type AS action FROM audit_events ORDER BY 1');
    res.json({ data: rows.map(row => row.action) });
  });

  router.get('/activity/:entityType/:entityId', async (req, res) => {
    const entityType = read(z.enum(entityTypes), req.params.entityType);
    const entityId = read(z.uuid(), req.params.entityId);
    const { rows } = await pool.query(`${select} FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id
      WHERE e.entity_type = $1 AND e.entity_id = $2 ORDER BY e.occurred_at DESC, e.id LIMIT 100`, [entityType, entityId]);
    res.json({ data: rows });
  });

  return router;
}
