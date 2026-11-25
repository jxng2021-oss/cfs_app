import { Router } from 'express';
import { z } from 'zod';
import { requireRole, type Services } from './auth.js';
import { assessmentSelect, effectiveClose, learnerSummary, type Assessment } from './assessment-model.js';
import { Ratio, hundredths, scoreRatio } from './decimal.js';
import type { Db } from './db.js';
import { lecturerGradeDto, revisionDto, type Grade, type Revision } from './grade-store.js';
import { data, id, notFound, pageFields, read } from './http.js';
import { withLearning, type LearningScope } from './learning-access.js';
import { releaseRequirements, topicLocked } from './release-store.js';

export type StudentRecord = {
  id: string;
  displayName: string;
  enrolmentStatus: 'ACTIVE' | 'WITHDRAWN';
  isActive: boolean;
};
export type AssessmentRecord = {
  student_id: string;
  assessment_id: string;
  version_number: number | null;
  is_late: boolean | null;
  finalised: boolean;
  live: boolean;
  draft: Grade | null;
  published: Revision | null;
};

export async function courseRoster(scope: LearningScope, status: 'ACTIVE' | 'WITHDRAWN' | null = 'ACTIVE') {
  return (
    await scope.db.query<StudentRecord>(
      `SELECT u.id,u.display_name "displayName",u.is_active "isActive",e.status "enrolmentStatus"
     FROM enrolments e JOIN users u ON u.id=e.student_id WHERE e.module_id=$1 AND ($2::text IS NULL OR e.status=$2)
       AND ($2 IS DISTINCT FROM 'ACTIVE' OR u.is_active OR $3) ORDER BY u.display_name,u.id`,
      [scope.module.id, status, scope.module.status === 'ARCHIVED'],
    )
  ).rows;
}

export async function publishedAssessments(db: Db, moduleId: string) {
  return (
    await db.query<Assessment>(
      assessmentSelect + " WHERE a.module_id=$1 AND a.status='PUBLISHED' ORDER BY a.due_at,a.title,a.id",
      [moduleId],
    )
  ).rows;
}

export async function assessmentRecords(db: Db, moduleId: string, studentIds: string[]) {
  const { rows } = await db.query<AssessmentRecord>(
    `WITH submitted AS (
       SELECT DISTINCT ON (s.assessment_id,s.student_id) s.assessment_id,s.student_id,s.version_number,s.is_late
       FROM assignment_submissions s JOIN assessments a ON a.id=s.assessment_id
       WHERE a.module_id=$1 AND s.student_id=ANY($2::uuid[]) ORDER BY s.assessment_id,s.student_id,s.version_number DESC
     ), attempted AS (
       SELECT q.assessment_id,q.student_id,bool_or(q.status<>'IN_PROGRESS') AS finalised,bool_or(q.status='IN_PROGRESS') AS live
       FROM quiz_attempts q JOIN assessments a ON a.id=q.assessment_id WHERE a.module_id=$1 AND q.student_id=ANY($2::uuid[])
       GROUP BY q.assessment_id,q.student_id
     )
     SELECT student.id student_id,a.id assessment_id,s.version_number,s.is_late,
       coalesce(q.finalised,false) AS finalised,coalesce(q.live,false) AS live,
       to_jsonb(g)||jsonb_build_object('points',g.points::text) AS draft,
       to_jsonb(r)||jsonb_build_object('points',r.points::text,'max_points',r.max_points::text) AS published
     FROM assessments a CROSS JOIN unnest($2::uuid[]) student(id)
     LEFT JOIN submitted s ON s.assessment_id=a.id AND s.student_id=student.id
     LEFT JOIN attempted q ON q.assessment_id=a.id AND q.student_id=student.id
     LEFT JOIN grades g ON g.assessment_id=a.id AND g.student_id=student.id LEFT JOIN grade_revisions r ON r.id=g.published_revision_id
     WHERE a.module_id=$1 AND a.status='PUBLISHED'`,
    [moduleId, studentIds],
  );
  const byStudent = new Map<string, Map<string, AssessmentRecord>>();
  for (const row of rows) {
    const map = byStudent.get(row.student_id) ?? new Map();
    map.set(row.assessment_id, row);
    byStudent.set(row.student_id, map);
  }
  return byStudent;
}

export function missingClosed(item: Assessment, record: AssessmentRecord | undefined, time: Date) {
  return time >= effectiveClose(item) && !record?.version_number && !record?.finalised && !record?.live;
}

