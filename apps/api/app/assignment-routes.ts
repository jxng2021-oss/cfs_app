import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { assessmentPath, getAssessment } from './assessment-config.js';
import { learnerAssessment, requireOpen } from './assessment-model.js';
import { attachFile, fileDto } from './files.js';
import { currentGrade, currentRevision, lecturerGradeDto, type Grade, type Revision } from './grade-store.js';
import { ApiError, data, id, notFound, pageFields, paged, read } from './http.js';
import { type LearningScope, withLearning } from './learning-access.js';

export type Submission = {
  id: string;
  assessment_id: string;
  student_id: string;
  file_id: string;
  version_number: number;
  submitted_at: Date;
  is_late: boolean;
  original_filename: string;
  size_bytes: number;
};
const submissionSelect =
  'SELECT s.*,f.original_filename,f.size_bytes FROM assignment_submissions s JOIN files f ON f.id=s.file_id';
const body = z.strictObject({ fileId: z.uuid() });
const filters = z.strictObject({
  ...pageFields,
  enrolmentStatus: z.enum(['ACTIVE', 'WITHDRAWN']).default('ACTIVE'),
  submissionStatus: z.enum(['NOT_SUBMITTED', 'MISSING', 'SUBMITTED_ON_TIME', 'SUBMITTED_LATE']).optional(),
  gradingState: z.enum(['NOT_GRADED', 'DRAFT', 'PUBLISHED', 'UNPUBLISHED_CHANGES']).optional(),
});

function receipt(row: Submission, max: number) {
  return {
    submissionId: row.id,
    assessmentId: row.assessment_id,
    versionNumber: row.version_number,
    submittedAt: row.submitted_at,
    isLate: row.is_late,
    remainingSubmissions: max - row.version_number,
    file: fileDto({ id: row.file_id, original_filename: row.original_filename, size_bytes: row.size_bytes }),
  };
}
async function assignment(req: Request, scope: LearningScope) {
  const item = await getAssessment(req, scope);
  if (item.type !== 'ASSIGNMENT' || !item.assignment_settings) notFound();
  if (scope.studentId) await learnerAssessment(scope, item);
  return { item, settings: item.assignment_settings };
}
function submissionStatus(latest: Submission | null, due: Date, now: Date) {
  if (!latest) return now >= due ? 'MISSING' : 'NOT_SUBMITTED';
  return latest.is_late ? 'SUBMITTED_LATE' : 'SUBMITTED_ON_TIME';
}
async function history(scope: LearningScope, assessmentId: string, studentId: string, max: number) {
  const { rows } = await scope.db.query<Submission>(
    submissionSelect + ' WHERE s.assessment_id=$1 AND s.student_id=$2 ORDER BY s.version_number DESC',
    [assessmentId, studentId],
  );
  return {
    current: rows[0] ? receipt(rows[0], max) : null,
    submissions: rows.map((row) => receipt(row, max)),
    usedSubmissions: rows.length,
    remainingSubmissions: max - rows.length,
  };
}

