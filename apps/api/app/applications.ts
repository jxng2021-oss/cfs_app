import { Router } from 'express';
import { z } from 'zod';
import { record } from './activity.js';
import { applicantDto, getApplicant, type ApplicantRow } from './applicants.js';
import { requireEditor, viewer, type Services } from './auth.js';
import { transaction, type Db } from './db.js';
import {
  applicationStatuses, availableActions, decisionFor, formatReference, requirementCheck, statusLabel, terminalStatuses, transition,
  TransitionError, workflow, workflowActions, type ApplicationStatus, type WorkflowAction,
} from './domain.js';
import { ApiError, data, direction, id, invalid, notFound, optionalText, orderBy, pageFields, paged, read, version } from './http.js';
import { getIntake, type IntakeRow } from './intakes.js';
import { getProgramme, programmeDto, type ProgrammeRow } from './programmes.js';
import { loadSettings } from './settings.js';

type ApplicationRow = {
  id: string; reference: string; applicant_id: string; programme_id: string; intake_id: string; status: ApplicationStatus;
  decision: 'OFFERED' | 'WAITLISTED' | 'REJECTED' | null; reviewer_id: string | null; submitted_at: Date | null; decided_at: Date | null;
  offer_response_deadline: string | null; version: number; created_at: Date; updated_at: Date;
};
type ListRow = ApplicationRow & {
  applicant_name: string; applicant_number: string; programme_code: string; programme_name: string; intake_name: string;
  reviewer_name: string | null; attention: string | null;
};

const filters = z.strictObject({
  ...pageFields,
  q: optionalText(120),
  status: z.enum(applicationStatuses).optional(),
  programmeId: z.uuid().optional(),
  intakeId: z.uuid().optional(),
  applicantId: z.uuid().optional(),
  reviewerId: z.union([z.uuid(), z.literal('none')]).optional(),
  attention: z.enum(['true', 'false']).transform(value => value === 'true').default(false),
  sort: z.enum(['reference', 'applicant', 'programme', 'intake', 'status', 'submittedAt', 'updatedAt', 'deadline']).default('updatedAt'),
  dir: direction.default('desc'),
});
const create = z.strictObject({
  applicantId: z.uuid(), programmeId: z.uuid(), intakeId: z.uuid(), reviewerId: z.uuid().nullable().default(null),
  submit: z.boolean().default(false), note: z.string().trim().max(4000).default(''),
});
const edit = z.strictObject({
  programmeId: z.uuid().optional(), intakeId: z.uuid().optional(), reviewerId: z.uuid().nullable().optional(),
  offerResponseDeadline: z.iso.date().optional(), version,
});
const actionBody = z.strictObject({ version, reason: z.string().trim().max(1000).default(''), offerResponseDeadline: z.iso.date().optional() });

const events: Record<WorkflowAction, string> = {
  submit: 'APPLICATION_SUBMITTED', 'start-review': 'REVIEW_STARTED', 'request-information': 'INFORMATION_REQUESTED', 'resume-review': 'REVIEW_RESUMED',
  waitlist: 'APPLICATION_WAITLISTED', 'issue-offer': 'OFFER_ISSUED', reject: 'APPLICATION_REJECTED', 'accept-offer': 'OFFER_ACCEPTANCE_RECORDED',
  'decline-offer': 'OFFER_DECLINE_RECORDED', enrol: 'ENROLMENT_CONFIRMED', withdraw: 'APPLICATION_WITHDRAWN',
};

/** Why an application needs attention, given the review target in days; null when nothing is outstanding. */
const attention = (targetParam: string) => `CASE
  WHEN a.status = 'SUBMITTED' AND a.submitted_at < clock_timestamp() - make_interval(days => ${targetParam}) THEN 'Waiting for review beyond target'
  WHEN a.status = 'INFO_REQUIRED' THEN 'Awaiting additional information'
  WHEN a.status = 'OFFER_ISSUED' AND a.offer_response_deadline < (clock_timestamp() AT TIME ZONE 'Asia/Singapore')::date THEN 'Offer response overdue'
  WHEN a.status = 'OFFER_ISSUED' AND a.offer_response_deadline <= (clock_timestamp() AT TIME ZONE 'Asia/Singapore')::date + 3 THEN 'Offer response due soon'
  WHEN a.status = 'OFFER_ACCEPTED' THEN 'Ready to confirm enrolment'
  WHEN a.status = 'UNDER_REVIEW' AND a.reviewer_id IS NULL THEN 'No reviewer assigned'
END`;

