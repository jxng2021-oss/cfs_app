import { Router } from 'express';
import { z } from 'zod';
import { changedFields, record } from './activity.js';
import { requireRole, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import { programmeStatuses, qualifications, qualificationTypes } from './domain.js';
import { ApiError, conflictOn, data, direction, id, notFound, optionalText, orderBy, pageFields, paged, read, safeText, version } from './http.js';
import { funnel, intakeUtilisation, statusCounts } from './stats.js';

export type ProgrammeRow = {
  id: string; code: string; name: string; faculty: string; qualification_type: string; description: string; duration_months: number;
  admission_requirements: string; minimum_qualification: typeof qualifications[number]; minimum_gpa: string | null;
  status: typeof programmeStatuses[number]; version: number; created_at: Date; updated_at: Date;
  intake_count?: number; application_count?: number;
};

const gpa = z.union([z.number(), z.string()]).transform(value => Number(value)).pipe(z.number().min(0).max(4)).transform(value => value.toFixed(2));
const base = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,16}$/, 'Use 2–16 letters, digits or hyphens'),
  name: safeText(160),
  faculty: safeText(120),
  qualificationType: z.enum(qualificationTypes),
  description: z.string().trim().max(4000),
  durationMonths: z.number().int().min(1).max(120),
  admissionRequirements: z.string().trim().max(4000),
  minimumQualification: z.enum(qualifications),
  minimumGpa: gpa.nullable(),
  status: z.enum(programmeStatuses),
};
const fields = z.strictObject({
  ...base,
  description: base.description.default(''),
  admissionRequirements: base.admissionRequirements.default(''),
  minimumGpa: base.minimumGpa.default(null),
  status: base.status.default('ACTIVE'),
});
const edit = z.strictObject(base).partial().extend({ version });
const filters = z.strictObject({
  ...pageFields,
  q: optionalText(120),
  status: z.enum(programmeStatuses).optional(),
  faculty: optionalText(120),
  qualificationType: z.enum(qualificationTypes).optional(),
  sort: z.enum(['code', 'name', 'faculty', 'status', 'applications', 'updatedAt']).default('code'),
  dir: direction,
});

export function programmeDto(row: ProgrammeRow) {
  return {
    id: row.id, code: row.code, name: row.name, faculty: row.faculty, qualificationType: row.qualification_type,
    description: row.description, durationMonths: row.duration_months, admissionRequirements: row.admission_requirements,
    minimumQualification: row.minimum_qualification, minimumGpa: row.minimum_gpa, status: row.status, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at,
    ...(row.intake_count !== undefined ? { intakeCount: row.intake_count, applicationCount: row.application_count } : {}),
  };
}

const withCounts = `SELECT p.*,
  (SELECT count(*)::int FROM admission_intakes i WHERE i.programme_id = p.id) AS intake_count,
  (SELECT count(*)::int FROM applications a WHERE a.programme_id = p.id) AS application_count
  FROM programmes p`;