export function assignmentRoutes(services: Services) {
  const router = Router();
  const lecturer = requireRole('LECTURER');
  const student = requireRole('STUDENT');
  const path = assessmentPath + '/submissions';

  router.get(path + '/me', student, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item, settings } = await assignment(req, scope);
        return history(scope, item.id, scope.studentId!, settings.maxSubmissions);
      }),
    ),
  );

  router.post(path, student, async (req, res) => {
    const { fileId } = read(body, req.body);
    const key = read(z.uuid(), req.get('Idempotency-Key'));
    const result = await withLearning(services, req, res, true, async (scope) => {
      const { db } = scope;
      const studentId = scope.studentId!;
      const { item, settings } = await assignment(req, scope);
      const fingerprint = item.id + ':' + fileId;
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['assignment:' + studentId + ':' + key]);
      const replay = (
        await db.query<{ request_fingerprint: string; resource_id: string }>(
          "SELECT request_fingerprint,resource_id FROM idempotency_records WHERE user_id=$1 AND operation='ASSIGNMENT_SUBMIT' AND request_key=$2",
          [studentId, key],
        )
      ).rows[0];
      if (replay) {
        if (replay.request_fingerprint !== fingerprint)
          throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key was used for a different submission.');
        const row = (await db.query<Submission>(submissionSelect + ' WHERE s.id=$1', [replay.resource_id])).rows[0];
        return { status: 200, value: receipt(row, settings.maxSubmissions) };
      }
      await db.query("SELECT id FROM files WHERE id=$1 AND owner_id=$2 AND purpose='SUBMISSION' FOR UPDATE", [
        fileId,
        studentId,
      ]);
      const now = await services.clock(db);
      requireOpen(item, now);
      const prior = (
        await db.query<{ used: number }>(
          'SELECT count(*)::int AS used FROM assignment_submissions WHERE assessment_id=$1 AND student_id=$2',
          [item.id, studentId],
        )
      ).rows[0].used;
      if (prior >= settings.maxSubmissions)
        throw new ApiError(409, 'SUBMISSION_LIMIT_REACHED', 'You have used all submissions.');
      if (await currentGrade(db, item.id, studentId))
        throw new ApiError(409, 'GRADING_STARTED', 'Resubmission is closed because grading has started.');
      const file = await attachFile(db, fileId, studentId, 'SUBMISSION', now, settings);
      const {
        rows: [accepted],
      } = await db.query<Submission>(
        `INSERT INTO assignment_submissions (assessment_id,student_id,file_id,version_number,submitted_at,is_late)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [item.id, studentId, fileId, prior + 1, now, now >= item.due_at],
      );
      await db.query("INSERT INTO idempotency_records VALUES ($1,'ASSIGNMENT_SUBMIT',$2,$3,$4,$5)", [
        studentId,
        key,
        fingerprint,
        accepted.id,
        now,
      ]);
      return {
        status: 201,
        value: receipt(
          { ...accepted, original_filename: file.original_filename, size_bytes: file.size_bytes },
          settings.maxSubmissions,
        ),
      };
    });
    data(res, result.value, result.status);
  });

  router.get(path, lecturer, async (req, res) => {
    const query = read(filters, req.query);
    const result = await withLearning(services, req, res, false, async (scope) => {
      const { item, settings } = await assignment(req, scope);
      type Row = {
        student_id: string;
        display_name: string;
        status: string;
        submission: Submission | null;
        grade: Grade | null;
        revision: Revision | null;
      };
      const { rows } = await scope.db.query<Row>(
        `SELECT e.student_id,u.display_name,e.status,to_jsonb(last) AS submission,
         to_jsonb(g)||jsonb_build_object('points',g.points::text) AS grade,
         to_jsonb(r)||jsonb_build_object('points',r.points::text,'max_points',r.max_points::text) AS revision
         FROM enrolments e JOIN users u ON u.id=e.student_id
         LEFT JOIN LATERAL (` +
          submissionSelect +
          ` WHERE s.assessment_id=$1 AND s.student_id=e.student_id ORDER BY s.version_number DESC LIMIT 1) last ON true
         LEFT JOIN grades g ON g.assessment_id=$1 AND g.student_id=e.student_id LEFT JOIN grade_revisions r ON r.id=g.published_revision_id
         WHERE e.module_id=$2 AND e.status=$3 AND ($3 <> 'ACTIVE' OR u.is_active OR $4) ORDER BY u.display_name,e.student_id`,
        [item.id, scope.module.id, query.enrolmentStatus, scope.module.status === 'ARCHIVED'],
      );
      const entries = rows
        .map((row) => {
          const grade = lecturerGradeDto(row.grade ?? undefined, row.revision ?? undefined);
          return {
            studentId: row.student_id,
            displayName: row.display_name,
            enrolmentStatus: row.status,
            current: row.submission ? receipt(row.submission, settings.maxSubmissions) : null,
            submissionState: submissionStatus(row.submission, item.due_at, scope.asOf),
            grade,
          };
        })
        .filter(
          (row) =>
            (!query.submissionStatus || row.submissionState === query.submissionStatus) &&
            (!query.gradingState || row.grade.state === query.gradingState),
        );
      return {
        entries: entries.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
        total: entries.length,
      };
    });
    paged(res, result.entries, result.total, query.page, query.pageSize);
  });

  router.get(path + '/:studentId/history', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item, settings } = await assignment(req, scope);
        const studentId = id(req, 'studentId');
        if (
          !(
            await scope.db.query('SELECT 1 FROM enrolments WHERE module_id=$1 AND student_id=$2', [
              scope.module.id,
              studentId,
            ])
          ).rowCount
        )
          notFound();
        const grade = await currentGrade(scope.db, item.id, studentId);
        return {
          ...(await history(scope, item.id, studentId, settings.maxSubmissions)),
          grade: lecturerGradeDto(grade, await currentRevision(scope.db, grade)),
        };
      }),
    ),
  );
  return router;
}
