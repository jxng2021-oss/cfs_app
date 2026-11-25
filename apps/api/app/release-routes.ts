import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { decimal } from './decimal.js';
import { audit } from './db.js';
import { ApiError, data, id, invalid, notFound, read, version } from './http.js';
import { type LearningScope, withLearning } from './learning-access.js';
import { matchVersion } from './modules.js';

const rule = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('TOPIC_COMPLETE'), sourceTopicId: z.uuid() }),
  z.strictObject({
    type: z.literal('QUIZ_SCORE_AT_LEAST'),
    sourceAssessmentId: z.uuid(),
    thresholdPct: decimal(100, 0.01).default('70.00'),
  }),
]);
const settings = z.strictObject({ topicVersion: version, rules: z.array(rule).max(2) });
type Target = { id: string; position: number; status: string; version: number };
type TopicOption = { id: string; title: string; position: number };
type QuizOption = { id: string; title: string; dueAt: Date; maxAttempts: number; resultRelease: string };

async function configurator(req: Request, scope: LearningScope) {
  const { db, module } = scope;
  const target = (
    await db.query<Target>('SELECT id,position,status,version FROM topics WHERE module_id=$1 AND id=$2', [
      module.id,
      id(req, 'topicId'),
    ])
  ).rows[0];
  if (!target) notFound();
  const topics = (
    await db.query<TopicOption>(
      `SELECT t.id,t.title,t.position FROM topics t WHERE t.module_id=$1 AND t.position<$2 AND t.status='PUBLISHED'
     AND EXISTS (SELECT 1 FROM materials m WHERE m.topic_id=t.id AND m.status='PUBLISHED' AND m.is_required) ORDER BY t.position,t.id`,
      [module.id, target.position],
    )
  ).rows;
  const quizzes = (
    await db.query<QuizOption>(
      `SELECT a.id,a.title,a.due_at "dueAt",q.max_attempts "maxAttempts",q.result_release "resultRelease"
     FROM assessments a JOIN quiz_settings q ON q.assessment_id=a.id LEFT JOIN topics t ON t.id=a.topic_id
     WHERE a.module_id=$1 AND a.status='PUBLISHED' AND (a.topic_id IS NULL OR t.position<$2) ORDER BY a.due_at,a.id`,
      [module.id, target.position],
    )
  ).rows;
  return { target, topics, quizzes };
}

async function current(scope: LearningScope, configuration: Awaited<ReturnType<typeof configurator>>) {
  const { target, topics, quizzes } = configuration;
  const { rows } = await scope.db.query<{
    type: string;
    source_topic_id: string | null;
    source_assessment_id: string | null;
    threshold_pct: string | null;
  }>('SELECT * FROM release_rules WHERE target_topic_id=$1 ORDER BY type DESC', [target.id]);
  return {
    topicVersion: target.version,
    rules: rows.map((row) =>
      row.type === 'TOPIC_COMPLETE'
        ? { type: row.type, sourceTopicId: row.source_topic_id }
        : { type: row.type, sourceAssessmentId: row.source_assessment_id, thresholdPct: row.threshold_pct },
    ),
    topics,
    quizzes: quizzes.map((quiz) => ({ ...quiz, closed: quiz.dueAt <= scope.asOf })),
  };
}

export function releaseRoutes(services: Services) {
  const router = Router();
  const path = '/modules/:moduleId/topics/:topicId/release-rules';
  const lecturer = requireRole('LECTURER');
  router.get(path, lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        return current(scope, await configurator(req, scope));
      }),
    ),
  );
  router.put(path, lecturer, async (req, res) => {
    const input = read(settings, req.body);
    if (new Set(input.rules.map((item) => item.type)).size !== input.rules.length)
      invalid('Use at most one of each requirement type.');
    data(
      res,
      await withLearning(services, req, res, true, async (scope) => {
        const { db, module } = scope;
        const config = await configurator(req, scope);
        const { target } = config;
        if (target.status !== 'DRAFT')
          throw new ApiError(409, 'INVALID_STATE', 'Requirements are fixed after topic publication.');
        matchVersion(input.topicVersion, target.version);
        for (const item of input.rules) {
          if (
            item.type === 'TOPIC_COMPLETE'
              ? !config.topics.some((topic) => topic.id === item.sourceTopicId)
              : !config.quizzes.some((quiz) => quiz.id === item.sourceAssessmentId)
          ) {
            invalid('Select a published quiz or a published earlier topic in this module.');
          }
        }
        await db.query('DELETE FROM release_rules WHERE target_topic_id=$1', [target.id]);
        for (const item of input.rules) {
          await db.query('INSERT INTO release_rules VALUES ($1,$2,$3,$4,$5)', [
            target.id,
            item.type,
            item.type === 'TOPIC_COMPLETE' ? item.sourceTopicId : null,
            item.type === 'QUIZ_SCORE_AT_LEAST' ? item.sourceAssessmentId : null,
            item.type === 'QUIZ_SCORE_AT_LEAST' ? item.thresholdPct : null,
          ]);
        }
        await db.query('UPDATE topics SET version=version+1,updated_at=$2 WHERE id=$1', [target.id, scope.now]);
        await audit(db, scope.actorId, 'RELEASE_RULES_UPDATED', 'TOPIC', target.id, module.id);
        return current(scope, { ...config, target: { ...target, version: target.version + 1 } });
      }),
    );
  });
  return router;
}
