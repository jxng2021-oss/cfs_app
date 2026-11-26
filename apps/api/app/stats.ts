import { z } from 'zod';
import type { Db } from './db.js';
import { applicationStatuses, rate } from './domain.js';
import { invalid } from './http.js';

export const statsFilters = z.strictObject({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  academicYear: z.string().regex(/^[0-9]{4}\/[0-9]{4}$/).optional(),
  faculty: z.string().trim().min(1).max(120).optional(),
  programmeId: z.uuid().optional(),
  intakeId: z.uuid().optional(),
  status: z.enum(applicationStatuses).optional(),
});
export type StatsFilters = z.infer<typeof statsFilters>;

export const statsFrom = `FROM applications a
  JOIN programmes p ON p.id = a.programme_id
  JOIN admission_intakes i ON i.id = a.intake_id
  JOIN applicants ap ON ap.id = a.applicant_id`;

/**
 * WHERE clause for the shared filters. Date ranges apply to the submission date in Singapore time, so drafts
 * (never submitted) drop out of any date-filtered view.
 */
export function statsWhere(filters: StatsFilters, offset = 0) {
  if (filters.from && filters.to && filters.from > filters.to) invalid('The end date must be on or after the start date.');
  const args = [filters.from ?? null, filters.to ?? null, filters.academicYear ?? null, filters.faculty ?? null,
    filters.programmeId ?? null, filters.intakeId ?? null, filters.status ?? null];
  const n = (index: number) => '$' + (index + offset);
  const where = `WHERE (${n(1)}::date IS NULL OR (a.submitted_at AT TIME ZONE 'Asia/Singapore')::date >= ${n(1)}::date)
    AND (${n(2)}::date IS NULL OR (a.submitted_at AT TIME ZONE 'Asia/Singapore')::date <= ${n(2)}::date)
    AND (${n(3)}::text IS NULL OR i.academic_year = ${n(3)}) AND (${n(4)}::text IS NULL OR p.faculty = ${n(4)})
    AND (${n(5)}::uuid IS NULL OR a.programme_id = ${n(5)}) AND (${n(6)}::uuid IS NULL OR a.intake_id = ${n(6)})
    AND (${n(7)}::text IS NULL OR a.status = ${n(7)})`;
  return { where, args };
}

const reached = (status: string) => `EXISTS (SELECT 1 FROM application_status_history h WHERE h.application_id = a.id AND h.to_status = '${status}')`;

/**
 * Funnel counts and rates. Definitions:
 * - submitted: applications that have left Draft.
 * - offered: applications that were ever issued an offer (even if later accepted, declined or withdrawn).
 * - offerRate = offered / submitted; acceptanceRate = accepted offers / offered; rejectionRate = rejected / submitted;
 *   enrolmentRate = enrolled / submitted.
 * - averageProcessingDays: submission to first decision (offer, waitlist or rejection), over decided applications.
 */
