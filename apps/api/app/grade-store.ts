import type { Db } from './db.js';
import { audit } from './db.js';
import { ApiError } from './http.js';
import { scoreRatio } from './decimal.js';

export type Grade = {
  id: string;
  assessment_id: string;
  student_id: string;
  points: string;
  feedback: string;
  submission_id: string | null;
  attempt_id: string | null;
  published_revision_id: string | null;
  version: number;
};
export type Revision = {
  id: string;
  grade_id: string;
  revision_number: number;
  points: string;
  max_points: string;
  feedback: string;
  submission_id: string | null;
  attempt_id: string | null;
  published_by: string | null;
  published_at: Date;
};

export async function currentGrade(db: Db, assessmentId: string, studentId: string) {
  return (
    await db.query<Grade>('SELECT * FROM grades WHERE assessment_id = $1 AND student_id = $2', [
      assessmentId,
      studentId,
    ])
  ).rows[0];
}

export async function currentRevision(db: Db, grade?: Grade) {
  if (!grade?.published_revision_id) return undefined;
  return (await db.query<Revision>('SELECT * FROM grade_revisions WHERE id = $1', [grade.published_revision_id]))
    .rows[0];
}

export function revisionDto(revision?: Revision) {
  if (!revision) return null;
  return {
    revisionId: revision.id,
    points: revision.points,
    maxPoints: revision.max_points,
    feedback: revision.feedback,
    percent: scoreRatio(revision.points, revision.max_points).scale(100n).format(),
    publishedAt: revision.published_at,
  };
}

export function differs(grade: Grade, previous?: Revision) {
  return (
    !previous ||
    grade.points !== previous.points ||
    grade.feedback !== previous.feedback ||
    grade.attempt_id !== previous.attempt_id ||
    grade.submission_id !== previous.submission_id
  );
}

export function lecturerGradeDto(grade?: Grade, previous?: Revision) {
  if (!grade) return { state: 'NOT_GRADED', draft: null, published: null };
  return {
    state: !previous ? 'DRAFT' : differs(grade, previous) ? 'UNPUBLISHED_CHANGES' : 'PUBLISHED',
    draft: {
      points: grade.points,
      feedback: grade.feedback,
      submissionId: grade.submission_id,
      attemptId: grade.attempt_id,
      version: grade.version,
    },
    published: revisionDto(previous),
  };
}

export async function publishGrade(
  db: Db,
  grade: Grade,
  assessment: { module_id: string; max_points: string },
  actor: string | null,
  now: Date,
  expectedVersion?: number,
) {
  if (expectedVersion !== undefined && expectedVersion !== grade.version) {
    throw new ApiError(409, 'VERSION_CONFLICT', 'The draft grade changed. Reload it before publishing.', {
      currentVersion: String(grade.version),
    });
  }
  const current = await currentRevision(db, grade);
  if (current && !differs(grade, current)) return { changed: false, revision: current };
  const { rows } = await db.query<Revision>(
    `INSERT INTO grade_revisions
       (grade_id, revision_number, points, max_points, feedback, submission_id, attempt_id, published_by, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      grade.id,
      (current?.revision_number ?? 0) + 1,
      grade.points,
      assessment.max_points,
      grade.feedback,
      grade.submission_id,
      grade.attempt_id,
      actor,
      now,
    ],
  );
  await db.query('UPDATE grades SET published_revision_id = $2 WHERE id = $1', [grade.id, rows[0].id]);
  await audit(db, actor, 'GRADE_PUBLISHED', 'GRADE', grade.id, assessment.module_id, { revisionId: rows[0].id });
  return { changed: true, revision: rows[0] };
}
