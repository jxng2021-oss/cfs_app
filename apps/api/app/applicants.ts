import { Router, type Request } from 'express';
import { z } from 'zod';
import { changedFields, record } from './activity.js';
import { requireEditor, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import { applicantStatuses, qualifications } from './domain.js';
import { ApiError, conflictOn, data, direction, email, id, invalid, notFound, optionalText, orderBy, pageFields, paged, read, safeText, version } from './http.js';

export type ApplicantRow = {
  id: string; applicant_number: string; first_name: string; last_name: string; email: string; phone: string; date_of_birth: string;
  nationality: string; address: string; previous_institution: string; highest_qualification: typeof qualifications[number]; gpa: string | null;
  status: typeof applicantStatuses[number]; remarks: string; version: number; created_at: Date; updated_at: Date; archived_at: Date | null;
  application_count?: number;
};

const gpa = z.union([z.number(), z.string()]).transform(value => Number(value)).pipe(z.number().min(0).max(4)).transform(value => value.toFixed(2));
const base = {
  firstName: safeText(80),
  lastName: safeText(80),
  email,
  phone: z.string().trim().regex(/^\+?[0-9 ()-]{7,20}$/, 'Use 7–20 digits, spaces, brackets or hyphens'),
  dateOfBirth: z.iso.date().refine(value => {
    const age = (Date.now() - Date.parse(value)) / (365.25 * 86_400_000);
    return age >= 14 && age <= 100;
  }, 'Applicants must be between 14 and 100 years old'),
  nationality: safeText(60),
  address: safeText(300),
  previousInstitution: safeText(160),
  highestQualification: z.enum(qualifications),
  gpa: gpa.nullable(),
  status: z.enum(['ACTIVE', 'ON_HOLD']),
  remarks: z.string().trim().max(4000),
};
const fields = z.strictObject({ ...base, gpa: base.gpa.default(null), status: base.status.default('ACTIVE'), remarks: base.remarks.default('') });
const edit = z.strictObject(base).partial().extend({ version });
const listFilters = {
  q: optionalText(120),
  status: z.enum(applicantStatuses).optional(),
  nationality: optionalText(60),
  qualification: z.enum(qualifications).optional(),
  includeArchived: z.enum(['true', 'false']).transform(value => value === 'true').default(false),
};
const filters = z.strictObject({
  ...pageFields, ...listFilters,
  sort: z.enum(['applicantNumber', 'name', 'email', 'nationality', 'qualification', 'gpa', 'status', 'createdAt', 'applications']).default('createdAt'),
  dir: direction.default('desc'),
});
const exportFilters = z.strictObject({ ...listFilters, ids: z.string().optional() });

export function applicantDto(row: ApplicantRow) {
  return {
    id: row.id, applicantNumber: row.applicant_number, firstName: row.first_name, lastName: row.last_name,
    fullName: row.first_name + ' ' + row.last_name, email: row.email, phone: row.phone, dateOfBirth: row.date_of_birth,
    nationality: row.nationality, address: row.address, previousInstitution: row.previous_institution,
    highestQualification: row.highest_qualification, gpa: row.gpa, status: row.status, remarks: row.remarks, version: row.version,
    createdAt: row.created_at, updatedAt: row.updated_at, archivedAt: row.archived_at,
    ...(row.application_count !== undefined ? { applicationCount: row.application_count } : {}),
  };
}

export async function getApplicant(db: Db, applicantId: string, lock = false) {
  const row = (await db.query<ApplicantRow>(`SELECT * FROM applicants WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [applicantId])).rows[0];
  if (!row) notFound();
  return row;
}

const columns = {
  firstName: 'first_name', lastName: 'last_name', email: 'email', phone: 'phone', dateOfBirth: 'date_of_birth', nationality: 'nationality',
  address: 'address', previousInstitution: 'previous_institution', highestQualification: 'highest_qualification', gpa: 'gpa', status: 'status', remarks: 'remarks',
} as const;

function where(query: z.infer<z.ZodObject<typeof listFilters>>) {
  return {
    sql: `WHERE ($1::text IS NULL OR a.applicant_number ILIKE '%' || $1 || '%' OR (a.first_name || ' ' || a.last_name) ILIKE '%' || $1 || '%' OR a.email ILIKE '%' || $1 || '%' OR a.phone ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR a.status = $2) AND ($2::text IS NOT NULL OR $5::boolean OR a.status <> 'ARCHIVED')
      AND ($3::text IS NULL OR a.nationality = $3) AND ($4::text IS NULL OR a.highest_qualification = $4)`,
    args: [query.q ?? null, query.status ?? null, query.nationality ?? null, query.qualification ?? null, query.includeArchived],
  };
}

const withCount = `SELECT a.*, (SELECT count(*)::int FROM applications x WHERE x.applicant_id = a.id) AS application_count FROM applicants a`;
const csvCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  // Prefix formula-like values so spreadsheet software treats them as text.
  const safe = /^[=+\-@\t\r]/.test(text) ? "'" + text : text;
  return /[",\n\r]/.test(safe) ? '"' + safe.replaceAll('"', '""') + '"' : safe;
};

export function applicantRoutes({ pool }: Services) {
  const router = Router();

  router.get('/applicants', async (req, res) => {
    const query = read(filters, req.query);
    const { sql, args } = where(query);
    const sort = orderBy({ applicantNumber: 'applicant_number', name: 'last_name, first_name', email: 'email', nationality: 'nationality',
      qualification: 'highest_qualification', gpa: 'gpa', status: 'status', createdAt: 'created_at', applications: 'application_count' }, query.sort, query.dir, 'id');
    const [rows, total] = await Promise.all([
      pool.query<ApplicantRow>(`SELECT * FROM (${withCount} ${sql}) a ${sort} LIMIT $6 OFFSET $7`, [...args, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total FROM applicants a ${sql}`, args),
    ]);
    paged(res, rows.rows.map(applicantDto), total.rows[0].total, query.page, query.pageSize);
  });

  router.get('/applicants/nationalities', async (_req, res) => {
    const { rows } = await pool.query<{ nationality: string }>('SELECT DISTINCT nationality FROM applicants ORDER BY 1');
    data(res, rows.map(row => row.nationality));
  });

  // CSV of the selected applicants, or of every applicant matching the filters (up to 5,000).
  router.get('/applicants/export', async (req, res) => {
    const query = read(exportFilters, req.query);
    const ids = query.ids ? read(z.array(z.uuid()).max(500), query.ids.split(',')) : null;
    const { sql, args } = where(query);
    const { rows } = ids
      ? await pool.query<ApplicantRow>(`${withCount} WHERE a.id = ANY($1::uuid[]) ORDER BY a.applicant_number`, [ids])
      : await pool.query<ApplicantRow>(`${withCount} ${sql} ORDER BY a.applicant_number LIMIT 5000`, args);
    const header = ['Applicant ID', 'First name', 'Last name', 'Email', 'Phone', 'Date of birth', 'Nationality', 'Previous institution', 'Highest qualification', 'GPA', 'Status', 'Applications', 'Created'];
    const lines = [header, ...rows.map(row => [row.applicant_number, row.first_name, row.last_name, row.email, row.phone, row.date_of_birth, row.nationality,
      row.previous_institution, row.highest_qualification, row.gpa, row.status, row.application_count, row.created_at.toISOString()])];
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="applicants.csv"', 'Cache-Control': 'no-store' });
    res.send('﻿' + lines.map(line => line.map(csvCell).join(',')).join('\r\n'));
  });

  router.get('/applicants/:applicantId', async (req, res) => {
    const row = (await pool.query<ApplicantRow>(withCount + ' WHERE a.id = $1', [id(req, 'applicantId')])).rows[0];
    if (!row) notFound();
    data(res, applicantDto(row));
  });

  router.post('/applicants', requireEditor, async (req, res) => {
    const input = read(fields, req.body);
    const actor = viewer(res).user.id;
    const created = await transaction(pool, async db => {
      const { rows: [row] } = await db.query<ApplicantRow>(
        `INSERT INTO applicants (first_name, last_name, email, phone, date_of_birth, nationality, address, previous_institution,
           highest_qualification, gpa, status, remarks) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [input.firstName, input.lastName, input.email, input.phone, input.dateOfBirth, input.nationality, input.address,
          input.previousInstitution, input.highestQualification, input.gpa, input.status, input.remarks],
      ).catch(error => conflictOn(error, 'applicants_email_key', 'DUPLICATE_EMAIL', 'Another applicant already uses this email address.'));
      await record(db, actor, 'APPLICANT_CREATED', 'APPLICANT', row.id, `Created applicant ${row.applicant_number} · ${row.first_name} ${row.last_name}`);
      return row;
    });
    data(res, applicantDto(created), 201);
  });

  router.patch('/applicants/:applicantId', requireEditor, async (req, res) => {
    const applicantId = id(req, 'applicantId');
    const input = read(edit, req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    const actor = viewer(res).user.id;
    const updated = await transaction(pool, async db => {
      const current = await getApplicant(db, applicantId, true);
      if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This applicant changed since you opened it. Reload and try again.');
      if (current.status === 'ARCHIVED') throw new ApiError(409, 'INVALID_STATE', 'Restore this archived applicant before editing.');
      const provided = input as Record<string, unknown>;
      const next = Object.fromEntries(Object.entries(columns).map(([key, column]) => [column, key in provided ? provided[key] : (current as Record<string, unknown>)[column]]));
      const changed = changedFields(current as unknown as Record<string, unknown>, Object.fromEntries(Object.entries(columns).map(([key, column]) => [column, provided[key]])));
      const { rows: [row] } = await db.query<ApplicantRow>(
        `UPDATE applicants SET first_name = $2, last_name = $3, email = $4, phone = $5, date_of_birth = $6, nationality = $7, address = $8,
           previous_institution = $9, highest_qualification = $10, gpa = $11, status = $12, remarks = $13, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [applicantId, next.first_name, next.last_name, next.email, next.phone, next.date_of_birth, next.nationality, next.address,
          next.previous_institution, next.highest_qualification, next.gpa, next.status, next.remarks],
      ).catch(error => conflictOn(error, 'applicants_email_key', 'DUPLICATE_EMAIL', 'Another applicant already uses this email address.'));
      // Field names only: personal values are not copied into the activity log.
      if (changed.length) await record(db, actor, 'APPLICANT_UPDATED', 'APPLICANT', row.id, `Updated applicant ${row.applicant_number}`, { fields: changed.join(', ') });
      return row;
    });
    data(res, applicantDto(updated));
  });

  async function setArchived(req: Request, actor: string, archived: boolean) {
    const applicantId = id(req, 'applicantId');
    read(z.strictObject({ version }), req.body);
    return transaction(pool, async db => {
      const current = await getApplicant(db, applicantId, true);
      if (current.version !== req.body.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This applicant changed since you opened it. Reload and try again.');
      if (archived === (current.status === 'ARCHIVED')) throw new ApiError(409, 'INVALID_STATE', archived ? 'This applicant is already archived.' : 'This applicant is not archived.');
      if (archived) {
        const live = await db.query("SELECT 1 FROM applications WHERE applicant_id = $1 AND status NOT IN ('OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED') LIMIT 1", [applicantId]);
        if (live.rowCount) throw new ApiError(409, 'INVALID_STATE', 'Withdraw or finish this applicant’s open applications before archiving.');
      }
      const { rows: [row] } = await db.query<ApplicantRow>(
        `UPDATE applicants SET status = $2, archived_at = CASE WHEN $2 = 'ARCHIVED' THEN clock_timestamp() END, version = version + 1, updated_at = clock_timestamp() WHERE id = $1 RETURNING *`,
        [applicantId, archived ? 'ARCHIVED' : 'ACTIVE']);
      await record(db, actor, archived ? 'APPLICANT_ARCHIVED' : 'APPLICANT_RESTORED', 'APPLICANT', row.id, `${archived ? 'Archived' : 'Restored'} applicant ${row.applicant_number}`);
      return row;
    });
  }
  router.post('/applicants/:applicantId/archive', requireEditor, async (req, res) => data(res, applicantDto(await setArchived(req, viewer(res).user.id, true))));
  router.post('/applicants/:applicantId/restore', requireEditor, async (req, res) => data(res, applicantDto(await setArchived(req, viewer(res).user.id, false))));

  // Only applicants without any applications can be deleted; everyone else is archived to keep admission history intact.
  router.delete('/applicants/:applicantId', requireEditor, async (req, res) => {
    const applicantId = id(req, 'applicantId');
    await transaction(pool, async db => {
      const row = await getApplicant(db, applicantId, true);
      if ((await db.query('SELECT 1 FROM applications WHERE applicant_id = $1 LIMIT 1', [applicantId])).rowCount) {
        throw new ApiError(409, 'HAS_HISTORY', 'This applicant has applications. Archive the applicant instead.');
      }
      await db.query('DELETE FROM applicants WHERE id = $1', [applicantId]);
      await record(db, viewer(res).user.id, 'APPLICANT_DELETED', 'APPLICANT', applicantId, `Deleted applicant ${row.applicant_number}`);
    });
    res.status(204).end();
  });

  return router;
}