const listSelect = (targetParam: string) => `SELECT a.*, ap.first_name || ' ' || ap.last_name AS applicant_name, ap.applicant_number,
  p.code AS programme_code, p.name AS programme_name, i.name AS intake_name, u.display_name AS reviewer_name, ${attention(targetParam)} AS attention
  FROM applications a JOIN applicants ap ON ap.id = a.applicant_id JOIN programmes p ON p.id = a.programme_id
  JOIN admission_intakes i ON i.id = a.intake_id LEFT JOIN users u ON u.id = a.reviewer_id`;

function listDto(row: ListRow) {
  return {
    id: row.id, reference: row.reference, status: row.status, decision: row.decision, submittedAt: row.submitted_at, decidedAt: row.decided_at,
    offerResponseDeadline: row.offer_response_deadline, updatedAt: row.updated_at, createdAt: row.created_at, version: row.version,
    applicant: { id: row.applicant_id, name: row.applicant_name, applicantNumber: row.applicant_number },
    programme: { id: row.programme_id, code: row.programme_code, name: row.programme_name },
    intake: { id: row.intake_id, name: row.intake_name },
    reviewer: row.reviewer_id ? { id: row.reviewer_id, name: row.reviewer_name } : null,
    attention: row.attention,
  };
}

async function getApplication(db: Db, applicationId: string, lock = false) {
  const row = (await db.query<ApplicationRow>(`SELECT * FROM applications WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [applicationId])).rows[0];
  if (!row) notFound();
  return row;
}

async function requireReviewer(db: Db, reviewerId: string | null) {
  if (!reviewerId) return;
  const ok = await db.query("SELECT 1 FROM users WHERE id = $1 AND is_active AND role IN ('ADMIN', 'OFFICER')", [reviewerId]);
  if (!ok.rowCount) invalid('Choose an active administrator or admissions officer as reviewer.', { reviewerId: 'Not an active admissions staff member' });
}

/** The programme/intake pair must exist, match, and still accept applications. */
async function requireTarget(db: Db, programmeId: string, intakeId: string, submitting: boolean) {
  const programme = await getProgramme(db, programmeId);
  const intake = (await db.query<IntakeRow>('SELECT * FROM admission_intakes WHERE id = $1', [intakeId])).rows[0];
  if (!intake) invalid('Choose an existing admission intake.', { intakeId: 'Unknown intake' });
  if (intake.programme_id !== programmeId) invalid('The selected intake belongs to a different programme.', { intakeId: 'Belongs to another programme' });
  if (programme.status !== 'ACTIVE') throw new ApiError(409, 'INVALID_STATE', `Programme ${programme.code} is not accepting applications.`);
  if (['CANCELLED', 'COMPLETED'].includes(intake.status)) throw new ApiError(409, 'INVALID_STATE', `Intake ${intake.name} is ${intake.status.toLowerCase()}.`);
  if (submitting && intake.status !== 'OPEN') throw new ApiError(409, 'INTAKE_NOT_OPEN', `Intake ${intake.name} is not open for submissions.`);
  return { programme, intake };
}

const singaporeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
const addDays = (date: string, days: number) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86_400_000).toISOString().slice(0, 10);

async function history(db: Db, applicationId: string, from: ApplicationStatus | null, to: ApplicationStatus, actor: string, reason = '') {
  await db.query('INSERT INTO application_status_history (application_id, from_status, to_status, actor_id, reason) VALUES ($1, $2, $3, $4, $5)',
    [applicationId, from, to, actor, reason]);
}

export function applicationRoutes({ pool }: Services) {
  const router = Router();

  router.get('/applications', async (req, res) => {
    const query = read(filters, req.query);
    const settings = await loadSettings(pool);
    const where = `WHERE ($1::text IS NULL OR a.reference ILIKE '%' || $1 || '%' OR ap.applicant_number ILIKE '%' || $1 || '%'
        OR (ap.first_name || ' ' || ap.last_name) ILIKE '%' || $1 || '%' OR ap.email ILIKE '%' || $1 || '%')
      AND ($2::text IS NULL OR a.status = $2) AND ($3::uuid IS NULL OR a.programme_id = $3) AND ($4::uuid IS NULL OR a.intake_id = $4)
      AND ($5::uuid IS NULL OR a.applicant_id = $5)
      AND ($6::text IS NULL OR ($6 = 'none' AND a.reviewer_id IS NULL) OR a.reviewer_id::text = $6)
      AND (NOT $7::boolean OR ${attention('$8')} IS NOT NULL)`;
    const args = [query.q ?? null, query.status ?? null, query.programmeId ?? null, query.intakeId ?? null, query.applicantId ?? null,
      query.reviewerId ?? null, query.attention, settings.reviewTargetDays];
    const from = `FROM applications a JOIN applicants ap ON ap.id = a.applicant_id JOIN programmes p ON p.id = a.programme_id
      JOIN admission_intakes i ON i.id = a.intake_id LEFT JOIN users u ON u.id = a.reviewer_id`;
    const sort = orderBy({ reference: 'a.reference', applicant: 'ap.last_name, ap.first_name', programme: 'p.code', intake: 'i.name',
      status: 'a.status', submittedAt: 'a.submitted_at', updatedAt: 'a.updated_at', deadline: 'a.offer_response_deadline' }, query.sort, query.dir, 'a.id');
    const [rows, total] = await Promise.all([
      pool.query<ListRow>(`${listSelect('$8')} ${where} ${sort} LIMIT $9 OFFSET $10`, [...args, query.pageSize, (query.page - 1) * query.pageSize]),
      pool.query<{ total: number }>(`SELECT count(*)::int AS total ${from} ${where}`, args),
    ]);
    paged(res, rows.rows.map(listDto), total.rows[0].total, query.page, query.pageSize);
  });

  router.get('/applications/reviewers', async (_req, res) => {
    const { rows } = await pool.query<{ id: string; display_name: string; role: string }>(
      "SELECT id, display_name, role FROM users WHERE is_active AND role IN ('ADMIN', 'OFFICER') ORDER BY display_name");
    data(res, rows.map(row => ({ id: row.id, name: row.display_name, role: row.role })));
  });

  router.get('/applications/:applicationId', async (req, res) => {
    const applicationId = id(req, 'applicationId');
    const settings = await loadSettings(pool);
    const row = (await pool.query<ListRow>(`${listSelect('$2')} WHERE a.id = $1`, [applicationId, settings.reviewTargetDays])).rows[0];
    if (!row) notFound();
    const [applicant, programme, intake, timeline, notes, others] = await Promise.all([
      getApplicant(pool, row.applicant_id),
      pool.query<ProgrammeRow>('SELECT * FROM programmes WHERE id = $1', [row.programme_id]).then(result => result.rows[0]),
      pool.query<IntakeRow & { enrolled: number }>(
        "SELECT i.*, (SELECT count(*)::int FROM applications x WHERE x.intake_id = i.id AND x.status = 'ENROLLED') AS enrolled FROM admission_intakes i WHERE i.id = $1",
        [row.intake_id]).then(result => result.rows[0]),
      pool.query(`SELECT h.id, h.from_status "fromStatus", h.to_status "toStatus", h.reason, h.occurred_at "occurredAt", u.display_name "actorName"
        FROM application_status_history h LEFT JOIN users u ON u.id = h.actor_id WHERE h.application_id = $1 ORDER BY h.occurred_at, h.id`, [applicationId]),
      pool.query(`SELECT n.id, n.body, n.created_at "createdAt", u.display_name "authorName" FROM application_notes n
        LEFT JOIN users u ON u.id = n.author_id WHERE n.application_id = $1 ORDER BY n.created_at DESC, n.id`, [applicationId]),
      pool.query(`SELECT a.id, a.reference, a.status, p.code AS "programmeCode", i.name AS "intakeName" FROM applications a
        JOIN programmes p ON p.id = a.programme_id JOIN admission_intakes i ON i.id = a.intake_id
        WHERE a.applicant_id = $1 AND a.id <> $2 ORDER BY a.created_at DESC`, [row.applicant_id, applicationId]),
    ]);
    const decisions = timeline.rows.filter(entry => ['OFFER_ISSUED', 'WAITLISTED', 'REJECTED'].includes(entry.toStatus));
    data(res, {
      ...listDto(row),
      applicant: applicantDto(applicant),
      programme: programmeDto(programme),
      intake: { id: intake.id, name: intake.name, academicYear: intake.academic_year, status: intake.status, opensAt: intake.opens_at,
        closesAt: intake.closes_at, commencesOn: intake.commences_on, capacity: intake.capacity, enrolled: intake.enrolled,
        remainingCapacity: Math.max(0, intake.capacity - intake.enrolled) },
      requirements: requirementCheck(
        { highestQualification: applicant.highest_qualification, gpa: applicant.gpa },
        { minimumQualification: programme.minimum_qualification, minimumGpa: programme.minimum_gpa }),
      availableActions: availableActions(row.status).map(action => ({ action, label: workflow[action].label, to: workflow[action].to,
        reasonRequired: 'reason' in workflow[action] || (action === 'reject' && settings.requireRejectionReason) })),
      defaultOfferResponseDeadline: addDays(singaporeToday(), settings.offerResponseDays),
      history: timeline.rows, decisions, notes: notes.rows, otherApplications: others.rows,
    });
  });

  router.post('/applications', requireEditor, async (req, res) => {
    const input = read(create, req.body);
    const actor = viewer(res).user.id;
    const created = await transaction(pool, async db => {
      const applicant = await getApplicant(db, input.applicantId);
      if (applicant.status === 'ARCHIVED') throw new ApiError(409, 'INVALID_STATE', 'Restore this archived applicant before creating an application.');
      const { programme, intake } = await requireTarget(db, input.programmeId, input.intakeId, input.submit);
      await requireReviewer(db, input.reviewerId);
      const settings = await loadSettings(db);
      const { rows: [{ sequence, year }] } = await db.query<{ sequence: string; year: number }>(
        "SELECT nextval('application_number_seq')::text AS sequence, extract(year FROM clock_timestamp() AT TIME ZONE 'Asia/Singapore')::int AS year");
      const reference = formatReference(settings.referencePrefix, settings.referenceIncludeYear, year, Number(sequence));
      const status: ApplicationStatus = input.submit ? 'SUBMITTED' : 'DRAFT';
      const { rows: [row] } = await db.query<ApplicationRow>(
        `INSERT INTO applications (reference, applicant_id, programme_id, intake_id, reviewer_id, status, submitted_at)
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $6 = 'SUBMITTED' THEN clock_timestamp() END) RETURNING *`,
        [reference, applicant.id, programme.id, intake.id, input.reviewerId, status],
      ).catch(error => {
        if (error && typeof error === 'object' && 'constraint' in error && error.constraint === 'applications_one_per_intake') {
          throw new ApiError(409, 'DUPLICATE_APPLICATION', 'This applicant already has an active application for that intake.');
        }
        throw error;
      });
      await history(db, row.id, null, 'DRAFT', actor, 'Application created');
      if (input.submit) await history(db, row.id, 'DRAFT', 'SUBMITTED', actor);
      if (input.note) await db.query('INSERT INTO application_notes (application_id, author_id, body) VALUES ($1, $2, $3)', [row.id, actor, input.note]);
      await record(db, actor, 'APPLICATION_CREATED', 'APPLICATION', row.id,
        `Created application ${row.reference} for ${applicant.first_name} ${applicant.last_name} to ${programme.code} · ${intake.name}`, { status });
      return row;
    });
    data(res, { id: created.id, reference: created.reference, status: created.status }, 201);
  });

  router.patch('/applications/:applicationId', requireEditor, async (req, res) => {
    const applicationId = id(req, 'applicationId');
    const input = read(edit, req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    const actor = viewer(res).user.id;
    const updated = await transaction(pool, async db => {
      const current = await getApplication(db, applicationId, true);
      if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This application changed since you opened it. Reload and try again.');
      if (terminalStatuses.includes(current.status)) throw new ApiError(409, 'INVALID_STATE', `${statusLabel(current.status)} applications are read-only.`);
      const programmeId = input.programmeId ?? current.programme_id;
      const intakeId = input.intakeId ?? current.intake_id;
      const moving = programmeId !== current.programme_id || intakeId !== current.intake_id;
      if (moving) {
        if (!['DRAFT', 'SUBMITTED'].includes(current.status)) throw new ApiError(409, 'INVALID_STATE', 'The programme and intake can only change before review starts.');
        await requireTarget(db, programmeId, intakeId, current.status === 'SUBMITTED');
      }
      if (input.reviewerId !== undefined) await requireReviewer(db, input.reviewerId);
      if (input.offerResponseDeadline !== undefined) {
        if (current.status !== 'OFFER_ISSUED') throw new ApiError(409, 'INVALID_STATE', 'The response deadline applies only to issued offers.');
        if (input.offerResponseDeadline < singaporeToday()) invalid('The response deadline cannot be in the past.', { offerResponseDeadline: 'In the past' });
      }
      const { rows: [row] } = await db.query<ApplicationRow>(
        `UPDATE applications SET programme_id = $2, intake_id = $3, reviewer_id = $4, offer_response_deadline = $5, version = version + 1, updated_at = clock_timestamp()
         WHERE id = $1 RETURNING *`,
        [applicationId, programmeId, intakeId, input.reviewerId === undefined ? current.reviewer_id : input.reviewerId,
          input.offerResponseDeadline ?? current.offer_response_deadline],
      ).catch(error => {
        if (error && typeof error === 'object' && 'constraint' in error && error.constraint === 'applications_one_per_intake') {
          throw new ApiError(409, 'DUPLICATE_APPLICATION', 'This applicant already has an active application for that intake.');
        }
        throw error;
      });
      const changed = [moving && 'programme/intake', input.reviewerId !== undefined && input.reviewerId !== current.reviewer_id && 'reviewer',
        input.offerResponseDeadline !== undefined && input.offerResponseDeadline !== current.offer_response_deadline && 'offer response deadline'].filter(Boolean) as string[];
      if (changed.length) await record(db, actor, 'APPLICATION_UPDATED', 'APPLICATION', row.id, `Updated ${changed.join(', ')} on ${row.reference}`, { fields: changed.join(', ') });
      return row;
    });
    data(res, { id: updated.id, status: updated.status, version: updated.version });
  });

  for (const action of workflowActions) {
    router.post(`/applications/:applicationId/${action}`, requireEditor, async (req, res) => {
      const applicationId = id(req, 'applicationId');
      const input = read(actionBody, req.body ?? {});
      const actor = viewer(res).user.id;
      const updated = await transaction(pool, async db => {
        const current = await getApplication(db, applicationId, true);
        if (current.version !== input.version) throw new ApiError(409, 'VERSION_CONFLICT', 'This application changed since you opened it. Reload and try again.');
        let next: ApplicationStatus;
        try {
          next = transition(current.status, action);
        } catch (error) {
          if (error instanceof TransitionError) throw new ApiError(409, 'INVALID_TRANSITION', error.message);
          throw error;
        }
        const settings = await loadSettings(db);
        const needsReason = 'reason' in workflow[action] || (action === 'reject' && settings.requireRejectionReason);
        if (needsReason && !input.reason) invalid('Give a reason for this action.', { reason: 'Required' });
        let deadline = current.offer_response_deadline;
        let reviewer = current.reviewer_id;
        let intake: IntakeRow | undefined;

        if (action === 'submit') {
          const applicant: ApplicantRow = await getApplicant(db, current.applicant_id);
          if (applicant.status === 'ARCHIVED') throw new ApiError(409, 'INVALID_STATE', 'Restore the archived applicant before submitting.');
          await requireTarget(db, current.programme_id, current.intake_id, true);
        }
        if (action === 'start-review' && !reviewer) reviewer = actor;
        if (action === 'issue-offer') {
          deadline = input.offerResponseDeadline ?? addDays(singaporeToday(), settings.offerResponseDays);
          if (deadline < singaporeToday()) invalid('The response deadline cannot be in the past.', { offerResponseDeadline: 'In the past' });
        }
        if (action === 'accept-offer' && current.offer_response_deadline && current.offer_response_deadline < singaporeToday()) {
          throw new ApiError(409, 'OFFER_EXPIRED', 'The offer response deadline has passed. Extend the deadline first if the acceptance is valid.');
        }
        if (action === 'enrol') {
          // Lock the intake so concurrent enrolments cannot both take the last place.
          intake = await getIntake(db, current.intake_id, true);
          if (intake.status === 'CANCELLED') throw new ApiError(409, 'INVALID_STATE', 'This intake has been cancelled.');
          const { rows: [{ enrolled }] } = await db.query<{ enrolled: number }>(
            "SELECT count(*)::int AS enrolled FROM applications WHERE intake_id = $1 AND status = 'ENROLLED'", [current.intake_id]);
          if (enrolled >= intake.capacity) throw new ApiError(409, 'CAPACITY_REACHED', `Intake ${intake.name} is full (${enrolled} of ${intake.capacity} places confirmed).`);
        }

        const decision = decisionFor(next);
        const { rows: [row] } = await db.query<ApplicationRow>(
          `UPDATE applications SET status = $2, reviewer_id = $3, offer_response_deadline = $4,
             submitted_at = CASE WHEN $2 = 'SUBMITTED' AND submitted_at IS NULL THEN clock_timestamp() ELSE submitted_at END,
             decision = coalesce($5, decision), decided_at = CASE WHEN $5::text IS NOT NULL THEN clock_timestamp() ELSE decided_at END,
             version = version + 1, updated_at = clock_timestamp()
           WHERE id = $1 RETURNING *`,
          [applicationId, next, reviewer, deadline, decision],
        );
        await history(db, row.id, current.status, next, actor, input.reason);
        await record(db, actor, events[action], 'APPLICATION', row.id,
          `${workflow[action].label}: ${row.reference} (${statusLabel(current.status)} → ${statusLabel(next)})`,
          { from: current.status, to: next, ...(input.reason ? { reason: input.reason } : {}), ...(action === 'issue-offer' ? { responseDeadline: deadline } : {}) });
        return row;
      });
      data(res, { id: updated.id, status: updated.status, version: updated.version });
    });
  }

  router.post('/applications/:applicationId/notes', requireEditor, async (req, res) => {
    const applicationId = id(req, 'applicationId');
    const { body } = read(z.strictObject({ body: z.string().trim().min(1).max(4000) }), req.body);
    const actor = viewer(res).user.id;
    const note = await transaction(pool, async db => {
      const application = await getApplication(db, applicationId);
      const { rows: [row] } = await db.query('INSERT INTO application_notes (application_id, author_id, body) VALUES ($1, $2, $3) RETURNING id, created_at "createdAt"',
        [applicationId, actor, body]);
      await record(db, actor, 'REVIEW_NOTE_ADDED', 'APPLICATION', applicationId, `Added a review note to ${application.reference}`);
      return row;
    });
    data(res, note, 201);
  });

  // Drafts that were never submitted can be discarded; anything else keeps its history and is withdrawn instead.
  router.delete('/applications/:applicationId', requireEditor, async (req, res) => {
    const applicationId = id(req, 'applicationId');
    await transaction(pool, async db => {
      const current = await getApplication(db, applicationId, true);
      if (current.status !== 'DRAFT') throw new ApiError(409, 'HAS_HISTORY', 'Only draft applications can be deleted. Withdraw this application instead.');
      await db.query('DELETE FROM application_notes WHERE application_id = $1', [applicationId]);
      await db.query('DELETE FROM application_status_history WHERE application_id = $1', [applicationId]);
      await db.query('DELETE FROM applications WHERE id = $1', [applicationId]);
      await record(db, viewer(res).user.id, 'APPLICATION_DELETED', 'APPLICATION', applicationId, `Deleted draft application ${current.reference}`);
    });
    res.status(204).end();
  });

  return router;
}
