import type { Db } from './db.js';
import { Ratio } from './decimal.js';
import { ApiError, notFound } from './http.js';
import { currentGrade, currentRevision, revisionDto } from './grade-store.js';
import { denyLocked, releaseRequirements, topicLocked } from './release-store.js';
import type { LearningScope } from './learning-access.js';

export const assessmentTypes = ['ASSIGNMENT', 'QUIZ'] as const;
export const extensions = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'zip'] as const;
export type AssignmentSettings = {
  instructions: string;
  allowLateSubmission: boolean;
  maxSubmissions: number;
  allowedExtensions: string[];
  maxFileMiB: number;
};
export type QuizSettings = {
  instructions: string;
  timeLimitMinutes: number | null;
  maxAttempts: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultRelease: 'IMMEDIATE' | 'MANUAL';
  showAnswerReview: boolean;
};

export type Assessment = {
  id: string;
  module_id: string;
  topic_id: string | null;
  topic_status: 'DRAFT' | 'PUBLISHED' | null;
  type: (typeof assessmentTypes)[number];
  title: string;
  description: string;
  status: 'DRAFT' | 'PUBLISHED';
  open_at: Date;
  due_at: Date;
  close_at: Date | null;
  max_points: string;
  weight_pct: string;
  published_at: Date | null;
  version: number;
  assignment_settings: AssignmentSettings | null;
  quiz_settings: QuizSettings | null;
};

export const assessmentSelect = `SELECT a.*, t.status AS topic_status,
  CASE WHEN s.assessment_id IS NOT NULL THEN jsonb_build_object(
    'instructions', s.instructions, 'allowLateSubmission', s.allow_late_submission, 'maxSubmissions', s.max_submissions,
    'allowedExtensions', s.allowed_extensions, 'maxFileMiB', s.max_file_mib) END AS assignment_settings,
  CASE WHEN q.assessment_id IS NOT NULL THEN jsonb_build_object(
    'instructions', q.instructions, 'timeLimitMinutes', q.time_limit_minutes, 'maxAttempts', q.max_attempts,
    'shuffleQuestions', q.shuffle_questions, 'shuffleOptions', q.shuffle_options, 'resultRelease', q.result_release,
    'showAnswerReview', q.show_answer_review) END AS quiz_settings
  FROM assessments a LEFT JOIN topics t ON t.id=a.topic_id
  LEFT JOIN assignment_settings s ON s.assessment_id=a.id LEFT JOIN quiz_settings q ON q.assessment_id=a.id`;

export async function selectAssessment(db: Db, moduleId: string, assessmentId: string) {
  const result = await db.query<Assessment>(assessmentSelect + ' WHERE a.module_id=$1 AND a.id=$2', [
    moduleId,
    assessmentId,
  ]);
  const row = result.rows[0];
  if (!row) notFound();
  return row;
}

export function effectiveClose(item: Assessment) {
  return item.close_at ?? item.due_at;
}

export function availability(item: Assessment, now: Date, archived: boolean, locked = false) {
  if (locked) return 'LOCKED';
  if (archived) return 'ARCHIVED';
  if (now < item.open_at) return 'UPCOMING';
  return now >= effectiveClose(item) ? 'CLOSED' : 'AVAILABLE';
}

export function visibleAssessment(item: Assessment) {
  return item.status === 'PUBLISHED' && (item.topic_id === null || item.topic_status === 'PUBLISHED');
}

export async function learnerAssessment(scope: LearningScope, item: Assessment, requireUnlocked = true) {
  if (!visibleAssessment(item) || !scope.studentId) notFound();
  const requirements = await releaseRequirements(scope.db, scope.module.id, scope.studentId);
  const locked = topicLocked(requirements, item.topic_id);
  if (locked && requireUnlocked) denyLocked();
  return locked;
}

export function requireOpen(assessment: Assessment, now: Date) {
  if (now < assessment.open_at) throw new ApiError(409, 'ASSESSMENT_NOT_OPEN', 'This assessment is not open yet.');
  if (now >= effectiveClose(assessment)) throw new ApiError(409, 'ASSESSMENT_CLOSED', 'This assessment has closed.');
}

