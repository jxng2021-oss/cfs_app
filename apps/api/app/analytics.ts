import { Router } from 'express';
import { type Services, viewer } from './auth.js';
import { data, read } from './http.js';
import { loadSettings } from './settings.js';
import { breakdown, funnel, intakeUtilisation, statsFilters, statsFrom, statsWhere, statusCounts, submissionsOverTime } from './stats.js';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
const daysAgo = (days: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date(Date.now() - days * 86_400_000));

export function analyticsRoutes({ pool }: Services) {
  const router = Router();

  router.get('/dashboard', async (_req, res) => {
    const settings = await loadSettings(pool);
    const admin = viewer(res).user.role === 'ADMIN';
    const [summary, applicants, current, statuses, overTime, byProgramme, byIntake, utilisation, recent, attention, closing, offers, decisions, activity] = await Promise.all([
      funnel(pool, {}),
      pool.query<{ total: number }>("SELECT count(*)::int AS total FROM applicants WHERE status <> 'ARCHIVED'"),
      pool.query<{ status: string; count: number }>("SELECT status, count(*)::int AS count FROM applications WHERE status IN ('SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED') GROUP BY status"),
      statusCounts(pool, {}),
      submissionsOverTime(pool, { from: daysAgo(7 * 11), to: today() }, 'week', daysAgo(7 * 11), today()),
      breakdown(pool, {}, 'p.id::text', 'p.code', 8),
      breakdown(pool, {}, 'i.id::text', "p.code || ' · ' || i.name", 8),
      intakeUtilisation(pool, { academicYear: settings.defaultAcademicYear }, 8),
      pool.query(`SELECT a.id, a.reference, a.status, a.created_at "createdAt", ap.first_name || ' ' || ap.last_name AS "applicantName", p.code AS "programmeCode"
        FROM applications a JOIN applicants ap ON ap.id = a.applicant_id JOIN programmes p ON p.id = a.programme_id ORDER BY a.created_at DESC, a.id LIMIT 6`),
      pool.query(`SELECT id, reference, status, "applicantName", reason FROM (
          SELECT a.id, a.reference, a.status, a.updated_at, ap.first_name || ' ' || ap.last_name AS "applicantName", CASE
            WHEN a.status = 'SUBMITTED' AND a.submitted_at < clock_timestamp() - make_interval(days => $1) THEN 'Waiting for review beyond ' || $1 || ' days'
            WHEN a.status = 'INFO_REQUIRED' THEN 'Awaiting additional information'
            WHEN a.status = 'OFFER_ISSUED' AND a.offer_response_deadline < (clock_timestamp() AT TIME ZONE 'Asia/Singapore')::date THEN 'Offer response overdue'
            WHEN a.status = 'OFFER_ACCEPTED' THEN 'Ready to confirm enrolment'
            WHEN a.status = 'UNDER_REVIEW' AND a.reviewer_id IS NULL THEN 'No reviewer assigned'
          END AS reason
          FROM applications a JOIN applicants ap ON ap.id = a.applicant_id) x
        WHERE reason IS NOT NULL ORDER BY updated_at LIMIT 6`, [settings.reviewTargetDays]),
      pool.query(`SELECT i.id, i.name, p.code AS "programmeCode", i.closes_at AS "date" FROM admission_intakes i JOIN programmes p ON p.id = i.programme_id
        WHERE i.status = 'OPEN' AND i.closes_at BETWEEN clock_timestamp() AND clock_timestamp() + interval '45 days' ORDER BY i.closes_at LIMIT 5`),
      pool.query(`SELECT a.id, a.reference, ap.first_name || ' ' || ap.last_name AS "applicantName", a.offer_response_deadline AS "date"
        FROM applications a JOIN applicants ap ON ap.id = a.applicant_id
        WHERE a.status = 'OFFER_ISSUED' AND a.offer_response_deadline <= (clock_timestamp() AT TIME ZONE 'Asia/Singapore')::date + 14
        ORDER BY a.offer_response_deadline LIMIT 5`),
      pool.query(`SELECT h.id, a.id AS "applicationId", a.reference, h.to_status AS status, h.occurred_at AS "occurredAt",
          ap.first_name || ' ' || ap.last_name AS "applicantName", u.display_name AS "actorName"
        FROM application_status_history h JOIN applications a ON a.id = h.application_id JOIN applicants ap ON ap.id = a.applicant_id
        LEFT JOIN users u ON u.id = h.actor_id WHERE h.to_status IN ('OFFER_ISSUED', 'WAITLISTED', 'REJECTED', 'ENROLLED')
        ORDER BY h.occurred_at DESC, h.id LIMIT 6`),
      admin ? pool.query(`SELECT e.id, e.event_type "action", e.description, e.occurred_at "occurredAt", u.display_name "actorName"
        FROM audit_events e LEFT JOIN users u ON u.id = e.actor_id ORDER BY e.occurred_at DESC, e.id LIMIT 6`) : Promise.resolve({ rows: null }),
    ]);
    const live = new Map(current.rows.map(row => [row.status, row.count]));
    data(res, {
      cards: {
        totalApplicants: applicants.rows[0].total,
        totalApplications: summary.totalApplications,
        pendingReview: live.get('SUBMITTED') ?? 0,
        underReview: (live.get('UNDER_REVIEW') ?? 0) + (live.get('INFO_REQUIRED') ?? 0),
        offersIssued: summary.offersIssued,
        offersAccepted: summary.offersAccepted,
        rejected: summary.rejected,
        enrolled: summary.enrolled,
      },
      rates: { submitted: summary.submitted, offerRate: summary.offerRate, acceptanceRate: summary.acceptanceRate, rejectionRate: summary.rejectionRate, enrolmentRate: summary.enrolmentRate },
      statuses, overTime, byProgramme, byIntake, utilisation, academicYear: settings.defaultAcademicYear,
      recentApplications: recent.rows, attention: attention.rows,
      deadlines: [
        ...closing.rows.map(row => ({ kind: 'INTAKE_CLOSING', id: row.id, title: row.programmeCode + ' · ' + row.name, date: row.date })),
        ...offers.rows.map(row => ({ kind: 'OFFER_RESPONSE', id: row.id, title: row.reference + ' · ' + row.applicantName, date: row.date })),
      ].sort((a, b) => String(a.date instanceof Date ? a.date.toISOString() : a.date).localeCompare(String(b.date instanceof Date ? b.date.toISOString() : b.date))),
      recentDecisions: decisions.rows, recentActivity: activity.rows,
    });
  });

  router.get('/analytics', async (req, res) => {
    const filters = read(statsFilters, req.query);
    const from = filters.from ?? daysAgo(365);
    const to = filters.to ?? today();
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    const period = span > 120 ? 'month' : 'week';
    const { where, args } = statsWhere(filters);
    const [summary, statuses, overTime, byNationality, byProgramme, byFaculty, byIntake, utilisation, demand] = await Promise.all([
      funnel(pool, filters),
      statusCounts(pool, filters),
      submissionsOverTime(pool, filters, period, from, to),
      breakdown(pool, filters, 'ap.nationality', 'ap.nationality', 10),
      breakdown(pool, filters, 'p.id::text', "p.code || ' · ' || p.name", 12),
      breakdown(pool, filters, 'p.faculty', 'p.faculty', 10),
      breakdown(pool, filters, 'i.id::text', "p.code || ' · ' || i.name", 12),
      intakeUtilisation(pool, filters, 20),
      // Demand = submitted applications per available place across the programme's intakes in scope.
      pool.query<{ id: string; code: string; name: string; applications: number; capacity: number }>(
        `WITH apps AS (SELECT a.programme_id, count(*) FILTER (WHERE a.submitted_at IS NOT NULL)::int AS applications ${statsFrom} ${where} GROUP BY 1),
              seats AS (SELECT i.programme_id, sum(i.capacity)::int AS capacity FROM admission_intakes i
                        WHERE i.status <> 'CANCELLED' AND ($3::text IS NULL OR i.academic_year = $3) AND ($6::uuid IS NULL OR i.id = $6) GROUP BY 1)
         SELECT p.id, p.code, p.name, coalesce(apps.applications, 0) AS applications, coalesce(seats.capacity, 0) AS capacity
         FROM programmes p LEFT JOIN apps ON apps.programme_id = p.id LEFT JOIN seats ON seats.programme_id = p.id
         WHERE (apps.applications > 0 OR seats.capacity > 0) AND ($4::text IS NULL OR p.faculty = $4) AND ($5::uuid IS NULL OR p.id = $5)
         ORDER BY applications DESC, p.code LIMIT 12`, args),
    ]);
    data(res, {
      filters: { ...filters, from, to }, period, summary, statuses, overTime, byNationality, byProgramme, byFaculty, byIntake, utilisation,
      demand: demand.rows.map(row => ({ ...row, ratio: row.capacity ? Math.round((row.applications / row.capacity) * 100) / 100 : null })),
    });
  });

  router.get('/analytics/options', async (_req, res) => {
    const [years, faculties, programmes, intakes] = await Promise.all([
      pool.query<{ year: string }>('SELECT DISTINCT academic_year AS year FROM admission_intakes ORDER BY 1 DESC'),
      pool.query<{ faculty: string }>('SELECT DISTINCT faculty FROM programmes ORDER BY 1'),
      pool.query('SELECT id, code, name, faculty FROM programmes ORDER BY code'),
      pool.query('SELECT i.id, i.name, i.programme_id "programmeId", i.academic_year "academicYear", p.code "programmeCode" FROM admission_intakes i JOIN programmes p ON p.id = i.programme_id ORDER BY i.opens_at DESC'),
    ]);
    data(res, { years: years.rows.map(row => row.year), faculties: faculties.rows.map(row => row.faculty), programmes: programmes.rows, intakes: intakes.rows });
  });

  return router;
}
