import type { Db } from './db.js';
import { decisionFor, formatReference, statusLabel, transition, type ApplicationStatus, type Qualification, type WorkflowAction } from './domain.js';

/**
 * Fictional admissions data for development and demonstrations. Every person, email and phone number is invented
 * (emails use the reserved example.test domain). Application histories are built by walking the real workflow,
 * so dashboards, timelines and activity logs agree with each other.
 */

// Deterministic pseudo-random numbers so every seed produces the same data set.
function random(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const day = 86_400_000;
const firstNames = ['Aisha', 'Benjamin', 'Chloe', 'Daniel', 'Elena', 'Farhan', 'Grace', 'Hiro', 'Isabel', 'Jun', 'Kavya', 'Liam', 'Mei', 'Nikhil',
  'Olivia', 'Priya', 'Qi', 'Rafael', 'Sara', 'Tariq', 'Uma', 'Victor', 'Wen', 'Xavier', 'Yuna', 'Zara', 'Adrian', 'Bella', 'Caleb', 'Divya'];
const lastNames = ['Abdullah', 'Bautista', 'Chen', 'Das', 'Enriquez', 'Fong', 'Gupta', 'Hassan', 'Ito', 'Jayaraman', 'Kumar', 'Lim', 'Morales',
  'Nguyen', 'Ong', 'Pillai', 'Quek', 'Rahman', 'Santos', 'Tan', 'Uddin', 'Vasquez', 'Wong', 'Yeo', 'Zhang'];
const nationalities = ['Singaporean', 'Singaporean', 'Singaporean', 'Malaysian', 'Malaysian', 'Indonesian', 'Indian', 'Chinese', 'Vietnamese', 'Filipino', 'Thai', 'Myanmar', 'Korean'];
const schools: Record<Qualification, string[]> = {
  SECONDARY: ['Northbrook Secondary School', 'Riverside Secondary School'],
  PRE_UNIVERSITY: ['Harbourview Junior College', 'Eastgate Junior College', 'Westfield International School', 'Lakeside Pre-University Centre'],
  DIPLOMA: ['Bayfront Polytechnic', 'Central Polytechnic', 'Kingsway Institute of Technology'],
  BACHELOR: ['Meridian University', 'Coastal Institute of Science', 'Highland University'],
  MASTER: ['Meridian University'],
  DOCTORATE: ['Highland University'],
};
const streets = ['Maple Avenue', 'Harbour Road', 'Orchid Lane', 'Riverside Walk', 'Hillcrest Drive', 'Sunset Way', 'Cedar Street', 'Lotus Crescent'];

const programmes = [
  { code: 'BCS', name: 'Bachelor of Computer Science', faculty: 'Faculty of Engineering and Computing', type: 'BACHELOR', months: 36, min: 'PRE_UNIVERSITY', gpa: '3.00', capacity: [60, 80], demand: 5 },
  { code: 'BIS', name: 'Bachelor of Information Security', faculty: 'Faculty of Engineering and Computing', type: 'BACHELOR', months: 36, min: 'PRE_UNIVERSITY', gpa: '3.20', capacity: [40, 40], demand: 4 },
  { code: 'DCE', name: 'Diploma in Cloud Engineering', faculty: 'Faculty of Engineering and Computing', type: 'DIPLOMA', months: 24, min: 'SECONDARY', gpa: null, capacity: [80, 80], demand: 3 },
  { code: 'BBA', name: 'Bachelor of Business Administration', faculty: 'School of Business', type: 'BACHELOR', months: 36, min: 'PRE_UNIVERSITY', gpa: '2.80', capacity: [100, 120], demand: 4 },
  { code: 'MBA', name: 'Master of Business Administration', faculty: 'School of Business', type: 'MASTER', months: 18, min: 'BACHELOR', gpa: '3.00', capacity: [30, 30], demand: 2 },
  { code: 'BSN', name: 'Bachelor of Science in Nursing', faculty: 'Faculty of Health Sciences', type: 'BACHELOR', months: 48, min: 'PRE_UNIVERSITY', gpa: '3.10', capacity: [50, 50], demand: 3 },
  { code: 'CPH', name: 'Certificate in Public Health', faculty: 'Faculty of Health Sciences', type: 'CERTIFICATE', months: 6, min: 'DIPLOMA', gpa: null, capacity: [25, 25], demand: 1 },
  { code: 'BDM', name: 'Bachelor of Digital Media Design', faculty: 'School of Design and Media', type: 'BACHELOR', months: 36, min: 'PRE_UNIVERSITY', gpa: '2.70', capacity: [45, 45], demand: 2 },
] as const;

/** Workflow steps for each final status (from Draft). */
const paths: Record<ApplicationStatus, WorkflowAction[]> = {
  DRAFT: [],
  SUBMITTED: ['submit'],
  UNDER_REVIEW: ['submit', 'start-review'],
  INFO_REQUIRED: ['submit', 'start-review', 'request-information'],
  WAITLISTED: ['submit', 'start-review', 'waitlist'],
  OFFER_ISSUED: ['submit', 'start-review', 'issue-offer'],
  OFFER_ACCEPTED: ['submit', 'start-review', 'issue-offer', 'accept-offer'],
  OFFER_DECLINED: ['submit', 'start-review', 'issue-offer', 'decline-offer'],
  REJECTED: ['submit', 'start-review', 'reject'],
  WITHDRAWN: ['submit', 'start-review', 'withdraw'],
  ENROLLED: ['submit', 'start-review', 'issue-offer', 'accept-offer', 'enrol'],
};
const reasons: Partial<Record<WorkflowAction, string[]>> = {
  'request-information': ['Please provide certified results for the final examination.', 'Personal statement is missing.', 'Transcript page 2 is unreadable.'],
  reject: ['Does not meet the minimum GPA requirement.', 'Prerequisite subjects not completed.', 'Programme places filled by stronger applicants.'],
  withdraw: ['Applicant accepted a place elsewhere.', 'Applicant deferred studies for personal reasons.'],
};
const noteBodies = ['Strong results in mathematics; recommend fast-tracking review.', 'Called applicant to confirm contact details.',
  'Reference letter received from previous institution.', 'Portfolio reviewed; good range of work.', 'Applicant asked about part-time options.'];

const events: Record<WorkflowAction, string> = {
  submit: 'APPLICATION_SUBMITTED', 'start-review': 'REVIEW_STARTED', 'request-information': 'INFORMATION_REQUESTED', 'resume-review': 'REVIEW_RESUMED',
  waitlist: 'APPLICATION_WAITLISTED', 'issue-offer': 'OFFER_ISSUED', reject: 'APPLICATION_REJECTED', 'accept-offer': 'OFFER_ACCEPTANCE_RECORDED',
  'decline-offer': 'OFFER_DECLINE_RECORDED', enrol: 'ENROLMENT_CONFIRMED', withdraw: 'APPLICATION_WITHDRAWN',
};

async function log(db: Db, at: Date, actor: string | null, action: string, entityType: string, entityId: string, description: string, metadata: Record<string, string> = {}) {
  await db.query('INSERT INTO audit_events (actor_id, event_type, entity_type, entity_id, description, metadata, occurred_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [actor, action, entityType, entityId, description, metadata, at]);
}

const iso = (time: number) => new Date(time).toISOString().slice(0, 10);
const academicYear = (time: number) => {
  const date = new Date(time);
  const start = date.getUTCMonth() >= 6 ? date.getUTCFullYear() : date.getUTCFullYear() - 1;
  return start + '/' + (start + 1);
};

/** Seeds the admissions demo when the database has no programmes yet. Returns false when data already exists. */
export async function seedAdmissionsDemo(db: Db, staff: { admin: string; officers: string[] }, now: Date) {
  if ((await db.query('SELECT 1 FROM programmes LIMIT 1')).rowCount) return false;
  const rand = random(20260101);
  const pick = <T,>(items: readonly T[]) => items[Math.floor(rand() * items.length)];
  const time = now.getTime();
  const year = new Date(time).getUTCFullYear();
  // Intake calendar relative to "now": last August (closed, enrolled), next January (open), next August (upcoming).
  const pastAugust = Date.UTC(new Date(time).getUTCMonth() >= 7 ? year : year - 1, 7, 1);
  const nextJanuary = Date.UTC(new Date(time).getUTCMonth() >= 7 ? year + 1 : year, 0, 12);
  const nextAugust = Date.UTC(new Date(nextJanuary).getUTCFullYear(), 7, 1);
  const created = (offsetDays: number) => new Date(Math.min(time - 3_600_000, time - offsetDays * day));

  const intakes: { id: string; programmeIndex: number; kind: 'past' | 'open' | 'upcoming'; opens: number; closes: number; capacity: number }[] = [];
  const programmeIds: string[] = [];
  for (const [index, programme] of programmes.entries()) {
    const at = created(420 - index * 3);
    const { rows: [row] } = await db.query<{ id: string }>(
      `INSERT INTO programmes (code, name, faculty, qualification_type, description, duration_months, admission_requirements, minimum_qualification, minimum_gpa, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) RETURNING id`,
      [programme.code, programme.name, programme.faculty, programme.type,
        `A ${programme.months}-month ${programme.type.toLowerCase()} programme offered by the ${programme.faculty}.`,
        programme.months,
        `Minimum ${programme.min === 'SECONDARY' ? 'secondary' : programme.min === 'PRE_UNIVERSITY' ? 'pre-university' : programme.min.toLowerCase()} qualification` +
          (programme.gpa ? ` with a GPA of at least ${programme.gpa} on a 4.00 scale.` : '.') + ' Applicants should submit transcripts and a personal statement.',
        programme.min, programme.gpa, at],
    );
    programmeIds.push(row.id);
    await log(db, at, staff.admin, 'PROGRAMME_CREATED', 'PROGRAMME', row.id, `Created programme ${programme.code} · ${programme.name}`);
    const calendar = [
      { kind: 'past' as const, name: 'August ' + new Date(pastAugust).getUTCFullYear() + ' intake', opens: pastAugust - 200 * day, closes: pastAugust - 60 * day, commences: pastAugust, status: 'CLOSED', capacity: programme.capacity[0] },
      { kind: 'open' as const, name: 'January ' + new Date(nextJanuary).getUTCFullYear() + ' intake', opens: nextJanuary - 170 * day, closes: Math.max(nextJanuary - 30 * day, time + 10 * day), commences: nextJanuary, status: 'OPEN', capacity: programme.capacity[1] },
      { kind: 'upcoming' as const, name: 'August ' + new Date(nextAugust).getUTCFullYear() + ' intake', opens: nextAugust - 200 * day, closes: nextAugust - 60 * day, commences: nextAugust, status: 'UPCOMING', capacity: programme.capacity[1] },
    ];
    for (const intake of calendar) {
      const intakeCreated = new Date(Math.min(intake.opens - 20 * day, time - 2 * day));
      const { rows: [created] } = await db.query<{ id: string }>(
        `INSERT INTO admission_intakes (programme_id, name, academic_year, opens_at, closes_at, commences_on, capacity, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) RETURNING id`,
        [row.id, intake.name, academicYear(intake.commences), new Date(intake.opens), new Date(intake.closes), iso(intake.commences), intake.capacity, intake.status, intakeCreated],
      );
      intakes.push({ id: created.id, programmeIndex: index, kind: intake.kind, opens: intake.opens, closes: intake.closes, capacity: intake.capacity });
      await log(db, intakeCreated, staff.admin, 'INTAKE_CREATED', 'INTAKE', created.id, `Created intake ${intake.name} for ${programme.code} (capacity ${intake.capacity})`);
      if (intake.status !== 'UPCOMING') {
        await log(db, new Date(Math.min(intake.opens, time - day)), staff.admin, 'INTAKE_STATUS_CHANGED', 'INTAKE', created.id, `Opened admissions for intake ${intake.name}`, { from: 'UPCOMING', to: 'OPEN' });
      }
      if (intake.status === 'CLOSED') {
        await log(db, new Date(intake.closes), staff.admin, 'INTAKE_STATUS_CHANGED', 'INTAKE', created.id, `Closed admissions for intake ${intake.name}`, { from: 'OPEN', to: 'CLOSED' });
      }
    }
  }

  // Applicants.
  const applicants: { id: string; number: string; name: string; qualification: Qualification; createdAt: number }[] = [];
  for (let index = 0; index < 72; index += 1) {
    const first = firstNames[index % firstNames.length];
    const last = lastNames[(index * 7 + 3) % lastNames.length];
    const qualification: Qualification = index % 11 === 0 ? 'BACHELOR' : index % 4 === 0 ? 'DIPLOMA' : index % 9 === 0 ? 'SECONDARY' : 'PRE_UNIVERSITY';
    const gpa = (2.2 + rand() * 1.8).toFixed(2);
    const age = qualification === 'BACHELOR' ? 23 + Math.floor(rand() * 8) : 17 + Math.floor(rand() * 4);
    const createdAt = time - (300 - index * 3.9) * day;
    const status = index % 23 === 22 ? 'ON_HOLD' : 'ACTIVE';
    const { rows: [row] } = await db.query<{ id: string; applicant_number: string }>(
      `INSERT INTO applicants (first_name, last_name, email, phone, date_of_birth, nationality, address, previous_institution, highest_qualification, gpa, status, remarks, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13) RETURNING id, applicant_number`,
      [first, last, `${first}.${last}.${index + 1}@example.test`.toLowerCase(), `+65 9${String(1000000 + index * 7919).slice(-7)}`,
        iso(time - (age * 365 + Math.floor(rand() * 300)) * day), pick(nationalities),
        `${10 + index} ${pick(streets)}, #0${1 + (index % 9)}-${10 + (index % 40)}, Singapore ${100000 + index * 431}`,
        pick(schools[qualification]), qualification, gpa, status,
        index % 6 === 0 ? 'Prefers contact by email. Fictional demonstration record.' : '', new Date(createdAt)],
    );
    applicants.push({ id: row.id, number: row.applicant_number, name: first + ' ' + last, qualification, createdAt });
    await log(db, new Date(createdAt), pick(staff.officers), 'APPLICANT_CREATED', 'APPLICANT', row.id, `Created applicant ${row.applicant_number} · ${first} ${last}`);
  }
  // Two archived applicants without open applications show the archive workflow.
  for (const applicant of applicants.slice(-2)) {
    await db.query("UPDATE applicants SET status = 'ARCHIVED', archived_at = $2 WHERE id = $1", [applicant.id, new Date(time - 5 * day)]);
    await log(db, new Date(time - 5 * day), staff.admin, 'APPLICANT_ARCHIVED', 'APPLICANT', applicant.id, `Archived applicant ${applicant.number}`);
  }

  // Applications: each final status is reached by walking the workflow, with timestamps moving forward.
  const pastOutcomes: ApplicationStatus[] = ['ENROLLED', 'ENROLLED', 'ENROLLED', 'ENROLLED', 'OFFER_DECLINED', 'REJECTED', 'REJECTED', 'WITHDRAWN', 'OFFER_ACCEPTED'];
  const openOutcomes: ApplicationStatus[] = ['SUBMITTED', 'SUBMITTED', 'SUBMITTED', 'UNDER_REVIEW', 'UNDER_REVIEW', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED',
    'OFFER_ISSUED', 'OFFER_ISSUED', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'OFFER_ACCEPTED', 'OFFER_DECLINED', 'REJECTED', 'REJECTED', 'WITHDRAWN', 'DRAFT', 'ENROLLED'];
  const live = applicants.slice(0, -2);
  let sequence = 0;
  let count = 0;
  for (const [index, applicant] of live.entries()) {
    const choices = (index % 3 === 0 ? 2 : 1);
    const used = new Set<number>();
    for (let choice = 0; choice < choices; choice += 1) {
      const weighted = programmes.flatMap((programme, programmeIndex) => Array<number>(programme.demand).fill(programmeIndex))
        .filter(programmeIndex => !used.has(programmeIndex) && (applicant.qualification !== 'PRE_UNIVERSITY' || programmes[programmeIndex].min !== 'BACHELOR'));
      const programmeIndex = pick(weighted);
      used.add(programmeIndex);
      const kind = index % 5 === 4 ? 'past' : index % 17 === 16 && choice === 1 ? 'upcoming' : 'open';
      const intake = intakes.find(item => item.programmeIndex === programmeIndex && item.kind === kind)!;
      const outcome: ApplicationStatus = kind === 'upcoming' ? 'DRAFT' : kind === 'past' ? pastOutcomes[count % pastOutcomes.length] : openOutcomes[count % openOutcomes.length];
      count += 1;
      const officer = pick(staff.officers);
      sequence += 1;
      const submitWindowEnd = Math.min(intake.closes, time - 2 * day);
      let at = Math.max(intake.opens + day, applicant.createdAt + day) + rand() * Math.max(day, (submitWindowEnd - intake.opens) * 0.7);
      at = Math.min(at, time - 3 * day);
      // Some open-intake submissions are old enough to show up as waiting beyond the review target.
      if (outcome === 'SUBMITTED' && index % 4 === 0) at = Math.min(at, time - 14 * day);
      const reference = formatReference('ADM', true, new Date(at).getUTCFullYear(), sequence);
      const { rows: [application] } = await db.query<{ id: string }>(
        `INSERT INTO applications (reference, applicant_id, programme_id, intake_id, status, created_at, updated_at) VALUES ($1, $2, $3, $4, 'DRAFT', $5, $5) RETURNING id`,
        [reference, applicant.id, programmeIds[programmeIndex], intake.id, new Date(at)],
      );
      await db.query("INSERT INTO application_status_history (application_id, from_status, to_status, actor_id, reason, occurred_at) VALUES ($1, NULL, 'DRAFT', $2, 'Application created', $3)",
        [application.id, officer, new Date(at)]);
      await log(db, new Date(at), officer, 'APPLICATION_CREATED', 'APPLICATION', application.id,
        `Created application ${reference} for ${applicant.name} to ${programmes[programmeIndex].code}`, { status: 'DRAFT' });

      let status: ApplicationStatus = 'DRAFT';
      let submittedAt: Date | null = null;
      let decision: string | null = null;
      let decidedAt: Date | null = null;
      let deadline: string | null = null;
      let reviewer: string | null = null;
      const steps = paths[outcome];
      for (const [stepIndex, action] of steps.entries()) {
        // Later steps happen after earlier ones; open-intake activity stays in the past.
        const remaining = steps.length - stepIndex;
        at = Math.min(at + (1 + rand() * (kind === 'past' ? 12 : 6)) * day, time - remaining * 3_600_000);
        const next = transition(status, action);
        const reason = reasons[action] ? pick(reasons[action]!) : '';
        await db.query('INSERT INTO application_status_history (application_id, from_status, to_status, actor_id, reason, occurred_at) VALUES ($1, $2, $3, $4, $5, $6)',
          [application.id, status, next, officer, reason, new Date(at)]);
        await log(db, new Date(at), officer, events[action], 'APPLICATION', application.id, `${statusLabel(next)}: ${reference} (${statusLabel(status)} → ${statusLabel(next)})`,
          { from: status, to: next, ...(reason ? { reason } : {}) });
        if (next === 'SUBMITTED') submittedAt = new Date(at);
        if (next === 'UNDER_REVIEW') reviewer = officer;
        if (decisionFor(next)) { decision = decisionFor(next); decidedAt = new Date(at); }
        // Live offers get deadlines around now (a few overdue, most upcoming); past-intake offers keep their historical deadline.
        if (next === 'OFFER_ISSUED') deadline = iso(outcome === 'OFFER_ISSUED' && kind === 'open' ? time + (index % 5 === 0 ? -2 : 3 + (index % 11)) * day : at + 14 * day);
        status = next;
      }
      const unassigned = outcome === 'UNDER_REVIEW' && index % 5 === 1;
      await db.query(
        `UPDATE applications SET status = $2, submitted_at = $3, decision = $4, decided_at = $5, offer_response_deadline = $6, reviewer_id = $7, updated_at = $8 WHERE id = $1`,
        [application.id, status, submittedAt, decision, decidedAt, deadline, unassigned ? null : reviewer, new Date(at)],
      );
      if (index % 4 === 1 && status !== 'DRAFT') {
        await db.query('INSERT INTO application_notes (application_id, author_id, body, created_at) VALUES ($1, $2, $3, $4)',
          [application.id, officer, pick(noteBodies), new Date(Math.min(at + 3_600_000, time - 60_000))]);
      }
    }
  }
  await db.query("SELECT setval('application_number_seq', $1)", [sequence]);
  return true;
}