export function assessmentDto(item: Assessment) {
  return {
    id: item.id,
    moduleId: item.module_id,
    topicId: item.topic_id,
    type: item.type,
    title: item.title,
    description: item.description,
    status: item.status,
    openAt: item.open_at,
    dueAt: item.due_at,
    closeAt: item.close_at,
    effectiveCloseAt: effectiveClose(item),
    maxPoints: item.max_points === '0.00' ? null : item.max_points,
    weightPct: item.weight_pct,
    publishedAt: item.published_at,
    version: item.version,
    assignmentSettings: item.assignment_settings,
    quizSettings: item.quiz_settings,
  };
}

export function learnerSummary(scope: LearningScope, item: Assessment, locked: boolean) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    topicId: item.topic_id,
    status: item.status,
    dueAt: item.due_at,
    weightPct: item.weight_pct,
    availability: availability(item, scope.asOf, scope.module.status === 'ARCHIVED', locked),
  };
}

export async function learnerDetail(scope: LearningScope, item: Assessment, locked: boolean) {
  const base = learnerSummary(scope, item, locked);
  if (locked) return base;
  const { db, studentId } = scope;
  const grade = await currentGrade(db, item.id, studentId!);
  const publishedGrade = revisionDto(await currentRevision(db, grade));
  const details = {
    ...base,
    description: item.description,
    openAt: item.open_at,
    closeAt: item.close_at,
    effectiveCloseAt: effectiveClose(item),
    maxPoints: item.max_points,
    publishedGrade,
  };
  if (item.type === 'ASSIGNMENT') {
    const settings = item.assignment_settings!;
    const result = (
      await db.query<{ total: number; is_late: boolean }>(
        'SELECT count(*) OVER()::int AS total,is_late FROM assignment_submissions WHERE assessment_id=$1 AND student_id=$2 ORDER BY version_number DESC LIMIT 1',
        [item.id, studentId],
      )
    ).rows[0];
    const used = result?.total ?? 0;
    const cannotSubmitReason =
      base.availability !== 'AVAILABLE'
        ? base.availability
        : used >= settings.maxSubmissions
          ? 'SUBMISSION_LIMIT_REACHED'
          : grade
            ? 'GRADING_STARTED'
            : null;
    return {
      ...details,
      assignmentSettings: settings,
      usedSubmissions: used,
      remainingSubmissions: settings.maxSubmissions - used,
      canSubmit: cannotSubmitReason === null,
      cannotSubmitReason,
      submissionState: result
        ? result.is_late
          ? 'SUBMITTED_LATE'
          : 'SUBMITTED_ON_TIME'
        : scope.asOf >= item.due_at
          ? 'MISSING'
          : 'NOT_SUBMITTED',
      resultState: publishedGrade ? 'RESULT_PUBLISHED' : 'RESULT_PENDING',
    };
  }
  const settings = item.quiz_settings!;
  const row = (
    await db.query<{ total: number; active: string | null }>(
      "SELECT count(*)::int AS total, (array_agg(id) FILTER (WHERE status='IN_PROGRESS'))[1] AS active FROM quiz_attempts WHERE assessment_id=$1 AND student_id=$2",
      [item.id, studentId],
    )
  ).rows[0];
  return {
    ...details,
    quizSettings: {
      instructions: settings.instructions,
      timeLimitMinutes: settings.timeLimitMinutes,
      maxAttempts: settings.maxAttempts,
      resultRelease: settings.resultRelease,
      showAnswerReview: settings.showAnswerReview,
    },
    attemptsUsed: row.total,
    attemptsRemaining: settings.maxAttempts - row.total,
    currentAttemptId: row.active,
    canStart: base.availability === 'AVAILABLE' && (!!row.active || row.total < settings.maxAttempts),
  };
}

export async function allocatedWeight(db: Db, moduleId: string) {
  const row = (
    await db.query<{ allocated: string; remaining: string }>(
      "SELECT coalesce(sum(weight_pct),0)::numeric(5,2) AS allocated, (100-coalesce(sum(weight_pct),0))::numeric(5,2) AS remaining FROM assessments WHERE module_id=$1 AND status='PUBLISHED'",
      [moduleId],
    )
  ).rows[0];
  return {
    allocatedWeight: Ratio.decimal(row.allocated).format(),
    remainingWeight: Ratio.decimal(row.remaining).format(),
  };
}
