import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { audit } from './db.js';
import { Ratio, decimal, hundredths, scoreRatio } from './decimal.js';
import { assessmentRecords, combineGrades, courseRoster, publishedAssessments } from './gradebook.js';
import { data, pageFields, paged, read, version } from './http.js';
import { withLearning, type LearningScope } from './learning-access.js';
import { matchVersion } from './modules.js';
import { rosterRequirements, topicLocked } from './release-store.js';

const settingsSchema = z.strictObject({
  missingAssignmentsEnabled: z.boolean(),
  missingAssignmentsThreshold: z.number().int().min(1).max(20),
  lowQuizEnabled: z.boolean(),
  lowQuizThresholdPct: decimal(100),
  lowQuizMinSamples: z.number().int().min(1).max(10),
  lowGradeEnabled: z.boolean(),
  lowGradeThresholdPct: decimal(100),
  lowGradeMinWeight: decimal(100, 0.01),
  lowProgressEnabled: z.boolean(),
  lowProgressThresholdPct: decimal(100),
  lowProgressMinMaterials: z.number().int().min(1).max(100),
});
type Settings = z.infer<typeof settingsSchema>;
export const analyticsDefaults: Settings = {
  missingAssignmentsEnabled: true,
  missingAssignmentsThreshold: 1,
  lowQuizEnabled: true,
  lowQuizThresholdPct: '50.00',
  lowQuizMinSamples: 2,
  lowGradeEnabled: true,
  lowGradeThresholdPct: '50.00',
  lowGradeMinWeight: '20.00',
  lowProgressEnabled: false,
  lowProgressThresholdPct: '50.00',
  lowProgressMinMaterials: 3,
};

async function settings({ db, module }: LearningScope) {
  const result = await db.query<{ settings: Settings; version: number }>(
    'SELECT settings,version FROM analytics_settings WHERE module_id=$1',
    [module.id],
  );
  return { ...result.rows[0].settings, version: result.rows[0].version };
}

function percentage(numerator: number, denominator: number) {
  return denominator ? new Ratio(BigInt(numerator) * 100n, BigInt(denominator)) : null;
}
function formatted(ratio: Ratio | null) {
  return ratio?.format() ?? null;
}