export async function funnel(db: Db, filters: StatsFilters) {
  const { where, args } = statsWhere(filters);
  const { rows: [row] } = await db.query<{
    total: number; submitted: number; pending: number; offered: number; accepted: number; declined: number; rejected: number;
    enrolled: number; withdrawn: number; processing_days: string | null;
  }>(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE a.submitted_at IS NOT NULL)::int AS submitted,
      count(*) FILTER (WHERE a.status IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED'))::int AS pending,
      count(*) FILTER (WHERE ${reached('OFFER_ISSUED')})::int AS offered,
      count(*) FILTER (WHERE ${reached('OFFER_ACCEPTED')})::int AS accepted,
      count(*) FILTER (WHERE a.status = 'OFFER_DECLINED')::int AS declined,
      count(*) FILTER (WHERE a.status = 'REJECTED')::int AS rejected,
      count(*) FILTER (WHERE a.status = 'ENROLLED')::int AS enrolled,
      count(*) FILTER (WHERE a.status = 'WITHDRAWN')::int AS withdrawn,
      round(avg(extract(epoch FROM (a.decided_at - a.submitted_at)) / 86400) FILTER (WHERE a.decided_at IS NOT NULL AND a.submitted_at IS NOT NULL), 1)::text AS processing_days
    ${statsFrom} ${where}`, args);
  return {
    totalApplications: row.total,
    submitted: row.submitted,
    pending: row.pending,
    offersIssued: row.offered,
    offersAccepted: row.accepted,
    offersDeclined: row.declined,
    rejected: row.rejected,
    enrolled: row.enrolled,
    withdrawn: row.withdrawn,
    offerRate: rate(row.offered, row.submitted),
    acceptanceRate: rate(row.accepted, row.offered),
    rejectionRate: rate(row.rejected, row.submitted),
    enrolmentRate: rate(row.enrolled, row.submitted),
    averageProcessingDays: row.processing_days === null ? null : Number(row.processing_days),
  };
}

export async function statusCounts(db: Db, filters: StatsFilters) {
  const { where, args } = statsWhere(filters);
  const { rows } = await db.query<{ status: string; count: number }>(`SELECT a.status, count(*)::int AS count ${statsFrom} ${where} GROUP BY a.status`, args);
  const counts = new Map(rows.map(row => [row.status, row.count]));
  return applicationStatuses.map(status => ({ status, count: counts.get(status) ?? 0 }));
}

/** Group counts by an expression, largest first. */
export async function breakdown(db: Db, filters: StatsFilters, key: string, label: string, limit = 12) {
  const { where, args } = statsWhere(filters);
  const { rows } = await db.query<{ key: string; label: string; count: number }>(
    `SELECT ${key} AS key, ${label} AS label, count(*)::int AS count ${statsFrom} ${where}
     GROUP BY 1, 2 ORDER BY count DESC, label LIMIT ${Number(limit)}`, args);
  return rows;
}

/** Submissions per week or month (Singapore time), filling empty periods with zero. */
export async function submissionsOverTime(db: Db, filters: StatsFilters, period: 'week' | 'month', fallbackFrom: string, fallbackTo: string) {
  const { where, args } = statsWhere(filters);
  const from = filters.from ?? fallbackFrom;
  const to = filters.to ?? fallbackTo;
  const step = period === 'week' ? '1 week' : '1 month';
  const { rows } = await db.query<{ period: string; count: number }>(
    `WITH series AS (
       SELECT generate_series(date_trunc('${period}', $${args.length + 1}::date), date_trunc('${period}', $${args.length + 2}::date), interval '${step}')::date AS period
     ), counts AS (
       SELECT date_trunc('${period}', a.submitted_at AT TIME ZONE 'Asia/Singapore')::date AS period, count(*)::int AS count
       ${statsFrom} ${where} AND a.submitted_at IS NOT NULL GROUP BY 1
     )
     SELECT to_char(s.period, 'YYYY-MM-DD') AS period, coalesce(c.count, 0)::int AS count
     FROM series s LEFT JOIN counts c ON c.period = s.period ORDER BY s.period`, [...args, from, to]);
  return rows;
}

/**
 * Capacity per intake: utilisation = confirmed enrolments / capacity. Accepted offers are shown separately because
 * they are likely, but not yet confirmed, enrolments.
 */
export async function intakeUtilisation(db: Db, filters: Pick<StatsFilters, 'academicYear' | 'faculty' | 'programmeId' | 'intakeId'>, limit = 12) {
  const { rows } = await db.query<{ id: string; name: string; programme: string; capacity: number; enrolled: number; accepted: number; applications: number; status: string }>(
    `SELECT i.id, i.name, p.code AS programme, i.capacity, i.status,
       count(a.*) FILTER (WHERE a.status = 'ENROLLED')::int AS enrolled,
       count(a.*) FILTER (WHERE a.status = 'OFFER_ACCEPTED')::int AS accepted,
       count(a.*) FILTER (WHERE a.status <> 'DRAFT')::int AS applications
     FROM admission_intakes i JOIN programmes p ON p.id = i.programme_id LEFT JOIN applications a ON a.intake_id = i.id
     WHERE i.status <> 'CANCELLED' AND ($1::text IS NULL OR i.academic_year = $1) AND ($2::text IS NULL OR p.faculty = $2)
       AND ($3::uuid IS NULL OR i.programme_id = $3) AND ($4::uuid IS NULL OR i.id = $4)
     GROUP BY i.id, p.code ORDER BY i.opens_at DESC, i.name LIMIT ${Number(limit)}`,
    [filters.academicYear ?? null, filters.faculty ?? null, filters.programmeId ?? null, filters.intakeId ?? null]);
  return rows.map(row => ({ ...row, utilisation: rate(row.enrolled, row.capacity), remaining: Math.max(0, row.capacity - row.enrolled) }));
}
