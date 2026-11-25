import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { audit, type Db } from './db.js';
import { decimal, hundredths } from './decimal.js';
import { ApiError, data, id, invalid, pageFields, paged, read, safeText, version } from './http.js';
import { matchVersion } from './modules.js';
import {
  allocatedWeight,
  assessmentDto,
  assessmentSelect,
  assessmentTypes,
  effectiveClose,
  extensions,
  learnerAssessment,
  learnerDetail,
  learnerSummary,
  selectAssessment,
  visibleAssessment,
  type Assessment,
  type AssignmentSettings,
  type QuizSettings,
} from './assessment-model.js';
import { withLearning, type LearningScope } from './learning-access.js';
import { questions } from './quiz-engine.js';
import { releaseRequirements, topicLocked } from './release-store.js';

const when = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const shared = z.strictObject({
  title: safeText(120),
  description: z.string().trim().max(10000),
  topicId: z.uuid().nullable(),
  openAt: when,
  dueAt: when,
  closeAt: when.nullable(),
  weightPct: decimal(100),
  maxPoints: decimal(1000, 0.01),
});
const assignment = z.strictObject({
  instructions: safeText(20000),
  allowLateSubmission: z.boolean().default(false),
  maxSubmissions: z.number().int().min(1).max(5).default(1),
  allowedExtensions: z
    .array(z.enum(extensions))
    .min(1)
    .max(10)
    .refine((values) => new Set(values).size === values.length, 'Extensions must be unique.')
    .default(['pdf', 'docx', 'zip']),
  maxFileMiB: z.number().int().min(1).max(20).default(10),
});
const quiz = z.strictObject({
  instructions: z.string().trim().max(20000).default(''),
  timeLimitMinutes: z.number().int().min(1).max(180).nullable().default(20),
  maxAttempts: z.number().int().min(1).max(5).default(1),
  shuffleQuestions: z.boolean().default(false),
  shuffleOptions: z.boolean().default(false),
  resultRelease: z.enum(['IMMEDIATE', 'MANUAL']).default('IMMEDIATE'),
  showAnswerReview: z.boolean().default(false),
});
const createFields = shared
  .partial()
  .required({ title: true, openAt: true, dueAt: true })
  .extend({
    type: z.enum(assessmentTypes),
    assignmentSettings: assignment.optional(),
    quizSettings: quiz.optional(),
  });
const assignmentEdit = z.strictObject({
  instructions: assignment.shape.instructions.optional(),
  allowLateSubmission: assignment.shape.allowLateSubmission.removeDefault().optional(),
  maxSubmissions: assignment.shape.maxSubmissions.removeDefault().optional(),
  allowedExtensions: assignment.shape.allowedExtensions.removeDefault().optional(),
  maxFileMiB: assignment.shape.maxFileMiB.removeDefault().optional(),
});
const quizEdit = z.strictObject({
  instructions: quiz.shape.instructions.removeDefault().optional(),
  timeLimitMinutes: quiz.shape.timeLimitMinutes.removeDefault().optional(),
  maxAttempts: quiz.shape.maxAttempts.removeDefault().optional(),
  shuffleQuestions: quiz.shape.shuffleQuestions.removeDefault().optional(),
  shuffleOptions: quiz.shape.shuffleOptions.removeDefault().optional(),
  resultRelease: quiz.shape.resultRelease.removeDefault().optional(),
  showAnswerReview: quiz.shape.showAnswerReview.removeDefault().optional(),
});
const editFields = shared.partial().extend({
  version,
  assignmentSettings: assignmentEdit.optional(),
  quizSettings: quizEdit.optional(),
});
const filters = z.strictObject({
  ...pageFields,
  type: z.enum(assessmentTypes).optional(),
  status: z.enum(['DRAFT', 'PUBLISHED']).optional(),
});

function validateWindow(
  open: Date,
  due: Date,
  close: Date | null,
  type: Assessment['type'],
  settings: AssignmentSettings | null,
) {
  if (due <= open) invalid('The due date must be later than the open date.');
  if (type === 'QUIZ' && close?.getTime() !== due.getTime()) invalid('Quizzes close at their due date.');
  if (settings?.allowLateSubmission && (!close || close <= due))
    invalid('Set a closing time after the due date to allow late submissions.');
  if (settings && !settings.allowLateSubmission && close && close.getTime() !== due.getTime())
    invalid('An assignment without late submissions closes at its due date.');
}

async function validateTopic(db: Db, moduleId: string, topicId: string | null, published = false) {
  if (!topicId) return;
  const row = (
    await db.query<{ status: string }>('SELECT status FROM topics WHERE id=$1 AND module_id=$2', [topicId, moduleId])
  ).rows[0];
  if (!row || (published && row.status !== 'PUBLISHED'))
    invalid(published ? 'Publish the linked topic first.' : 'Select a topic in this module.');
}