async function analyse(scope: LearningScope) {
  const { db, module, asOf } = scope;
  const config = await settings(scope);
  const students = await courseRoster(scope);
  const items = await publishedAssessments(db, module.id);
  const studentIds = students.map((student) => student.id);
  const records = await assessmentRecords(db, module.id, studentIds);
  const rules = await rosterRequirements(db, module.id, studentIds);
  const counts = await db.query<{ student_id: string; topic_id: string; total: number; completed: number }>(
    `SELECT u.id student_id,t.id topic_id,count(*)::int total,count(c.student_id)::int completed
       FROM topics t JOIN materials m ON m.topic_id=t.id CROSS JOIN unnest($2::uuid[]) u(id)
       LEFT JOIN material_completions c ON c.material_id=m.id AND c.student_id=u.id
       WHERE t.module_id=$1 AND t.status='PUBLISHED' AND m.status='PUBLISHED' AND m.is_required GROUP BY u.id,t.id`,
    [module.id, studentIds],
  );
  const due = items.filter((item) => item.type === 'ASSIGNMENT' && item.due_at <= asOf);
  const distribution = [0, 0, 0, 0, 0];
  const bounds = [50, 60, 70, 80].map((value) => Ratio.decimal(value));
  let submissions = 0,
    late = 0,
    quizSamples = 0,
    workingSamples = 0,
    completions = 0,
    materialOpportunities = 0;
  let quizSum = new Ratio(),
    workingSum = new Ratio();
  const roster = students.map((student) => {
    const track = records.get(student.id);
    const requirements = rules.get(student.id) ?? new Map();
    const missing = due.filter((item) => !track?.get(item.id)?.version_number);
    const lateForStudent = due.filter((item) => track?.get(item.id)?.is_late).length;
    submissions += due.length - missing.length;
    late += lateForStudent;
    const quizzes = items.filter((item) => item.type === 'QUIZ' && track?.get(item.id)?.draft);
    const studentQuizSum = quizzes.reduce(
      (sum, item) => sum.add(scoreRatio(track!.get(item.id)!.draft!.points, item.max_points).scale(100n)),
      new Ratio(),
    );
    const quizMean = quizzes.length ? studentQuizSum.scale(1n, BigInt(quizzes.length)) : null;
    quizSamples += quizzes.length;
    quizSum = quizSum.add(studentQuizSum);
    const { working, workingWeight } = combineGrades(items, track, asOf);
    if (working) {
      workingSamples++;
      workingSum = workingSum.add(working);
      const firstBound = bounds.findIndex((bound) => working.below(bound));
      distribution[firstBound < 0 ? 4 : firstBound]++;
    }
    const progress = counts.rows
      .filter((row) => row.student_id === student.id)
      .reduce(
        (agg, row) => {
          agg.total += row.total;
          agg.completed += row.completed;
          if (!topicLocked(requirements, row.topic_id)) {
            agg.accessibleTotal += row.total;
            agg.accessibleCompleted += row.completed;
          }
          return agg;
        },
        { total: 0, completed: 0, accessibleTotal: 0, accessibleCompleted: 0 },
      );
    completions += progress.completed;
    materialOpportunities += progress.total;
    const accessible = percentage(progress.accessibleCompleted, progress.accessibleTotal);
    const overall = percentage(progress.completed, progress.total);
    const resolvedWeight = new Ratio(workingWeight, 100n).format();
    const reasons: Record<string, unknown>[] = [];
    if (config.missingAssignmentsEnabled && missing.length >= config.missingAssignmentsThreshold) {
      reasons.push({
        code: 'MISSING_ASSIGNMENTS',
        actualCount: missing.length,
        thresholdCount: config.missingAssignmentsThreshold,
        assessmentIds: missing.map((item) => item.id),
        lockedAssessmentIds: missing
          .filter((item) => topicLocked(requirements, item.topic_id))
          .map((item) => item.id),
      });
    }
    if (
      config.lowQuizEnabled &&
      quizzes.length >= config.lowQuizMinSamples &&
      quizMean?.below(Ratio.decimal(config.lowQuizThresholdPct))
    ) {
      reasons.push({
        code: 'LOW_QUIZ_MEAN',
        actualPct: quizMean.format(),
        thresholdPct: config.lowQuizThresholdPct,
        sampleCount: quizzes.length,
        assessmentIds: quizzes.map((item) => item.id),
      });
    }
    if (
      config.lowGradeEnabled &&
      workingWeight >= hundredths(config.lowGradeMinWeight) &&
      working?.below(Ratio.decimal(config.lowGradeThresholdPct))
    ) {
      reasons.push({
        code: 'LOW_WORKING_GRADE',
        actualPct: working.format(),
        thresholdPct: config.lowGradeThresholdPct,
        resolvedWeight,
      });
    }
    if (
      config.lowProgressEnabled &&
      progress.accessibleTotal >= config.lowProgressMinMaterials &&
      accessible?.below(Ratio.decimal(config.lowProgressThresholdPct))
    ) {
      reasons.push({
        code: 'LOW_ACCESSIBLE_PROGRESS',
        actualPct: accessible.format(),
        thresholdPct: config.lowProgressThresholdPct,
        completedCount: progress.accessibleCompleted,
        totalCount: progress.accessibleTotal,
      });
    }
    return {
      studentId: student.id,
      displayName: student.displayName,
      needsReview: reasons.length > 0,
      reasons,
      missingAssignmentCount: missing.length,
      dueAssignmentCount: due.length,
      lateSubmissionCount: lateForStudent,
      quizMeanPct: formatted(quizMean),
      quizSampleCount: quizzes.length,
      workingScorePct: formatted(working),
      resolvedWorkingWeight: resolvedWeight,
      overallProgress: { percent: formatted(overall), completed: progress.completed, total: progress.total },
      accessibleProgress: {
        percent: formatted(accessible),
        completed: progress.accessibleCompleted,
        total: progress.accessibleTotal,
      },
    };
  });
  const dueOpportunities = due.length * students.length;
  return {
    roster,
    summary: {
      asOf,
      enrolledCount: students.length,
      dueAssignmentOpportunities: dueOpportunities,
      submittedAssignmentCount: submissions,
      missingAssignmentCount: dueOpportunities - submissions,
      lateSubmissionCount: late,
      submissionRatePct: formatted(percentage(submissions, dueOpportunities)),
      quizMeanPct: quizSamples ? quizSum.scale(1n, BigInt(quizSamples)).format() : null,
      quizSampleCount: quizSamples,
      classWorkingAveragePct: workingSamples ? workingSum.scale(1n, BigInt(workingSamples)).format() : null,
      workingScoreSampleCount: workingSamples,
      overallProgressPct: formatted(percentage(completions, materialOpportunities)),
      completedMaterialCount: completions,
      materialOpportunities,
      studentsNeedingReview: roster.filter((student) => student.needsReview).length,
      scoreDistribution: ['0–49.99', '50–59.99', '60–69.99', '70–79.99', '80–100'].map((label, index) => ({
        label,
        count: distribution[index],
      })),
      scoreNoData: students.length - workingSamples,
    },
  };
}

export function analyticsRoutes(services: Services) {
  const router = Router();
  const path = '/modules/:moduleId/analytics';
  const lecturer = requireRole('LECTURER');
  router.get(path + '/settings', lecturer, async (req, res) =>
    data(res, await withLearning(services, req, res, false, settings)),
  );
  router.put(path + '/settings', lecturer, async (req, res) => {
    const { version: expected, ...input } = read(settingsSchema.extend({ version }), req.body);
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { db, module, actorId } = scope;
        matchVersion(expected, (await settings(scope)).version);
        await db.query('UPDATE analytics_settings SET settings=$2,version=version+1 WHERE module_id=$1', [
          module.id,
          input,
        ]);
        await audit(db, actorId, 'ANALYTICS_SETTINGS_UPDATED', 'MODULE', module.id, module.id);
        return { ...input, version: expected + 1 };
      }),
    );
  });
  router.get(path + '/summary', lecturer, async (req, res) =>
    data(res, await withLearning(services, req, res, false, async (scope) => (await analyse(scope)).summary)),
  );
  router.get(path + '/students', lecturer, async (req, res) => {
    const query = read(
      z.strictObject({
        ...pageFields,
        needsReview: z.enum(['true', 'false']).optional(),
        q: z.string().trim().max(120).optional(),
      }),
      req.query,
    );
    const { roster } = await withLearning(services, req, res, false, analyse);
    const matches = roster.filter(
      (student) =>
        (!query.needsReview || student.needsReview === (query.needsReview === 'true')) &&
        (!query.q || student.displayName.toLowerCase().includes(query.q.toLowerCase())),
    );
    paged(
      res,
      matches.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      matches.length,
      query.page,
      query.pageSize,
    );
  });
  return router;
}
