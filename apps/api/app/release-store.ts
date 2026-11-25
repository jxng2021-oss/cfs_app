import type { Db } from './db.js';
import { scoreRatio } from './decimal.js';
import { ApiError } from './http.js';

type RequirementRow = {
  student_id: string;
  target_topic_id: string;
  type: 'TOPIC_COMPLETE' | 'QUIZ_SCORE_AT_LEAST';
  source_topic_id: string | null;
  source_assessment_id: string | null;
  title: string;
  threshold_pct: string | null;
  points: string | null;
  max_points: string | null;
  satisfied: boolean;
};

export async function releaseRequirements(db: Db, moduleId: string, studentId: string) {
  return (
    (await rosterRequirements(db, moduleId, [studentId])).get(studentId) ??
    new Map<string, ReturnType<typeof requirementDto>[]>()
  );
}

export async function rosterRequirements(db: Db, moduleId: string, studentIds: string[]) {
  const { rows } = await db.query<RequirementRow>(
    `SELECT r.*, student.id AS student_id, coalesce(source.title, a.title) AS title, rev.points, rev.max_points,
       CASE WHEN r.type='TOPIC_COMPLETE' THEN NOT EXISTS (
         SELECT 1 FROM materials m WHERE m.topic_id=r.source_topic_id AND m.status='PUBLISHED' AND m.is_required
           AND NOT EXISTS (SELECT 1 FROM material_completions c WHERE c.material_id=m.id AND c.student_id=student.id)
       ) ELSE coalesce(rev.points*100 >= rev.max_points*r.threshold_pct,false) END AS satisfied
     FROM release_rules r JOIN topics target ON target.id=r.target_topic_id CROSS JOIN unnest($2::uuid[]) student(id)
     LEFT JOIN topics source ON source.id=r.source_topic_id LEFT JOIN assessments a ON a.id=r.source_assessment_id
     LEFT JOIN grades g ON g.assessment_id=a.id AND g.student_id=student.id LEFT JOIN grade_revisions rev ON rev.id=g.published_revision_id
     WHERE target.module_id=$1 AND target.status='PUBLISHED' ORDER BY r.type DESC`,
    [moduleId, studentIds],
  );
  const byStudent = new Map<string, Map<string, ReturnType<typeof requirementDto>[]>>();
  for (const row of rows) {
    const byTopic = byStudent.get(row.student_id) ?? new Map();
    const existing = byTopic.get(row.target_topic_id) ?? [];
    existing.push(requirementDto(row));
    byTopic.set(row.target_topic_id, existing);
    byStudent.set(row.student_id, byTopic);
  }
  return byStudent;
}

function requirementDto(row: RequirementRow) {
  const shared = { type: row.type, sourceTitle: row.title, satisfied: row.satisfied };
  if (row.type === 'TOPIC_COMPLETE') return { ...shared, sourceTopicId: row.source_topic_id };
  return {
    ...shared,
    sourceAssessmentId: row.source_assessment_id,
    thresholdPct: row.threshold_pct,
    publishedScorePct:
      row.points && row.max_points ? scoreRatio(row.points, row.max_points).scale(100n).format() : null,
  };
}

export function topicLocked(requirements: Awaited<ReturnType<typeof releaseRequirements>>, topicId: string | null) {
  return topicId !== null && (requirements.get(topicId)?.some((rule) => !rule.satisfied) ?? false);
}

export function denyLocked(): never {
  throw new ApiError(403, 'CONTENT_LOCKED', 'Complete the release requirements to open this content.');
}

export async function assertReleaseOrder(db: Db, moduleId: string) {
  const result = await db.query(
    `SELECT 1 FROM release_rules r JOIN topics target ON target.id=r.target_topic_id
     LEFT JOIN topics source ON source.id=r.source_topic_id
     LEFT JOIN assessments a ON a.id=r.source_assessment_id LEFT JOIN topics placement ON placement.id=a.topic_id
     WHERE target.module_id=$1 AND (source.position>=target.position OR placement.position>=target.position) LIMIT 1`,
    [moduleId],
  );
  if (result.rowCount)
    throw new ApiError(409, 'DEPENDENCY_EXISTS', 'A release requirement must come before its target topic.');
}