async function saveSettings(
  db: Db,
  assessmentId: string,
  assignmentSettings: AssignmentSettings | null,
  quizSettings: QuizSettings | null,
) {
  if (assignmentSettings) {
    const s = assignmentSettings;
    await db.query(
      `INSERT INTO assignment_settings VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (assessment_id) DO UPDATE SET
        instructions=excluded.instructions,allow_late_submission=excluded.allow_late_submission,max_submissions=excluded.max_submissions,
        allowed_extensions=excluded.allowed_extensions,max_file_mib=excluded.max_file_mib`,
      [assessmentId, s.instructions, s.allowLateSubmission, s.maxSubmissions, s.allowedExtensions, s.maxFileMiB],
    );
  }
  if (quizSettings) {
    const q = quizSettings;
    await db.query(
      `INSERT INTO quiz_settings VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (assessment_id) DO UPDATE SET
        instructions=excluded.instructions,time_limit_minutes=excluded.time_limit_minutes,max_attempts=excluded.max_attempts,shuffle_questions=excluded.shuffle_questions,
        shuffle_options=excluded.shuffle_options,result_release=excluded.result_release,show_answer_review=excluded.show_answer_review`,
      [
        assessmentId,
        q.instructions,
        q.timeLimitMinutes,
        q.maxAttempts,
        q.shuffleQuestions,
        q.shuffleOptions,
        q.resultRelease,
        q.showAnswerReview,
      ],
    );
  }
}

export const assessmentsPath = '/modules/:moduleId/assessments';
export const assessmentPath = assessmentsPath + '/:assessmentId';

