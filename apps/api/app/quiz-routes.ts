import { randomUUID } from 'node:crypto';
import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { assessmentPath, getAssessment } from './assessment-config.js';
import { learnerAssessment, requireOpen } from './assessment-model.js';
import { currentGrade, currentRevision } from './grade-store.js';
import { ApiError, data, empty, id, invalid, notFound, pageFields, paged, read, safeText, version } from './http.js';
import { type LearningScope, withLearning } from './learning-access.js';
import { matchVersion } from './modules.js';
import {
  attemptDto,
  finaliseAttempt,
  makePresentation,
  presentAttempt,
  publishedBest,
  questions,
  type Attempt,
} from './quiz-engine.js';

const optionInput = z.strictObject({ id: z.uuid().optional(), label: safeText(500) });
const questionInput = z.strictObject({
  id: z.uuid().optional(),
  prompt: safeText(2000),
  points: z.number().int().min(1).max(20),
  explanation: z.string().trim().max(2000).default(''),
  options: z.array(optionInput).max(6),
  correctOptionIndex: z.number().int().min(0).max(5).nullable(),
});
const questionSet = z.strictObject({ assessmentVersion: version, questions: z.array(questionInput).max(50) });
const answerInput = z.strictObject({
  selectedOptionId: z.uuid().nullable(),
  expectedRevision: z.number().int().min(0),
});
const attemptStates = z.enum(['IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT']);

async function getQuiz(req: Request, scope: LearningScope) {
  const item = await getAssessment(req, scope);
  if (item.type !== 'QUIZ' || !item.quiz_settings) notFound();
  if (scope.studentId) await learnerAssessment(scope, item);
  return { item, settings: item.quiz_settings };
}

async function getAttempt(req: Request, scope: LearningScope, assessmentId: string) {
  const row = (
    await scope.db.query<Attempt>(
      'SELECT * FROM quiz_attempts WHERE id=$1 AND assessment_id=$2 AND ($3::uuid IS NULL OR student_id=$3)',
      [id(req, 'attemptId'), assessmentId, scope.studentId],
    )
  ).rows[0];
  if (!row) notFound();
  return row;
}

async function editor(scope: LearningScope, item: Awaited<ReturnType<typeof getQuiz>>['item']) {
  const bank = await questions(scope.db, item.id);
  return {
    assessmentVersion: item.version,
    maxPoints: item.max_points === '0.00' ? null : item.max_points,
    questions: bank.map((question) => ({
      id: question.id,
      prompt: question.prompt,
      points: question.points,
      explanation: question.explanation,
      options: question.options,
      correctOptionId: question.correct_option_id,
      correctOptionIndex: question.correct_option_id
        ? question.options.findIndex((option) => option.id === question.correct_option_id)
        : null,
    })),
  };
}