export async function getProgramme(db: Db, programmeId: string, lock = false) {
  const row = (await db.query<ProgrammeRow>(`SELECT * FROM programmes WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [programmeId])).rows[0];
  if (!row) notFound();
  return row;
}

const labels = { code: 'code', name: 'name', faculty: 'faculty', qualificationType: 'qualification_type', description: 'description',
  durationMonths: 'duration_months', admissionRequirements: 'admission_requirements', minimumQualification: 'minimum_qualification',
  minimumGpa: 'minimum_gpa', status: 'status' } as const;

export function programmeRoutes({ pool }: Services) {
  const router = Router();
  const admin = requireRole('ADMIN');

  router.get('/programmes', async (req, res) => {
    const query = read(filters, req.query);
    const where = `WHERE ($1::text IS NULL OR p.code ILIKE '%' || $1 || '%' OR p.name ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR p.status = $2) AND ($3::text IS NULL OR p.faculty = $3) AND ($4::text IS NULL OR p.qualification_type = $4)`;
    const args = [query.q ?? null, query.status ?? null, query.faculty ?? null, query.qualificationType ?? null];
    const sort = orderBy({ code: 'p.code', name: 'p.name', faculty: 'p.faculty', status: 'p.status', applications: 'application_count', updatedAt: 'p.updated_at' }, query.sort, query.dir, 'p.id');
    const [rows, total] = await Promise.all([
      pool.query<ProgrammeRow>(`SELECT * FROM (${withCounts} ${where}) p ${sort} LIMIT $5 OFFSET $6`, [...args, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM programmes p ${where}`, args),
    ]);
    paged(res, rows.rows.map(programmeDto), total.rows[0].total, query.page, query.pageSize);
  });

  router.get('/programmes/faculties', async (_req, res) => {
    const { rows } = await pool.query<{ faculty: string }>('SELECT DISTINCT faculty FROM programmes ORDER BY faculty');
    data(res, rows.map(row => row.faculty));
  });

  router.get('/programmes/:programmeId', async (req, res) => {
    const programmeId = id(req, 'programmeId');
    const row = (await pool.query<ProgrammeRow>(withCounts + ' WHERE p.id = $1', [programmeId])).rows[0];
    if (!row) notFound();
    const [summary, statuses, intakes] = await Promise.all([
      funnel(pool, { programmeId }), statusCounts(pool, { programmeId }), intakeUtilisation(pool, { programmeId }, 50),
    ]);
    data(res, { ...programmeDto(row), stats: { ...summary, statuses }, intakes });
  });

  router.post('/programmes', admin, async (req, res) => {
    const input = read(fields, req.body);
    const actor = viewer(res).user.id;
    const created = await transaction(pool, async db => {
      const { rows: [row] } = await db.query<ProgrammeRow>(
        `INSERT INTO programmes (code, name, faculty, qualification_type, description, duration_months, admission_requirements,
           minimum_qualification, minimum_gpa, status) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
        [input.code, input.name, input.faculty, input.qualificationType, input.description, input.durationMonths,
          input.admissionRequirements, input.minimumQualification, input.minimumGpa, input.status],
      ).catch(error => conflictOn(error, 'programmes_code_key', 'DUPLICATE_CODE', 'Another programme already uses this code.'));
      await record(db, actor, 'PROGRAMME_CREATED', 'PROGRAMME', row.id, `Created programme ${row.code} · ${row.name}`);
      return row;
    });
    data(res, programmeDto(created), 201);
  });

  router.patch('/programmes/:programmeId', admin, async (req, res) => {
    const programmeId = id(req, 'programmeId');
    const input = read(edit, req.body);
    const actor = viewer(res).user.id;
    const updated = await transaction(pool, async db => {
      const current = await getProgramme(db, programmeId, true);
      if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This programme changed since you opened it. Reload and try again.');
      if (input.status === 'ARCHIVED' && current.status !== 'ARCHIVED') {
        const live = await db.query("SELECT 1 FROM admission_intakes WHERE programme_id = $1 AND status IN ('UPCOMING', 'OPEN') LIMIT 1", [programmeId]);
        if (live.rowCount) throw new ApiError(409, 'INVALID_STATE', 'Close or cancel this programme’s upcoming and open intakes before archiving it.');
      }
      const provided = input as Record<string, unknown>;
      const next = Object.fromEntries(Object.entries(labels).map(([key, column]) => [column, key in provided ? provided[key] : (current as Record<string, unknown>)[column]]));
      const changed = changedFields(current as unknown as Record<string, unknown>, Object.fromEntries(Object.entries(labels).map(([key, column]) => [column, provided[key]])));
      const { rows: [row] } = await db.query<ProgrammeRow>(
        `UPDATE programmes SET code = $2, name = $3, faculty = $4, qualification_type = $5, description = $6, duration_months = $7,
           admission_requirements = $8, minimum_qualification = $9, minimum_gpa = $10, status = $11, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [programmeId, next.code, next.name, next.faculty, next.qualification_type, next.description, next.duration_months,
          next.admission_requirements, next.minimum_qualification, next.minimum_gpa, next.status],
      ).catch(error => conflictOn(error, 'programmes_code_key', 'DUPLICATE_CODE', 'Another programme already uses this code.'));
      if (changed.length) {
        const archived = input.status === 'ARCHIVED' && current.status !== 'ARCHIVED';
        await record(db, actor, archived ? 'PROGRAMME_ARCHIVED' : 'PROGRAMME_UPDATED', 'PROGRAMME', row.id,
          `${archived ? 'Archived' : 'Updated'} programme ${row.code}`, { fields: changed.join(', '), ...(input.status && input.status !== current.status ? { status: `${current.status} → ${input.status}` } : {}) });
      }
      return row;
    });
    data(res, programmeDto(updated));
  });

  // Programmes with history are archived, never deleted; an unused programme created by mistake can be removed.
  router.delete('/programmes/:programmeId', admin, async (req, res) => {
    const programmeId = id(req, 'programmeId');
    await transaction(pool, async db => {
      const row = await getProgramme(db, programmeId, true);
      const used = await db.query('SELECT 1 FROM admission_intakes WHERE programme_id = $1 UNION ALL SELECT 1 FROM applications WHERE programme_id = $1 LIMIT 1', [programmeId]);
      if (used.rowCount) throw new ApiError(409, 'HAS_HISTORY', 'This programme has intakes or applications. Archive it instead.');
      await db.query('DELETE FROM programmes WHERE id = $1', [programmeId]);
      await record(db, viewer(res).user.id, 'PROGRAMME_DELETED', 'PROGRAMME', programmeId, `Deleted unused programme ${row.code}`);
    });
    res.status(204).end();
  });

  return router;
}
