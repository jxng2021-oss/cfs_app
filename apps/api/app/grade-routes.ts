import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { assessmentPath, getAssessment } from './assessment-config.js';
import { decimal, hundredths } from './decimal.js';
import {
  currentGrade,
  currentRevision,
  differs,
  lecturerGradeDto,
  publishGrade,
  revisionDto,
  type Grade,
  type Revision,
} from './grade-store.js';
import { ApiError, data, id, invalid, notFound, read, version } from './http.js';
import { withLearning } from './learning-access.js';

const draftInput = z.strictObject({
  points: decimal(1000),
  feedback: z.string().trim().max(5000).default(''),
  expectedVersion: z.number().int().min(0),
});
const publication = z.strictObject({ expectedVersion: version });
const bulk = z.strictObject({
  grades: z
    .array(z.strictObject({ studentId: z.uuid(), expectedVersion: version }))
    .min(1)
    .max(100),
});

export function gradeRoutes(services: Services) {
  const router = Router();
  const lecturer = requireRole('LECTURER');
  const path = assessmentPath + '/grades';
  router.put(path + '/:studentId/draft', lecturer, async (req, res) => {
    const input = read(draftInput, req.body);
    const studentId = id(req, 'studentId');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const item = await getAssessment(req, scope);
        if (item.type !== 'ASSIGNMENT' || item.status !== 'PUBLISHED')
          throw new ApiError(
            409,
            'INVALID_STATE',
            'Only published assignments can have manually entered draft grades.',
          );
        if (hundredths(input.points) > hundredths(item.max_points))
          invalid('The grade cannot exceed the assignment’s maximum points.');
        const { db } = scope;
        const source = (
          await db.query<{ id: string }>(
            'SELECT id FROM assignment_submissions WHERE assessment_id=$1 AND student_id=$2 ORDER BY version_number DESC LIMIT 1',
            [item.id, studentId],
          )
        ).rows[0];
        if (!source) notFound();
        const existing = await currentGrade(db, item.id, studentId);
        if (input.expectedVersion !== (existing?.version ?? 0))
          throw new ApiError(409, 'VERSION_CONFLICT', 'The grade changed. Reload it before saving.', {
            currentVersion: String(existing?.version ?? 0),
          });
        const {
          rows: [grade],
        } = await db.query<Grade>(
          `INSERT INTO grades (assessment_id,student_id,points,feedback,submission_id,draft_updated_at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (assessment_id,student_id) DO UPDATE SET points=excluded.points,feedback=excluded.feedback,submission_id=excluded.submission_id,
           draft_updated_at=excluded.draft_updated_at,version=grades.version+1 RETURNING *`,
          [item.id, studentId, input.points, input.feedback, source.id, scope.now],
        );
        return lecturerGradeDto(grade, await currentRevision(db, grade));
      }),
    );
  });

  router.get(path + '/publication-preview', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const item = await getAssessment(req, scope);
        type Row = Grade & { display_name: string; status: string; revision: Revision | null };
        const { rows } = await scope.db.query<Row>(
          `SELECT g.*,u.display_name,e.status,to_jsonb(r)||jsonb_build_object('points',r.points::text,'max_points',r.max_points::text) AS revision
       FROM grades g JOIN users u ON u.id=g.student_id JOIN enrolments e ON e.student_id=g.student_id AND e.module_id=$2
       LEFT JOIN grade_revisions r ON r.id=g.published_revision_id WHERE g.assessment_id=$1 ORDER BY u.display_name,g.student_id`,
          [item.id, scope.module.id],
        );
        const grades = rows
          .filter((row) => differs(row, row.revision ?? undefined))
          .map((row) => ({
            studentId: row.student_id,
            displayName: row.display_name,
            enrolmentStatus: row.status,
            expectedVersion: row.version,
          }));
        return { count: grades.length, grades };
      }),
    ),
  );

  router.post(path + '/publish-bulk', lecturer, async (req, res) => {
    const input = read(bulk, req.body);
    if (new Set(input.grades.map((grade) => grade.studentId)).size !== input.grades.length)
      invalid('Each student may appear only once.');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const item = await getAssessment(req, scope);
        const results = [];
        let publishedCount = 0;
        let unchangedCount = 0;
        let failedCount = 0;
        for (const row of input.grades) {
          const draft = await currentGrade(scope.db, item.id, row.studentId);
          if (!draft || draft.version !== row.expectedVersion) {
            failedCount++;
            results.push({
              studentId: row.studentId,
              status: 'FAILED',
              errorCode: draft ? 'VERSION_CONFLICT' : 'NOT_FOUND',
            });
            continue;
          }
          const published = await publishGrade(scope.db, draft, item, scope.actorId, scope.now, row.expectedVersion);
          if (published.changed) publishedCount++;
          else unchangedCount++;
          results.push({
            studentId: row.studentId,
            status: published.changed ? 'PUBLISHED' : 'UNCHANGED',
            revisionId: published.revision.id,
          });
        }
        return { publishedCount, unchangedCount, failedCount, results };
      }),
    );
  });

  router.post(path + '/:studentId/publish', lecturer, async (req, res) => {
    const input = read(publication, req.body);
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const item = await getAssessment(req, scope);
        const grade = await currentGrade(scope.db, item.id, id(req, 'studentId'));
        if (!grade) notFound();
        const result = await publishGrade(scope.db, grade, item, scope.actorId, scope.now, input.expectedVersion);
        return { changed: result.changed, revision: revisionDto(result.revision) };
      }),
    );
  });

  router.get(path + '/:studentId/revisions', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const item = await getAssessment(req, scope);
        const studentId = id(req, 'studentId');
        const grade = await currentGrade(scope.db, item.id, studentId);
        if (!grade) {
          if (
            !(
              await scope.db.query('SELECT 1 FROM enrolments WHERE module_id=$1 AND student_id=$2', [
                scope.module.id,
                studentId,
              ])
            ).rowCount
          )
            notFound();
          return [];
        }
        const { rows } = await scope.db.query<Revision>(
          'SELECT * FROM grade_revisions WHERE grade_id=$1 ORDER BY revision_number DESC',
          [grade.id],
        );
        return rows.map((revision) => ({
          ...revisionDto(revision),
          revisionNumber: revision.revision_number,
          sourceSubmissionId: revision.submission_id,
          sourceAttemptId: revision.attempt_id,
          actorId: revision.published_by,
        }));
      }),
    ),
  );
  return router;
}