export function combineGrades(items: Assessment[], records: Map<string, AssessmentRecord> | undefined, asOf: Date) {
  let weight = 0n,
    released = 0n,
    missing = 0n,
    workingWeight = 0n;
  let contribution = new Ratio(),
    workingContribution = new Ratio();
  const rows = items.map((item) => {
    const record = records?.get(item.id);
    const itemWeight = hundredths(item.weight_pct);
    weight += itemWeight;
    const score = revisionDto(record?.published ?? undefined);
    const closed = missingClosed(item, record, asOf);
    let rowContribution: string | null = null;
    if (score) {
      const exact = scoreRatio(score.points, score.maxPoints).scale(itemWeight, 100n);
      contribution = contribution.add(exact);
      released += itemWeight;
      rowContribution = exact.format();
    } else if (closed) {
      missing += itemWeight;
      rowContribution = '0.00';
    }
    if (record?.draft) {
      workingContribution = workingContribution.add(
        scoreRatio(record.draft.points, item.max_points).scale(itemWeight, 100n),
      );
      workingWeight += itemWeight;
    } else if (closed) workingWeight += itemWeight;
    const resultState = score
      ? 'RESULT_PUBLISHED'
      : closed
        ? 'MISSING_CLOSED'
        : record?.version_number || record?.finalised
          ? 'RESULT_PENDING'
          : 'NOT_COMPLETED';
    return {
      id: item.id,
      title: item.title,
      type: item.type,
      dueAt: item.due_at,
      maxPoints: item.max_points,
      weightPct: item.weight_pct,
      topicId: item.topic_id,
      publishedGrade: score && { ...score, contribution: rowContribution },
      contribution: rowContribution,
      resultState,
      submissionState:
        item.type !== 'ASSIGNMENT'
          ? null
          : record?.version_number
            ? record.is_late
              ? 'SUBMITTED_LATE'
              : 'SUBMITTED_ON_TIME'
            : asOf >= item.due_at
              ? 'MISSING'
              : 'NOT_SUBMITTED',
    };
  });
  const working = workingWeight ? workingContribution.scale(10000n, workingWeight) : null;
  const summary = {
    allocatedWeight: new Ratio(weight, 100n).format(),
    releasedWeight: new Ratio(released, 100n).format(),
    resolvedWeight: new Ratio(released + missing, 100n).format(),
    missingClosedWeight: new Ratio(missing, 100n).format(),
    releasedContribution: contribution.format(),
    currentReleasedAverage: released ? contribution.scale(10000n, released).format() : null,
    finalModuleScore: weight === 10000n && released + missing === weight ? contribution.format() : null,
  };
  return { rows, summary, working, workingWeight };
}

export async function studentGradebook(scope: LearningScope) {
  const { db, module, studentId, asOf } = scope;
  const items = await publishedAssessments(db, module.id);
  const records = await assessmentRecords(db, module.id, [studentId!]);
  const rules = await releaseRequirements(db, module.id, studentId!);
  const byAssessment = records.get(studentId!);
  const { rows, summary } = combineGrades(items, byAssessment, asOf);
  const upcoming = items
    .filter(
      (item) =>
        item.due_at > asOf && !byAssessment?.get(item.id)?.version_number && !byAssessment?.get(item.id)?.finalised,
    )
    .map((item) => learnerSummary(scope, item, topicLocked(rules, item.topic_id)));
  return {
    ...summary,
    asOf,
    assessments: rows.map((row) => ({ ...row, locked: topicLocked(rules, row.topicId) })),
    upcoming: module.status === 'ARCHIVED' ? [] : upcoming,
  };
}

function lecturerRow(
  student: StudentRecord,
  items: Assessment[],
  records: Map<string, AssessmentRecord> | undefined,
  time: Date,
) {
  const { rows, summary, working, workingWeight } = combineGrades(items, records, time);
  return {
    ...student,
    ...summary,
    workingScore: working?.format() ?? null,
    resolvedWorkingWeight: new Ratio(workingWeight, 100n).format(),
    assessments: rows.map((row) => ({
      ...row,
      grade: lecturerGradeDto(records?.get(row.id)?.draft ?? undefined, records?.get(row.id)?.published ?? undefined),
    })),
  };
}

export function gradebookRoutes(services: Services) {
  const router = Router();
  const path = '/modules/:moduleId/gradebook';
  const lecturer = requireRole('LECTURER');
  router.get(path + '/me', requireRole('STUDENT'), async (req, res) =>
    data(res, await withLearning(services, req, res, false, studentGradebook)),
  );
  router.get(path, lecturer, async (req, res) => {
    const query = read(
      z.strictObject({
        ...pageFields,
        enrolmentStatus: z.enum(['ACTIVE', 'WITHDRAWN']).default('ACTIVE'),
        filter: z.enum(['PUBLISHED', 'PENDING', 'MISSING']).optional(),
      }),
      req.query,
    );
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const { db, module, asOf } = scope;
        const items = await publishedAssessments(db, module.id);
        const roster = await courseRoster(scope, query.enrolmentStatus);
        const records = await assessmentRecords(
          db,
          module.id,
          roster.map((person) => person.id),
        );
        const all = roster
          .map((person) => lecturerRow(person, items, records.get(person.id), asOf))
          .filter(
            (row) =>
              !query.filter ||
              row.assessments.some((cell) => {
                if (query.filter === 'MISSING')
                  return cell.resultState === 'MISSING_CLOSED' || cell.submissionState === 'MISSING';
                if (query.filter === 'PENDING')
                  return cell.resultState === 'RESULT_PENDING' || cell.grade.state === 'UNPUBLISHED_CHANGES';
                return cell.resultState === 'RESULT_PUBLISHED';
              }),
          );
        return {
          asOf,
          allocatedWeight: combineGrades(items, undefined, asOf).summary.allocatedWeight,
          assessments: items.map((item) => ({
            id: item.id,
            title: item.title,
            type: item.type,
            weightPct: item.weight_pct,
            maxPoints: item.max_points,
          })),
          students: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
          pagination: {
            page: query.page,
            pageSize: query.pageSize,
            total: all.length,
            totalPages: Math.ceil(all.length / query.pageSize),
          },
        };
      }),
    );
  });
  router.get(path + '/:studentId', lecturer, async (req, res) =>
    data(
      res,
      await withLearning(services, req, res, false, async (scope) => {
        const studentId = id(req, 'studentId');
        const roster = await courseRoster(scope, null);
        const student = roster.find((person) => person.id === studentId);
        if (!student) notFound();
        const items = await publishedAssessments(scope.db, scope.module.id);
        const records = await assessmentRecords(scope.db, scope.module.id, [student.id]);
        return lecturerRow(student, items, records.get(student.id), scope.asOf);
      }),
    ),
  );
  return router;
}
