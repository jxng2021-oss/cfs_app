import { Router } from 'express';
import { z } from 'zod';
import { changedFields, record } from './activity.js';
import { requireRole, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import { intakeStatuses, intakeTransitions, type IntakeStatus } from './domain.js';
import { ApiError, conflictOn, data, direction, id, invalid, notFound, optionalText, orderBy, pageFields, paged, read, safeText, version } from './http.js';
import { getProgramme } from './programmes.js';
import { funnel, statusCounts } from './stats.js';

export type IntakeRow = {
  id: string; programme_id: string; name: string; academic_year: string; opens_at: Date; closes_at: Date; commences_on: string;
  capacity: number; status: IntakeStatus; version: number; created_at: Date; updated_at: Date;
  programme_code?: string; programme_name?: string; enrolled?: number; accepted?: number; applications?: number;
};

const when = z.iso.datetime({ offset: true }).transform(value => new Date(value));
const base = {
  programmeId: z.uuid(),
  name: safeText(120),
  academicYear: z.string().regex(/^[0-9]{4}\/[0-9]{4}$/, 'Use the format 2026/2027').refine(value => Number(value.slice(5)) === Number(value.slice(0, 4)) + 1, 'The second year must follow the first'),
  opensAt: when,
  closesAt: when,
  commencesOn: z.iso.date(),
  capacity: z.number().int().min(1, 'Capacity must be at least 1').max(100000),
};
const fields = z.strictObject(base);
const edit = z.strictObject(base).omit({ programmeId: true }).partial().extend({ version });
const filters = z.strictObject({
  ...pageFields,
  q: optionalText(120),
  status: z.enum(intakeStatuses).optional(),
  programmeId: z.uuid().optional(),
  academicYear: z.string().regex(/^[0-9]{4}\/[0-9]{4}$/).optional(),
  sort: z.enum(['name', 'programme', 'academicYear', 'opensAt', 'closesAt', 'capacity', 'status', 'utilisation']).default('opensAt'),
  dir: direction.default('desc'),
});

const select = `SELECT i.*, p.code AS programme_code, p.name AS programme_name,
  (SELECT count(*)::int FROM applications a WHERE a.intake_id = i.id AND a.status = 'ENROLLED') AS enrolled,
  (SELECT count(*)::int FROM applications a WHERE a.intake_id = i.id AND a.status = 'OFFER_ACCEPTED') AS accepted,
  (SELECT count(*)::int FROM applications a WHERE a.intake_id = i.id AND a.status <> 'DRAFT') AS applications
  FROM admission_intakes i JOIN programmes p ON p.id = i.programme_id`;

export function intakeDto(row: IntakeRow) {
  const enrolled = row.enrolled ?? 0;
  return {
    id: row.id, programmeId: row.programme_id, programmeCode: row.programme_code, programmeName: row.programme_name,
    name: row.name, academicYear: row.academic_year, opensAt: row.opens_at, closesAt: row.closes_at, commencesOn: row.commences_on,
    capacity: row.capacity, status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
    enrolled, acceptedOffers: row.accepted ?? 0, applications: row.applications ?? 0,
    remainingCapacity: Math.max(0, row.capacity - enrolled),
    utilisation: row.capacity ? Math.round((enrolled / row.capacity) * 10_000) / 100 : null,
  };
}

export async function getIntake(db: Db, intakeId: string, lock = false) {
  const row = (await db.query<IntakeRow>(`SELECT * FROM admission_intakes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [intakeId])).rows[0];
  if (!row) notFound();
  return row;
}

function validateDates(opensAt: Date, closesAt: Date, commencesOn: string) {
  if (closesAt <= opensAt) invalid('The closing date must be after the opening date.', { closesAt: 'Must be after the opening date' });
  if (new Date(commencesOn + 'T23:59:59+08:00') < closesAt) invalid('The programme must commence on or after the application closing date.', { commencesOn: 'Must be on or after the closing date' });
}

export function intakeRoutes({ pool }: Services) {
  const router = Router();
  const admin = requireRole('ADMIN');

  router.get('/intakes', async (req, res) => {
    const query = read(filters, req.query);
    const where = `WHERE ($1::text IS NULL OR i.name ILIKE '%' || $1 || '%' OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR i.status = $2) AND ($3::uuid IS NULL OR i.programme_id = $3) AND ($4::text IS NULL OR i.academic_year = $4)`;
    const args = [query.q ?? null, query.status ?? null, query.programmeId ?? null, query.academicYear ?? null];
    const sort = orderBy({ name: 'name', programme: 'programme_code', academicYear: 'academic_year', opensAt: 'opens_at', closesAt: 'closes_at',
      capacity: 'capacity', status: 'status', utilisation: 'enrolled::numeric / capacity' }, query.sort, query.dir, 'id');
    const [rows, total] = await Promise.all([
      pool.query<IntakeRow>(`SELECT * FROM (${select} ${where}) i ${sort} LIMIT $5 OFFSET $6`, [...args, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM admission_intakes i JOIN programmes p ON p.id = i.programme_id ${where}`, args),
    ]);
    paged(res, rows.rows.map(intakeDto), total.rows[0].total, query.page, query.pageSize);
  });

  router.get('/intakes/years', async (_req, res) => {
    const { rows } = await pool.query<{ year: string }>('SELECT DISTINCT academic_year AS year FROM admission_intakes ORDER BY 1 DESC');
    data(res, rows.map(row => row.year));
  });

  router.get('/intakes/:intakeId', async (req, res) => {
    const intakeId = id(req, 'intakeId');
    const row = (await pool.query<IntakeRow>(select + ' WHERE i.id = $1', [intakeId])).rows[0];
    if (!row) notFound();
    const [summary, statuses] = await Promise.all([funnel(pool, { intakeId }), statusCounts(pool, { intakeId })]);
    data(res, { ...intakeDto(row), allowedStatuses: intakeTransitions[row.status], stats: { ...summary, statuses } });
  });

  router.post('/intakes', admin, async (req, res) => {
    const input = read(fields, req.body);
    validateDates(input.opensAt, input.closesAt, input.commencesOn);
    const actor = viewer(res).user.id;
    const created = await transaction(pool, async db => {
      const programme = await getProgramme(db, input.programmeId);
      if (programme.status !== 'ACTIVE') throw new ApiError(409, 'INVALID_STATE', 'Intakes can only be created for active programmes.');
      const { rows: [row] } = await db.query<IntakeRow>(
        `INSERT INTO admission_intakes (programme_id, name, academic_year, opens_at, closes_at, commences_on, capacity)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [input.programmeId, input.name, input.academicYear, input.opensAt, input.closesAt, input.commencesOn, input.capacity],
      ).catch(error => conflictOn(error, 'admission_intakes_programme_id_name_key', 'DUPLICATE_INTAKE', 'This programme already has an intake with that name.'));
      await record(db, actor, 'INTAKE_CREATED', 'INTAKE', row.id, `Created intake ${row.name} for ${programme.code} (capacity ${row.capacity})`);
      return row;
    });
    data(res, intakeDto(created), 201);
  });

  router.patch('/intakes/:intakeId', admin, async (req, res) => {
    const intakeId = id(req, 'intakeId');
    const input = read(edit, req.body);
    const actor = viewer(res).user.id;
    const updated = await transaction(pool, async db => {
      const current = await getIntake(db, intakeId, true);
      if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This intake changed since you opened it. Reload and try again.');
      if (['COMPLETED', 'CANCELLED'].includes(current.status)) throw new ApiError(409, 'INVALID_STATE', 'Completed and cancelled intakes are read-only.');
      const next = {
        name: input.name ?? current.name, academic_year: input.academicYear ?? current.academic_year, opens_at: input.opensAt ?? current.opens_at,
        closes_at: input.closesAt ?? current.closes_at, commences_on: input.commencesOn ?? current.commences_on, capacity: input.capacity ?? current.capacity,
      };
      validateDates(next.opens_at, next.closes_at, String(next.commences_on));
      if (input.capacity !== undefined) {
        const { rows: [{ enrolled }] } = await db.query<{ enrolled: number }>("SELECT count(*)::int AS enrolled FROM applications WHERE intake_id = $1 AND status = 'ENROLLED'", [intakeId]);
        if (input.capacity < enrolled) invalid(`Capacity cannot be below the ${enrolled} confirmed enrolments.`, { capacity: 'Below confirmed enrolments' });
      }
      const changed = changedFields({ ...current, opens_at: current.opens_at.toISOString(), closes_at: current.closes_at.toISOString() } as unknown as Record<string, unknown>,
        { ...next, opens_at: next.opens_at.toISOString(), closes_at: next.closes_at.toISOString() });
      const { rows: [row] } = await db.query<IntakeRow>(
        `UPDATE admission_intakes SET name = $2, academic_year = $3, opens_at = $4, closes_at = $5, commences_on = $6, capacity = $7,
           version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [intakeId, next.name, next.academic_year, next.opens_at, next.closes_at, next.commences_on, next.capacity],
      ).catch(error => conflictOn(error, 'admission_intakes_programme_id_name_key', 'DUPLICATE_INTAKE', 'This programme already has an intake with that name.'));
      if (changed.length) await record(db, actor, 'INTAKE_UPDATED', 'INTAKE', row.id, `Updated intake ${row.name}`, { fields: changed.join(', ') });
      return row;
    });
    data(res, intakeDto(updated));
  });

  router.post('/intakes/:intakeId/status', admin, async (req, res) => {
    const intakeId = id(req, 'intakeId');
    const input = read(z.strictObject({ status: z.enum(intakeStatuses), version }), req.body);
    const actor = viewer(res).user.id;
    const updated = await transaction(pool, async db => {
      const current = await getIntake(db, intakeId, true);
      if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This intake changed since you opened it. Reload and try again.');
      if (!intakeTransitions[current.status].includes(input.status)) {
        throw new ApiError(409, 'INVALID_TRANSITION', `An intake that is ${current.status.toLowerCase()} cannot become ${input.status.toLowerCase()}.`);
      }
      if (input.status === 'OPEN') {
        const programme = await getProgramme(db, current.programme_id);
        if (programme.status !== 'ACTIVE') throw new ApiError(409, 'INVALID_STATE', 'Reactivate the programme before opening admissions.');
      }
      const { rows: [row] } = await db.query<IntakeRow>(
        'UPDATE admission_intakes SET status = $2, version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *', [intakeId, input.status]);
      const verb = { OPEN: 'Opened admissions for', CLOSED: 'Closed admissions for', COMPLETED: 'Completed', CANCELLED: 'Cancelled', UPCOMING: 'Reset' }[input.status];
      await record(db, actor, 'INTAKE_STATUS_CHANGED', 'INTAKE', row.id, `${verb} intake ${row.name}`, { from: current.status, to: input.status });
      return row;
    });
    data(res, intakeDto(updated));
  });

  router.delete('/intakes/:intakeId', admin, async (req, res) => {
    const intakeId = id(req, 'intakeId');
    await transaction(pool, async db => {
      const row = await getIntake(db, intakeId, true);
      if ((await db.query('SELECT 1 FROM applications WHERE intake_id = $1 LIMIT 1', [intakeId])).rowCount) {
        throw new ApiError(409, 'HAS_HISTORY', 'This intake has applications. Cancel or complete it instead.');
      }
      await db.query('DELETE FROM admission_intakes WHERE id = $1', [intakeId]);
      await record(db, viewer(res).user.id, 'INTAKE_DELETED', 'INTAKE', intakeId, `Deleted unused intake ${row.name}`);
    });
    res.status(204).end();
  });

  return router;
}