export function quizRoutes(services: Services) {
  const router = Router();
  const lecturer = requireRole('LECTURER');
  const student = requireRole('STUDENT');
  const path = assessmentPath + '/attempts';
  const attemptPath = path + '/:attemptId';

  router.get(assessmentPath + '/questions', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        return editor(scope, (await getQuiz(req, scope)).item);
      }),
    ),
  );

  router.put(assessmentPath + '/questions', lecturer, async (req, res) => {
    const input = read(questionSet, req.body);
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { item } = await getQuiz(req, scope);
        matchVersion(input.assessmentVersion, item.version);
        if (item.status !== 'DRAFT')
          throw new ApiError(409, 'INVALID_STATE', 'Published quiz questions cannot be changed.');
        const existing = new Map((await questions(scope.db, item.id)).map((question) => [question.id, question]));
        const questionIds = new Set<string>();
        const optionIds = new Set<string>();
        let maxPoints = 0;
        const replacement = input.questions.map((question) => {
          const questionId = question.id ?? randomUUID();
          if (questionIds.has(questionId) || (question.id && !existing.has(question.id)))
            invalid('A question ID is unknown or repeated.');
          questionIds.add(questionId);
          const previousOptions = new Set(existing.get(questionId)?.options.map((option) => option.id));
          if (new Set(question.options.map((option) => option.label)).size !== question.options.length)
            invalid('Options within a question must have distinct labels.');
          if (question.correctOptionIndex !== null && question.correctOptionIndex >= question.options.length)
            invalid('Select a correct option that exists in its question.');
          const options = question.options.map((option) => {
            const optionId = option.id ?? randomUUID();
            if (optionIds.has(optionId) || (option.id && !previousOptions.has(option.id)))
              invalid('An option ID is unknown or repeated.');
            optionIds.add(optionId);
            return { ...option, id: optionId };
          });
          maxPoints += question.points;
          return {
            ...question,
            id: questionId,
            options,
            correctId: question.correctOptionIndex === null ? null : options[question.correctOptionIndex].id,
          };
        });
        await scope.db.query('DELETE FROM quiz_questions WHERE assessment_id=$1', [item.id]);
        for (const [position, question] of replacement.entries()) {
          await scope.db.query(
            'INSERT INTO quiz_questions (id,assessment_id,prompt,points,position,explanation,correct_option_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
            [
              question.id,
              item.id,
              question.prompt,
              question.points,
              position + 1,
              question.explanation,
              question.correctId,
            ],
          );
          for (const [index, option] of question.options.entries()) {
            await scope.db.query('INSERT INTO quiz_options (id,question_id,label,position) VALUES ($1,$2,$3,$4)', [
              option.id,
              question.id,
              option.label,
              index + 1,
            ]);
          }
        }
        const {
          rows: [updated],
        } = await scope.db.query<{ version: number; max_points: string }>(
          'UPDATE assessments SET version=version+1,max_points=$2,updated_at=$3 WHERE id=$1 RETURNING version,max_points',
          [item.id, maxPoints, scope.now],
        );
        return editor(scope, { ...item, ...updated });
      }),
    );
  });

  router.get(path + '/me', student, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item, settings } = await getQuiz(req, scope);
        const { rows } = await scope.db.query<Attempt>(
          'SELECT * FROM quiz_attempts WHERE assessment_id=$1 AND student_id=$2 ORDER BY attempt_number DESC',
          [item.id, scope.studentId],
        );
        const released = await currentRevision(scope.db, await currentGrade(scope.db, item.id, scope.studentId!));
        return {
          attempts: rows.map((attempt) => attemptDto(attempt, scope.now)),
          attemptsUsed: rows.length,
          attemptsRemaining: settings.maxAttempts - rows.length,
          currentAttemptId: rows.find((attempt) => attempt.status === 'IN_PROGRESS')?.id ?? null,
          publishedBest: await publishedBest(scope.db, { assessment_id: item.id, student_id: scope.studentId! }),
          reviewAttemptId:
            settings.showAnswerReview && scope.asOf >= item.due_at ? (released?.attempt_id ?? null) : null,
        };
      }),
    ),
  );

  router.post(path, student, async (req, res) => {
    read(empty, req.body ?? {});
    const result = await withLearning(services, req, res, true, async (scope) => {
      const { item, settings } = await getQuiz(req, scope);
      requireOpen(item, scope.now);
      const { rows } = await scope.db.query<Attempt>(
        'SELECT * FROM quiz_attempts WHERE assessment_id=$1 AND student_id=$2 ORDER BY attempt_number DESC',
        [item.id, scope.studentId],
      );
      const existing = rows.find((attempt) => attempt.status === 'IN_PROGRESS');
      if (existing) return { attempt: await presentAttempt(scope.db, existing, scope.now), created: false };
      if (rows.length >= settings.maxAttempts)
        throw new ApiError(409, 'ATTEMPT_LIMIT_REACHED', 'You have used all attempts for this quiz.');
      const expires =
        settings.timeLimitMinutes === null
          ? item.due_at
          : new Date(Math.min(item.due_at.getTime(), scope.now.getTime() + settings.timeLimitMinutes * 60_000));
      const presentation = makePresentation(
        await questions(scope.db, item.id),
        settings.shuffleQuestions,
        settings.shuffleOptions,
      );
      const {
        rows: [attempt],
      } = await scope.db.query<Attempt>(
        `INSERT INTO quiz_attempts (assessment_id,student_id,attempt_number,status,started_at,expires_at,max_points,presentation)
         VALUES ($1,$2,$3,'IN_PROGRESS',$4,$5,$6,$7) RETURNING *`,
        [
          item.id,
          scope.studentId,
          rows.length + 1,
          scope.now,
          expires,
          item.max_points,
          JSON.stringify(presentation),
        ],
      );
      return { attempt: await presentAttempt(scope.db, attempt, scope.now), created: true };
    });
    data(res, result.attempt, result.created ? 201 : 200);
  });

  router.get(attemptPath, student, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item } = await getQuiz(req, scope);
        const attempt = await getAttempt(req, scope, item.id);
        const view = await presentAttempt(scope.db, attempt, scope.now);
        return attempt.status === 'IN_PROGRESS'
          ? view
          : { ...view, publishedBest: await publishedBest(scope.db, attempt) };
      }),
    ),
  );

  router.put(attemptPath + '/answers/:questionId', student, async (req, res) => {
    const input = read(answerInput, req.body);
    const questionId = id(req, 'questionId');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { item } = await getQuiz(req, scope);
        const attempt = await getAttempt(req, scope, item.id);
        if (attempt.status === 'TIMED_OUT') throw new ApiError(409, 'ATTEMPT_EXPIRED', 'The attempt has expired.');
        if (attempt.status !== 'IN_PROGRESS')
          throw new ApiError(409, 'INVALID_STATE', 'This attempt is already finalised.');
        const question = attempt.presentation.find((value) => value.questionId === questionId);
        if (!question || (input.selectedOptionId && !question.optionIds.includes(input.selectedOptionId)))
          invalid('Select an option for this question.');
        type Saved = { selected_option_id: string | null; revision: number; updated_at: Date };
        const current = (
          await scope.db.query<Saved>(
            'SELECT selected_option_id,revision,updated_at FROM quiz_answers WHERE attempt_id=$1 AND question_id=$2',
            [attempt.id, questionId],
          )
        ).rows[0];
        if (input.expectedRevision !== (current?.revision ?? 0)) {
          if (
            current?.revision === input.expectedRevision + 1 &&
            current.selected_option_id === input.selectedOptionId
          ) {
            return {
              questionId,
              selectedOptionId: current.selected_option_id,
              revision: current.revision,
              savedAt: current.updated_at,
            };
          }
          throw new ApiError(409, 'VERSION_CONFLICT', 'A newer selection has already been saved.', {
            currentRevision: String(current?.revision ?? 0),
          });
        }
        const next = (current?.revision ?? 0) + 1;
        await scope.db.query(
          `INSERT INTO quiz_answers (attempt_id,question_id,selected_option_id,revision,updated_at) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (attempt_id,question_id) DO UPDATE SET selected_option_id=excluded.selected_option_id,revision=excluded.revision,updated_at=excluded.updated_at`,
          [attempt.id, questionId, input.selectedOptionId, next, scope.now],
        );
        return { questionId, selectedOptionId: input.selectedOptionId, revision: next, savedAt: scope.now };
      }),
    );
  });

  router.post(attemptPath + '/submit', student, async (req, res) => {
    read(empty, req.body ?? {});
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { item } = await getQuiz(req, scope);
        const final = await finaliseAttempt(scope.db, await getAttempt(req, scope, item.id), scope.now);
        return { ...attemptDto(final, scope.now), publishedBest: await publishedBest(scope.db, final) };
      }),
    );
  });

  router.get(attemptPath + '/review', student, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item, settings } = await getQuiz(req, scope);
        const attempt = await getAttempt(req, scope, item.id);
        const snapshot = await currentRevision(scope.db, await currentGrade(scope.db, item.id, scope.studentId!));
        if (!settings.showAnswerReview || scope.asOf < item.due_at || snapshot?.attempt_id !== attempt.id) {
          throw new ApiError(
            403,
            'REVIEW_NOT_AVAILABLE',
            'Answer review is available only for the released best attempt after the quiz closes.',
          );
        }
        return {
          ...(await presentAttempt(scope.db, attempt, scope.now, true)),
          points: attempt.points,
          maxPoints: attempt.max_points,
        };
      }),
    ),
  );

  router.get(path, lecturer, async (req, res) => {
    const query = read(
      z.strictObject({ ...pageFields, studentId: z.uuid().optional(), status: attemptStates.optional() }),
      req.query,
    );
    const result = await withLearning(services, req, res, false, async (scope) => {
      const { item } = await getQuiz(req, scope);
      const filter =
        'FROM quiz_attempts a JOIN users u ON u.id=a.student_id WHERE a.assessment_id=$1 AND ($2::uuid IS NULL OR a.student_id=$2) AND ($3::text IS NULL OR a.status=$3)';
      const args = [item.id, query.studentId, query.status];
      const { rows } = await scope.db.query<Attempt & { display_name: string }>(
        'SELECT a.*,u.display_name ' + filter + ' ORDER BY a.started_at DESC,a.id LIMIT $4 OFFSET $5',
        [...args, query.pageSize, (query.page - 1) * query.pageSize],
      );
      const total = (await scope.db.query<{ total: number }>('SELECT count(*)::int AS total ' + filter, args)).rows[0]
        .total;
      return {
        total,
        entries: rows.map((attempt) => ({
          ...attemptDto(attempt, scope.now),
          studentId: attempt.student_id,
          displayName: attempt.display_name,
          points: attempt.points,
          maxPoints: attempt.points === null ? null : attempt.max_points,
        })),
      };
    });
    paged(res, result.entries, result.total, query.page, query.pageSize);
  });

  router.get(attemptPath + '/marking-detail', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { item } = await getQuiz(req, scope);
        const attempt = await getAttempt(req, scope, item.id);
        if (attempt.status === 'IN_PROGRESS') return attemptDto(attempt, scope.now);
        return {
          ...(await presentAttempt(scope.db, attempt, scope.now, true)),
          points: attempt.points,
          maxPoints: attempt.max_points,
          studentId: attempt.student_id,
          bestAttempt: (await currentGrade(scope.db, item.id, attempt.student_id))?.attempt_id === attempt.id,
        };
      }),
    ),
  );
  return router;
}
