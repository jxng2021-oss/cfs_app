import { randomInt } from 'node:crypto';
import type { Db } from './db.js';
import { currentGrade, currentRevision, publishGrade, revisionDto, type Grade } from './grade-store.js';

export type QuizQuestion = {
  id: string;
  prompt: string;
  points: number;
  explanation: string;
  correct_option_id: string | null;
  options: { id: string; label: string }[];
};
export type Presentation = { questionId: string; optionIds: string[] }[];
export type Attempt = {
  id: string;
  assessment_id: string;
  student_id: string;
  attempt_number: number;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'TIMED_OUT';
  started_at: Date;
  expires_at: Date;
  finished_at: Date | null;
  processed_at: Date | null;
  presentation: Presentation;
  points: string | null;
  max_points: string;
};
type Answer = { question_id: string; selected_option_id: string | null; revision: number };

export async function questions(db: Db, assessmentId: string) {
  return (
    await db.query<QuizQuestion>(
      `SELECT q.id, q.prompt, q.points, q.explanation, q.correct_option_id,
       coalesce((SELECT jsonb_agg(jsonb_build_object('id', o.id, 'label', o.label) ORDER BY o.position) FROM quiz_options o WHERE o.question_id = q.id), '[]') AS options
     FROM quiz_questions q WHERE q.assessment_id = $1 ORDER BY q.position`,
      [assessmentId],
    )
  ).rows;
}

function shuffle<T>(values: T[]) {
  const result = values.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function makePresentation(bank: QuizQuestion[], shuffleQuestions: boolean, shuffleOptions: boolean) {
  return (shuffleQuestions ? shuffle(bank) : bank).map((question) => {
    const ids = question.options.map((option) => option.id);
    return { questionId: question.id, optionIds: shuffleOptions ? shuffle(ids) : ids };
  });
}

export function attemptDto(attempt: Attempt, now: Date) {
  return {
    attemptId: attempt.id,
    attemptNumber: attempt.attempt_number,
    status: attempt.status,
    serverNow: now,
    startedAt: attempt.started_at,
    expiresAt: attempt.expires_at,
    finishedAt: attempt.finished_at,
    questionCount: attempt.presentation.length,
  };
}

export async function presentAttempt(db: Db, attempt: Attempt, now: Date, review = false) {
  const bank = new Map((await questions(db, attempt.assessment_id)).map((question) => [question.id, question]));
  const answers = new Map(
    (
      await db.query<Answer>(
        'SELECT question_id, selected_option_id, revision FROM quiz_answers WHERE attempt_id = $1',
        [attempt.id],
      )
    ).rows.map((row) => [row.question_id, row]),
  );
  const presented = attempt.presentation.map(({ questionId, optionIds }) => {
    const question = bank.get(questionId)!;
    const options = new Map(question.options.map((option) => [option.id, option]));
    const answer = answers.get(questionId);
    return {
      id: question.id,
      prompt: question.prompt,
      points: question.points,
      options: optionIds.map((id) => options.get(id)!),
      selectedOptionId: answer?.selected_option_id ?? null,
      revision: answer?.revision ?? 0,
      ...(review
        ? {
            correctOptionId: question.correct_option_id,
            explanation: question.explanation,
            earnedPoints: answer?.selected_option_id === question.correct_option_id ? question.points : 0,
          }
        : {}),
    };
  });
  return {
    ...attemptDto(attempt, now),
    questions: presented,
    answeredCount: presented.filter((item) => item.selectedOptionId).length,
  };
}

export async function publishedBest(db: Db, attempt: Pick<Attempt, 'assessment_id' | 'student_id'>) {
  return revisionDto(await currentRevision(db, await currentGrade(db, attempt.assessment_id, attempt.student_id)));
}

export async function finaliseAttempt(db: Db, attempt: Attempt, now: Date) {
  if (attempt.status !== 'IN_PROGRESS') return attempt;
  const expired = now >= attempt.expires_at;
  const result = await db.query<Attempt>(
    `UPDATE quiz_attempts a SET status = $2, finished_at = $3, processed_at = $4, points = (
       SELECT coalesce(sum(q.points), 0) FROM quiz_answers ans JOIN quiz_questions q ON q.id = ans.question_id
       WHERE ans.attempt_id = a.id AND q.assessment_id = a.assessment_id AND ans.selected_option_id = q.correct_option_id
     ) WHERE a.id = $1 AND a.status = 'IN_PROGRESS' RETURNING a.*`,
    [attempt.id, expired ? 'TIMED_OUT' : 'SUBMITTED', expired ? attempt.expires_at : now, now],
  );
  const final = result.rows[0];
  if (!final) return (await db.query<Attempt>('SELECT * FROM quiz_attempts WHERE id = $1', [attempt.id])).rows[0];
  const grade = (
    await db.query<Grade>(
      `INSERT INTO grades (assessment_id, student_id, points, attempt_id, draft_updated_at)
     SELECT a.assessment_id, a.student_id, a.points, a.id, $3 FROM quiz_attempts a
     WHERE a.assessment_id = $1 AND a.student_id = $2 AND a.status <> 'IN_PROGRESS'
     ORDER BY a.points DESC, a.finished_at ASC, a.id ASC LIMIT 1
     ON CONFLICT (assessment_id, student_id) DO UPDATE
     SET points = EXCLUDED.points, attempt_id = EXCLUDED.attempt_id, version = grades.version + 1, draft_updated_at = EXCLUDED.draft_updated_at
     WHERE grades.attempt_id IS DISTINCT FROM EXCLUDED.attempt_id RETURNING *`,
      [final.assessment_id, final.student_id, now],
    )
  ).rows[0];
  if (grade) {
    const {
      rows: [assessment],
    } = await db.query<{ module_id: string; max_points: string; result_release: string }>(
      'SELECT a.module_id, a.max_points, q.result_release FROM assessments a JOIN quiz_settings q ON q.assessment_id = a.id WHERE a.id = $1',
      [final.assessment_id],
    );
    if (assessment.result_release === 'IMMEDIATE') await publishGrade(db, grade, assessment, null, now);
  }
  return final;
}

// Call with the module row locked. The same lock serialises attempt creation, grading and lifecycle changes.
export async function reconcileExpired(db: Db, moduleId: string, now: Date, studentId: string | null = null) {
  for (;;) {
    const { rows } = await db.query<Attempt>(
      `SELECT qa.* FROM quiz_attempts qa JOIN assessments a ON a.id = qa.assessment_id
       WHERE a.module_id = $1 AND qa.status = 'IN_PROGRESS' AND qa.expires_at <= $2
         AND ($3::uuid IS NULL OR qa.student_id = $3)
       ORDER BY qa.expires_at, qa.id LIMIT 50`,
      [moduleId, now, studentId],
    );
    for (const row of rows) await finaliseAttempt(db, row, now);
    if (rows.length < 50) return;
  }
}