export function assessmentConfigRoutes(services: Services) {
  const router = Router();
  const lecturer = requireRole('LECTURER');

  router.get(assessmentsPath, async (req, res) => {
    const query = read(filters, req.query);
    const result = await withLearning(services, req, res, false, async (scope) => {
      const { db, module, studentId } = scope;
      const { rows } = await db.query<Assessment>(
        assessmentSelect + ' WHERE a.module_id=$1 ORDER BY a.due_at,a.title,a.id',
        [module.id],
      );
      const eligible = rows.filter(
        (item) =>
          (!query.type || item.type === query.type) &&
          (!query.status || query.status === item.status) &&
          (!studentId || visibleAssessment(item)),
      );
      const slice = eligible.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
      if (!studentId) return { total: eligible.length, entries: slice.map(assessmentDto) };
      const layout = await releaseRequirements(db, module.id, studentId);
      const ids = slice.map((item) => item.id);
      const { rows: submissions } = await db.query<{ assessment_id: string; is_late: boolean }>(
        'SELECT DISTINCT ON (assessment_id) assessment_id,is_late FROM assignment_submissions WHERE student_id=$1 AND assessment_id=ANY($2::uuid[]) ORDER BY assessment_id,version_number DESC',
        [studentId, ids],
      );
      const { rows: attempts } = await db.query<{ assessment_id: string; used: number; active: string | null }>(
        "SELECT assessment_id,count(*)::int AS used,(array_agg(id) FILTER (WHERE status='IN_PROGRESS'))[1] AS active FROM quiz_attempts WHERE student_id=$1 AND assessment_id=ANY($2::uuid[]) GROUP BY assessment_id",
        [studentId, ids],
      );
      const latestFiles = new Map(submissions.map((row) => [row.assessment_id, row]));
      const latestAttempts = new Map(attempts.map((row) => [row.assessment_id, row]));
      const entries = slice.map((item) => {
        if (topicLocked(layout, item.topic_id)) return learnerSummary(scope, item, true);
        const summary = learnerSummary(scope, item, false);
        if (item.type === 'QUIZ') {
          const attempt = latestAttempts.get(item.id);
          return { ...summary, attemptsUsed: attempt?.used ?? 0, currentAttemptId: attempt?.active ?? null };
        }
        const latest = latestFiles.get(item.id);
        return {
          ...summary,
          submissionState: latest
            ? latest.is_late
              ? 'SUBMITTED_LATE'
              : 'SUBMITTED_ON_TIME'
            : scope.asOf >= item.due_at
              ? 'MISSING'
              : 'NOT_SUBMITTED',
        };
      });
      return { total: eligible.length, entries };
    });
    paged(res, result.entries, result.total, query.page, query.pageSize);
  });

  router.post(assessmentsPath, lecturer, async (req, res) => {
    const input = read(createFields, req.body);
    const quizType = input.type === 'QUIZ';
    if (
      (quizType && (input.assignmentSettings || input.maxPoints)) ||
      (!quizType && (!input.assignmentSettings || input.quizSettings))
    )
      invalid('Supply the settings for the selected assessment type only.');
    const assignmentSettings = input.assignmentSettings ?? null;
    const quizSettings = quizType ? read(quiz, input.quizSettings ?? {}) : null;
    const close = input.closeAt === undefined ? (quizType ? input.dueAt : null) : input.closeAt;
    validateWindow(input.openAt, input.dueAt, close, input.type, assignmentSettings);
    const result = await withLearning(services, req, res, true, async ({ db, module }) => {
      await validateTopic(db, module.id, input.topicId ?? null);
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO assessments (module_id,topic_id,type,title,description,open_at,due_at,close_at,max_points,weight_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          module.id,
          input.topicId ?? null,
          input.type,
          input.title,
          input.description ?? '',
          input.openAt,
          input.dueAt,
          close,
          quizType ? '0' : (input.maxPoints ?? '100'),
          input.weightPct ?? '0',
        ],
      );
      await saveSettings(db, rows[0].id, assignmentSettings, quizSettings);
      return assessmentDto(await selectAssessment(db, module.id, rows[0].id));
    });
    data(res, result, 201);
  });

  router.get(assessmentPath, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const item = await getAssessment(req, scope);
        return scope.studentId
          ? learnerDetail(scope, item, await learnerAssessment(scope, item, false))
          : assessmentDto(item);
      }),
    ),
  );

  router.patch(assessmentPath, lecturer, async (req, res) => {
    const input = read(editFields, req.body);
    if (Object.keys(input).length < 2) invalid('Provide at least one change.');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { db, module } = scope;
        const item = await getAssessment(req, scope);
        matchVersion(input.version, item.version);
        if (
          item.status === 'PUBLISHED' &&
          Object.keys(input).some((key) => !['title', 'description', 'version'].includes(key))
        ) {
          throw new ApiError(409, 'INVALID_STATE', 'Only the title and description can change after publication.');
        }
        if (
          (item.type === 'QUIZ' && (input.assignmentSettings || input.maxPoints)) ||
          (item.type === 'ASSIGNMENT' && input.quizSettings)
        )
          invalid('Supply settings for the existing assessment type.');
        const settings = item.assignment_settings
          ? read(assignment, { ...item.assignment_settings, ...input.assignmentSettings })
          : null;
        const quizSettings = item.quiz_settings ? read(quiz, { ...item.quiz_settings, ...input.quizSettings }) : null;
        const topicId = input.topicId === undefined ? item.topic_id : input.topicId;
        const open = input.openAt ?? item.open_at;
        const due = input.dueAt ?? item.due_at;
        const close = input.closeAt !== undefined ? input.closeAt : item.type === 'QUIZ' ? due : item.close_at;
        validateWindow(open, due, close, item.type, settings);
        await validateTopic(db, module.id, topicId);
        await db.query(
          `UPDATE assessments SET title=$2,description=$3,topic_id=$4,open_at=$5,due_at=$6,close_at=$7,max_points=$8,
         weight_pct=$9,version=version+1,updated_at=$10 WHERE id=$1`,
          [
            item.id,
            input.title ?? item.title,
            input.description ?? item.description,
            topicId,
            open,
            due,
            close,
            input.maxPoints ?? item.max_points,
            input.weightPct ?? item.weight_pct,
            scope.now,
          ],
        );
        if (input.assignmentSettings || input.quizSettings) await saveSettings(db, item.id, settings, quizSettings);
        return assessmentDto(await selectAssessment(db, module.id, item.id));
      }),
    );
  });

  router.post(assessmentPath + '/publish', lecturer, async (req, res) => {
    const input = read(z.strictObject({ version }), req.body);
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { db, module, now } = scope;
        const item = await getAssessment(req, scope);
        matchVersion(input.version, item.version);
        if (item.status !== 'DRAFT')
          throw new ApiError(409, 'INVALID_STATE', 'This assessment is already published.');
        if (now >= effectiveClose(item))
          throw new ApiError(409, 'ASSESSMENT_CLOSED', 'The assessment has already reached its closing time.');
        await validateTopic(db, module.id, item.topic_id, true);
        if (item.type === 'QUIZ') {
          const bank = await questions(db, item.id);
          if (
            !bank.length ||
            bank.some(
              (question) =>
                question.options.length < 2 ||
                !question.options.some((option) => option.id === question.correct_option_id),
            )
          ) {
            invalid('Each quiz needs at least one question, two to six options per question and one correct answer.');
          }
        }
        const weight = await allocatedWeight(db, module.id);
        if (hundredths(item.weight_pct) > hundredths(weight.remainingWeight))
          throw new ApiError(409, 'WEIGHT_BUDGET_EXCEEDED', 'Published weights cannot exceed 100%.', weight);
        await db.query(
          "UPDATE assessments SET status='PUBLISHED',published_at=$2,updated_at=$2,version=version+1 WHERE id=$1",
          [item.id, now],
        );
        await audit(db, scope.actorId, 'ASSESSMENT_PUBLISHED', 'ASSESSMENT', item.id, module.id);
        return assessmentDto(await selectAssessment(db, module.id, item.id));
      }),
    );
  });

  router.delete(assessmentPath, lecturer, async (req, res) => {
    await withLearning(services, req, res, true, async (scope) => {
      const item = await getAssessment(req, scope);
      if (item.status !== 'DRAFT')
        throw new ApiError(409, 'INVALID_STATE', 'Published assessments cannot be deleted.');
      await scope.db.query('DELETE FROM assessments WHERE id=$1', [item.id]);
    });
    res.status(204).end();
  });

  router.get('/modules/:moduleId/weight-budget', lecturer, async (req, res) =>
    data(res, await withLearning(services, req, res, false, ({ db, module }) => allocatedWeight(db, module.id))),
  );
  return router;
}

export function getAssessment(req: Parameters<typeof id>[0], { db, module }: LearningScope) {
  return selectAssessment(db, module.id, id(req, 'assessmentId'));
}
