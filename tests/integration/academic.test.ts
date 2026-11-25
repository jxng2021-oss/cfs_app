import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../apps/api/app/app.js';
import { hashPassword } from '../../apps/api/app/auth.js';
import { parseConfig } from '../../apps/api/app/config.js';
import { createPool, migrate } from '../../apps/api/app/db.js';
import { cleanupUploads } from '../../apps/api/app/files.js';
import { createStorage } from '../../apps/api/app/storage.js';

const origin = 'http://localhost:3000';
const password = 'fixture for academic integration';
const testUrl = new URL(
  process.env.TEST_DATABASE_URL ?? 'postgres://lms:local-test-db-only@localhost:55433/lms_test',
);
if (!/^\/[a-z0-9_]+_test$/i.test(testUrl.pathname)) throw new Error('Use a dedicated _test database');
const schema = 'academic_' + randomUUID().replaceAll('-', '');
const root = createPool(testUrl.href);
testUrl.searchParams.set('options', '-c search_path=' + schema);
const pool = createPool(testUrl.href);
let now: number;
let workingDirectory: string;
let app: Express;
let services: Parameters<typeof createApp>[0];
const ids: Record<'admin' | 'teacher' | 'other-teacher' | 'student' | 'peer' | 'extra-one' | 'extra-two', string> =
  {} as typeof ids;
type Actor = keyof typeof ids;
type Login = { cookie: string; csrf: string };
let sessions: Record<Actor, Login>;
const roles = {
  admin: 'ADMIN',
  teacher: 'LECTURER',
  'other-teacher': 'LECTURER',
  student: 'STUDENT',
  peer: 'STUDENT',
  'extra-one': 'STUDENT',
  'extra-two': 'STUDENT',
} as const;
const instant = (value: number) => new Date(value).toISOString();

before(async () => {
  await root.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  workingDirectory = await mkdtemp(join(tmpdir(), 'lms-academic-'));
  const config = parseConfig({
    NODE_ENV: 'test',
    APP_ORIGIN: origin,
    DATABASE_URL: testUrl.href,
    SESSION_PEPPER: 'academic test pepper with more than 32 characters',
    UPLOAD_DIR: workingDirectory,
  });
  services = { config, pool, clock: async () => new Date(now) };
  app = createApp(services);
  const hash = await hashPassword(password);
  for (const user of Object.keys(roles) as Actor[]) {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users(email_normalized,display_name,role,password_hash,must_change_password) VALUES ($1,$2,$3,$4,false) RETURNING id',
      [user + '@example.test', user, roles[user], hash],
    );
    ids[user] = rows[0].id;
  }
});
after(async () => {
  await pool.end();
  try {
    await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
  } finally {
    await root.end();
  }
  if (workingDirectory) await rm(workingDirectory, { recursive: true, force: true });
});

async function fixture(hours = 0, roster: Actor[] = ['student', 'peer']) {
  now = Date.parse('2027-01-12T03:00:00Z') + hours * 3_600_000;
  sessions = {} as typeof sessions;
  for (const user of Object.keys(roles) as Actor[]) {
    const response = await request(app)
      .post('/api/v1/auth/login')
      .set('Origin', origin)
      .send({ email: user + '@example.test', password })
      .expect(200);
    sessions[user] = { cookie: response.get('Set-Cookie')![0].split(';')[0], csrf: response.body.data.csrfToken };
  }
  const { body } = await write('admin', 'post', '/admin/modules')
    .send({ code: 'X' + randomUUID().slice(0, 8), name: 'Academic test', term: 'Fixture', lecturerId: ids.teacher })
    .expect(201);
  const adminPath = '/admin/modules/' + body.data.id;
  for (const user of roster)
    await write('admin', 'post', adminPath + '/enrolments')
      .send({ studentId: ids[user] })
      .expect(201);
  await write('admin', 'post', adminPath + '/activate')
    .send({ version: 1 })
    .expect(200);
  return { path: '/modules/' + body.data.id, adminPath, moduleId: body.data.id as string };
}
function write(actor: Actor, method: 'post' | 'patch' | 'put' | 'delete', path: string) {
  const client = request(app);
  return client[method]('/api/v1' + path)
    .set({ Origin: origin, Cookie: sessions[actor].cookie, 'X-CSRF-Token': sessions[actor].csrf });
}
function read(actor: Actor, path: string) {
  return request(app)
    .get(path.startsWith('/api/v1/') ? path : '/api/v1' + path)
    .set('Cookie', sessions[actor].cookie);
}
async function stage(
  actor: Actor,
  name = 'entry.txt',
  purpose = 'SUBMISSION',
  body = Buffer.from('Synthetic assessment evidence.'),
) {
  return write(actor, 'post', '/files/stage').field('purpose', purpose).attach('file', body, name);
}
const assignmentSettings = {
  instructions: 'Submit a synthetic text file.',
  allowLateSubmission: true,
  maxSubmissions: 2,
  allowedExtensions: ['txt'],
  maxFileMiB: 1,
};
async function draft(path: string, details: Record<string, unknown>) {
  const { body } = await write('teacher', 'post', path + '/assessments')
    .send(details)
    .expect(201);
  return {
    id: body.data.id as string,
    route: path + '/assessments/' + body.data.id,
    version: body.data.version as number,
  };
}
async function assignment(
  path: string,
  open: number,
  due: number,
  close: number,
  overrides: Record<string, unknown> = {},
) {
  return draft(path, {
    type: 'ASSIGNMENT',
    title: 'Written submission',
    openAt: instant(open),
    dueAt: instant(due),
    closeAt: instant(close),
    maxPoints: '100.00',
    weightPct: '30.00',
    assignmentSettings,
    ...overrides,
  });
}
function accept(path: string, fileId: string, actor: Actor = 'student', key: string = randomUUID()) {
  return write(actor, 'post', path + '/submissions')
    .set('Idempotency-Key', key)
    .send({ fileId });
}
function publish(path: string, version: number) {
  return write('teacher', 'post', path + '/publish').send({ version });
}
function assertCode(code: string) {
  return (response: { body: { error: { code: string } } }) => assert.equal(response.body.error.code, code);
}

test('T05/T07/T19–T28: staged files, exact windows, submission retry/privacy, concurrent slots and released revisions', async () => {
  const { path } = await fixture();
  const start = now + 1000,
    due = start + 1500,
    close = due + 5000;
  await write('teacher', 'post', path + '/assessments')
    .send({
      type: 'ASSIGNMENT',
      title: 'Invalid window',
      openAt: instant(start),
      dueAt: instant(due),
      closeAt: instant(due),
      assignmentSettings,
    })
    .expect(422);
  const item = await assignment(path, start, due, close);
  await publish(item.route, 1).expect(200);
  const invalid = await stage('student', 'payload.html');
  assert.equal(invalid.status, 415);
  const oversized = await stage('student', 'large.txt', 'SUBMISSION', Buffer.alloc(1024 * 1024 + 1, 65));
  assert.equal(oversized.status, 201);
  const wrongType = await stage('student', 'wrong.pdf', 'SUBMISSION', Buffer.from('%PDF-1.7\n fixture'));
  assert.equal(wrongType.status, 201);
  const mine = await stage('student');
  assert.equal(mine.status, 201);
  const other = await stage('peer');
  assert.equal(other.status, 201);
  const myFile = mine.body.data.id;
  const peerFile = other.body.data.id;
  now = start - 1;
  await accept(item.route, myFile).expect(409).expect(assertCode('ASSESSMENT_NOT_OPEN'));
  now = start;
  await accept(item.route, peerFile).expect(404);
  await accept(item.route, oversized.body.data.id).expect(413);
  await accept(item.route, wrongType.body.data.id).expect(415);
  const receiptKey = randomUUID();
  const first = await accept(item.route, myFile, 'student', receiptKey).expect(201);
  assert.equal(first.body.data.versionNumber, 1);
  assert.equal(first.body.data.isLate, false);
  await read('peer', mine.body.data.downloadUrl).expect(404);
  await read('admin', mine.body.data.downloadUrl).expect(403);
  await read('teacher', mine.body.data.downloadUrl).expect(200).expect('Cache-Control', 'private, no-store');
  await read('other-teacher', mine.body.data.downloadUrl).expect(404);
  now = due;
  const next = (await stage('student', 'next.txt')).body.data.id;
  const parallel = (await stage('student', 'parallel.txt')).body.data.id;
  const races = await Promise.all([accept(item.route, next), accept(item.route, parallel)]);
  assert.deepEqual(races.map((value) => value.status).sort(), [201, 409]);
  const accepted = races.find((value) => value.status === 201)!;
  assert.equal(accepted.body.data.versionNumber, 2);
  assert.equal(accepted.body.data.isLate, true);
  const history = await read('student', item.route + '/submissions/me').expect(200);
  assert.deepEqual(
    history.body.data.submissions.map((value: { versionNumber: number }) => value.versionNumber),
    [2, 1],
  );
  const marker = item.route + '/grades/' + ids.student;
  await write('teacher', 'put', marker + '/draft')
    .send({ points: '0.00', feedback: 'First draft', expectedVersion: 0 })
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.data.draft.points, '0.00');
      assert.equal(body.data.draft.submissionId, accepted.body.data.submissionId);
    });
  await read('student', item.route)
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.publishedGrade, null));
  await read('peer', item.route + '/submissions/' + ids.student + '/history').expect(403);
  await read('admin', marker + '/revisions').expect(403);
  await write('teacher', 'post', marker + '/publish')
    .send({ expectedVersion: 1 })
    .expect(200);
  await write('teacher', 'put', marker + '/draft')
    .send({ points: '85.00', feedback: 'Revised feedback', expectedVersion: 1 })
    .expect(200);
  await read('student', item.route)
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.publishedGrade.points, '0.00'));
  await write('teacher', 'post', marker + '/publish')
    .send({ expectedVersion: 2 })
    .expect(200);
  await write('teacher', 'post', marker + '/publish')
    .send({ expectedVersion: 2 })
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.changed, false));
  await read('teacher', marker + '/revisions')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.length, 2));
  await read('teacher', item.route + '/submissions').expect(200);
  now = close;
  await accept(item.route, peerFile, 'peer').expect(409).expect(assertCode('ASSESSMENT_CLOSED'));
  const replay = await accept(item.route, myFile, 'student', receiptKey).expect(200);
  assert.deepEqual(replay.body, first.body);
  await accept(item.route, parallel, 'student', receiptKey).expect(409).expect(assertCode('IDEMPOTENCY_CONFLICT'));
});

test('T25/T26/T41/T42 and deadline-minus-1ms: marking source and weight locks serialise competing writes', async () => {
  const { path } = await fixture();
  const [one, two] = await Promise.all([
    assignment(path, now - 1000, now + 10_000, now + 20_000, { weightPct: '65.00' }),
    assignment(path, now - 1000, now + 10_000, now + 20_000, { weightPct: '55.00' }),
  ]);
  const attempts = await Promise.all([publish(one.route, 1), publish(two.route, 1)]);
  assert.deepEqual(attempts.map((result) => result.status).sort(), [200, 409]);
  const item = attempts[0].status === 200 ? one : two;
  now += 9999;
  const first = (await stage('student')).body.data.id;
  await accept(item.route, first)
    .expect(201)
    .expect(({ body }) => assert.equal(body.data.isLate, false));
  const next = (await stage('student', 'revision.txt')).body.data.id;
  const grade = item.route + '/grades/' + ids.student + '/draft';
  const [gradeResult, submitResult] = await Promise.all([
    write('teacher', 'put', grade).send({ points: 50, expectedVersion: 0 }),
    accept(item.route, next),
  ]);
  assert.equal(gradeResult.status, 200);
  if (submitResult.status === 409) assert.equal(submitResult.body.error.code, 'GRADING_STARTED');
  else {
    assert.equal(submitResult.status, 201);
    assert.equal(gradeResult.body.data.draft.submissionId, submitResult.body.data.submissionId);
  }
  const practice = await assignment(path, now - 1000, now + 1000, now + 2000, { weightPct: '0.00' });
  await publish(practice.route, 1).expect(200);
});

async function topic(path: string, title: string, fileId?: string) {
  const created = await write('teacher', 'post', path + '/topics')
    .send({ title })
    .expect(201);
  const route = path + '/topics/' + created.body.data.id;
  const material = await write('teacher', 'post', route + '/materials')
    .send(
      fileId
        ? { title: 'Private resource', type: 'FILE', fileId }
        : { title: 'Required reading', type: 'TEXT', textBody: 'Synthetic required content' },
    )
    .expect(201);
  const materialRoute = route + '/materials/' + material.body.data.id;
  await publish(materialRoute, 1).expect(200);
  return { route, id: created.body.data.id as string, material: materialRoute };
}
async function publishTopic(path: string) {
  const { body } = await read('teacher', path).expect(200);
  return publish(path, body.data.version);
}
const questions = [
  {
    prompt: 'One plus one?',
    points: 1,
    explanation: 'Addition',
    options: [{ label: '2' }, { label: '3' }],
    correctOptionIndex: 0,
  },
  {
    prompt: 'Two plus two?',
    points: 3,
    explanation: 'Addition',
    options: [{ label: '4' }, { label: '5' }],
    correctOptionIndex: 0,
  },
];

test('T13/T29–T40/T46–T50/T61/T62/T65/T67/T69: quiz timing, published-only prerequisites, file gate and archival', async () => {
  const { path, adminPath } = await fixture();
  const first = await topic(path, 'Week 1');
  await publishTopic(first.route).then((response) => assert.equal(response.status, 200));
  const materials = await stage('teacher', 'private-resource.txt', 'MATERIAL');
  assert.equal(materials.status, 201);
  const second = await topic(path, 'Week 2', materials.body.data.id);
  const due = now + 90_000;
  const quiz = await draft(path, {
    type: 'QUIZ',
    title: 'Week 1 quiz',
    topicId: first.id,
    openAt: instant(now - 1000),
    dueAt: instant(due),
    weightPct: '20',
    quizSettings: {
      maxAttempts: 2,
      timeLimitMinutes: 1,
      resultRelease: 'MANUAL',
      shuffleQuestions: true,
      shuffleOptions: true,
      showAnswerReview: true,
    },
  });
  await publish(quiz.route, 1).expect(422);
  await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: 1, questions: [{ ...questions[0], correctOptionIndex: 5 }] })
    .expect(422);
  const bank = await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: 1, questions })
    .expect(200);
  const liveQuiz = await publish(quiz.route, bank.body.data.assessmentVersion).expect(200);
  await write('teacher', 'patch', quiz.route)
    .send({ version: liveQuiz.body.data.version, weightPct: '10' })
    .expect(409);
  await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: liveQuiz.body.data.version, questions })
    .expect(409);
  await read('student', quiz.route + '/questions').expect(403);
  const version = (await read('teacher', second.route).expect(200)).body.data.version;
  await write('teacher', 'put', second.route + '/release-rules')
    .send({ topicVersion: version, rules: [{ type: 'TOPIC_COMPLETE', sourceTopicId: second.id }] })
    .expect(422);
  await write('teacher', 'put', second.route + '/release-rules')
    .send({
      topicVersion: version,
      rules: [
        { type: 'TOPIC_COMPLETE', sourceTopicId: first.id },
        { type: 'QUIZ_SCORE_AT_LEAST', sourceAssessmentId: quiz.id, thresholdPct: '70.00' },
      ],
    })
    .expect(200);
  await publishTopic(second.route).then((response) => assert.equal(response.status, 200));
  const gated = await assignment(path, now - 1000, now + 10_000, now + 20_000, {
    topicId: second.id,
    weightPct: '0',
  });
  await publish(gated.route, 1).expect(200);
  await read('student', second.route)
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.data.learningState, 'LOCKED');
      assert.deepEqual(body.data.materials, []);
    });
  await read('student', gated.route)
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.data.availability, 'LOCKED');
      assert.equal(body.data.assignmentSettings, undefined);
    });
  await accept(gated.route, randomUUID()).expect(403).expect(assertCode('CONTENT_LOCKED'));
  await read('teacher', path + '/analytics/students')
    .expect(200)
    .expect(({ body }) => {
      const learner = body.data.find((row: { studentId: string }) => row.studentId === ids.student);
      assert.equal(learner.overallProgress.total, 2);
      assert.equal(learner.accessibleProgress.total, 1);
    });
  await read('student', materials.body.data.downloadUrl).expect(403);
  await write('student', 'put', second.material + '/completion')
    .send({})
    .expect(403);
  await write('student', 'put', first.material + '/completion')
    .send({})
    .expect(200);
  const beforeStartVersion = (await read('admin', adminPath).expect(200)).body.data.version;
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: beforeStartVersion, confirmUnpublishedGrades: false })
    .expect(409)
    .expect(assertCode('INVALID_STATE'));
  now += 40_000;
  const starts = await Promise.all([
    write('student', 'post', quiz.route + '/attempts').send({}),
    write('student', 'post', quiz.route + '/attempts').send({}),
  ]);
  assert.deepEqual(starts.map((response) => response.status).sort(), [200, 201]);
  const started = starts[0].body.data;
  assert.equal(starts[1].body.data.attemptId, started.attemptId);
  assert.equal(started.expiresAt, instant(due));
  assert.doesNotMatch(JSON.stringify(started), /correctOption|explanation|earnedPoints/);
  const attempt = quiz.route + '/attempts/' + started.attemptId;
  await read('peer', attempt).expect(404);
  const reload = await read('student', attempt).expect(200);
  assert.deepEqual(reload.body.data.questions, started.questions);
  const q1 = started.questions[0],
    q2 = started.questions[1];
  await write('student', 'put', attempt + '/answers/' + q1.id)
    .send({ selectedOptionId: q2.options[0].id, expectedRevision: 0 })
    .expect(422);
  const correct = new Map(
    bank.body.data.questions.map((question: { id: string; correctOptionId: string }) => [
      question.id,
      question.correctOptionId,
    ]),
  );
  await write('student', 'put', attempt + '/answers/' + q1.id)
    .send({ selectedOptionId: correct.get(q1.id), expectedRevision: 0 })
    .expect(200);
  await write('student', 'put', attempt + '/answers/' + q1.id)
    .send({ selectedOptionId: null, expectedRevision: 0 })
    .expect(409);
  const moduleVersion = (await read('admin', adminPath).expect(200)).body.data.version;
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: moduleVersion, confirmUnpublishedGrades: false })
    .expect(409)
    .expect(assertCode('ATTEMPT_IN_PROGRESS'));
  await write('admin', 'post', adminPath + '/enrolments/' + ids.student + '/withdraw')
    .send({})
    .expect(409)
    .expect(assertCode('ATTEMPT_IN_PROGRESS'));
  await write('admin', 'patch', '/admin/users/' + ids.student)
    .send({ isActive: false })
    .expect(409)
    .expect(assertCode('ATTEMPT_IN_PROGRESS'));
  now = due - 1;
  await write('student', 'put', attempt + '/answers/' + q2.id)
    .send({ selectedOptionId: correct.get(q2.id), expectedRevision: 0 })
    .expect(200);
  await read('student', attempt + '/review').expect(403);
  now = due;
  await write('student', 'put', attempt + '/answers/' + q2.id)
    .send({ selectedOptionId: null, expectedRevision: 1 })
    .expect(409)
    .expect(assertCode('ATTEMPT_EXPIRED'));
  await read('student', path + '/gradebook/me')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.assessments[0].publishedGrade, null));
  const [left, right] = await Promise.all([
    write('student', 'post', attempt + '/submit')
      .send({})
      .expect(200),
    write('student', 'post', attempt + '/submit')
      .send({})
      .expect(200),
  ]);
  assert.deepEqual(left.body, right.body);
  assert.equal(left.body.data.status, 'TIMED_OUT');
  assert.equal(left.body.data.publishedBest, null);
  const masked = await read('student', second.route).expect(200);
  assert.equal(
    masked.body.data.requirements.find((value: { type: string }) => value.type === 'QUIZ_SCORE_AT_LEAST')
      .publishedScorePct,
    null,
  );
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: moduleVersion, confirmUnpublishedGrades: false })
    .expect(409)
    .expect(assertCode('UNPUBLISHED_GRADES_CONFIRMATION_REQUIRED'));
  await write('teacher', 'post', quiz.route + '/grades/' + ids.student + '/publish')
    .send({ expectedVersion: 1 })
    .expect(200);
  await read('student', attempt + '/review')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.points, '4.00'));
  await read('student', second.route)
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.learningState, 'AVAILABLE'));
  await read('student', materials.body.data.downloadUrl).expect(200);
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: moduleVersion, confirmUnpublishedGrades: false })
    .expect(200);
  await write('student', 'put', second.material + '/completion')
    .send({})
    .expect(409);
  await read('student', materials.body.data.downloadUrl).expect(200);
});

test('T51/T53/T55/T57–T59/T64/T70: analytics rules and announcement visibility, upload cleanup and frozen history', async () => {
  const { path, adminPath } = await fixture();
  const initial = await read('teacher', path + '/analytics/summary').expect(200);
  assert.equal(initial.body.data.submissionRatePct, null);
  assert.equal(initial.body.data.quizMeanPct, null);
  assert.equal(initial.body.data.classWorkingAveragePct, null);
  await read('student', path + '/analytics/summary').expect(403);
  const item = await assignment(path, now - 1000, now + 1000, now + 2000, { weightPct: '100' });
  await publish(item.route, 1).expect(200);
  const order = await write('teacher', 'post', path + '/announcements')
    .send({ title: 'Published later', body: 'Required study task', isPinned: true })
    .expect(201);
  const announcement = path + '/announcements/' + order.body.data.id;
  await read('student', path + '/announcements')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.length, 0));
  await publish(announcement, 1).expect(200);
  await read('student', path + '/announcements')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data[0].title, 'Published later'));
  await write('teacher', 'post', announcement + '/archive')
    .send({ version: 2 })
    .expect(200);
  await read('student', path + '/announcements')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.length, 0));
  const keep = await stage('student', 'accepted.txt');
  await accept(item.route, keep.body.data.id).expect(201);
  const expire = await stage('student', 'staged.txt');
  now += 2000;
  const summary = await read('teacher', path + '/analytics/summary').expect(200);
  assert.equal(summary.body.data.submissionRatePct, '50.00');
  assert.equal(summary.body.data.studentsNeedingReview, 1);
  const config = await read('teacher', path + '/analytics/settings').expect(200);
  await write('teacher', 'put', path + '/analytics/settings')
    .send({ ...config.body.data, missingAssignmentsThreshold: 2, lowGradeEnabled: false })
    .expect(200);
  await read('teacher', path + '/analytics/students?needsReview=true')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.length, 0));
  const current = (await read('admin', adminPath).expect(200)).body.data.version;
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: current, confirmUnpublishedGrades: false })
    .expect(200);
  const atArchive = await read('teacher', path + '/analytics/summary').expect(200);
  await write('teacher', 'post', path + '/announcements')
    .send({ title: 'Draft', body: 'Read only' })
    .expect(409);
  now += 24 * 60 * 60_000;
  const cleaned = await cleanupUploads(services, createStorage(services.config));
  assert.ok(cleaned.removed >= 1);
  assert.equal((await pool.query('SELECT 1 FROM files WHERE id=$1', [expire.body.data.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM files WHERE id=$1', [keep.body.data.id])).rowCount, 1);
  const stored = (
    await pool.query<{ archived_at: Date }>('SELECT archived_at FROM modules WHERE id=$1', [
      adminPath.split('/').at(-1),
    ])
  ).rows[0].archived_at;
  assert.equal(atArchive.body.data.asOf, stored.toISOString());
  const signIn = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: 'teacher@example.test', password })
    .expect(200);
  sessions.teacher = { cookie: signIn.get('Set-Cookie')![0].split(';')[0], csrf: signIn.body.data.csrfToken };
  const later = await read('teacher', path + '/analytics/summary').expect(200);
  assert.deepEqual(later.body.data, atArchive.body.data);
});

test('T38 and T67: best quiz grade improves only when earned and review covers one published attempt', async () => {
  const { path } = await fixture();
  const due = now + 600_000;
  const quiz = await draft(path, {
    type: 'QUIZ',
    title: 'Best attempt quiz',
    openAt: instant(now - 1000),
    dueAt: instant(due),
    quizSettings: { maxAttempts: 4, timeLimitMinutes: 2, showAnswerReview: true },
  });
  const bank = await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: 1, questions })
    .expect(200);
  await publish(quiz.route, bank.body.data.assessmentVersion).expect(200);
  const correct = new Map(
    bank.body.data.questions.map((question: { id: string; correctOptionId: string }) => [
      question.id,
      question.correctOptionId,
    ]),
  );
  const submitted: string[] = [];
  for (const [index, marked] of [[1], [0], [0, 1], [0, 1]].entries()) {
    now += 1000;
    const result = await write('student', 'post', quiz.route + '/attempts')
      .send({})
      .expect(201);
    const attempt = quiz.route + '/attempts/' + result.body.data.attemptId;
    submitted.push(attempt);
    for (const requested of marked) {
      const question = result.body.data.questions[requested];
      await write('student', 'put', attempt + '/answers/' + question.id)
        .send({ selectedOptionId: correct.get(question.id), expectedRevision: 0 })
        .expect(200);
    }
    await write('student', 'post', attempt + '/submit')
      .send({})
      .expect(200)
      .expect(({ body }) => {
        assert.equal(body.data.publishedBest.points, index < 2 ? '3.00' : '4.00');
      });
  }
  await write('student', 'post', quiz.route + '/attempts')
    .send({})
    .expect(409)
    .expect(assertCode('ATTEMPT_LIMIT_REACHED'));
  const revisions = await read('teacher', quiz.route + '/grades/' + ids.student + '/revisions').expect(200);
  assert.equal(revisions.body.data.length, 2);
  now = due;
  await read('student', submitted[0] + '/review').expect(403);
  await read('student', submitted[2] + '/review').expect(200);
  await read('student', submitted[3] + '/review').expect(403);
});

test('T66 upload quota and limit are enforced per user and do not affect a peer', async () => {
  await fixture(48);
  for (let n = 0; n < 20; n++) {
    const result = await stage('student', 'upload-' + n + '.txt');
    assert.equal(result.status, 201);
  }
  const blocked = await stage('student', 'blocked.txt');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.get('Retry-After'), '3600');
  assert.equal((await stage('peer', 'peer.txt')).status, 201);
  now += 60 * 60 * 1000;
  const session = await request(app)
    .post('/api/v1/auth/login')
    .set('Origin', origin)
    .send({ email: 'student@example.test', password })
    .expect(200);
  sessions.student = { cookie: session.get('Set-Cookie')![0].split(';')[0], csrf: session.body.data.csrfToken };
  const quota = await stage('student', 'still-full.txt');
  assert.equal(quota.status, 409);
  assert.equal(quota.body.error.code, 'UPLOAD_QUOTA_EXCEEDED');
});

test('T52: class submission rate counts the due intersection once and reports late work', async () => {
  const members: Actor[] = ['student', 'peer', 'extra-one', 'extra-two'];
  const { path, adminPath } = await fixture(72, members);
  const due = now + 1000,
    close = due + 5000;
  const items = [];
  for (const number of [1, 2, 3]) {
    const item = await assignment(path, now - 1000, due, close, { title: 'Due brief ' + number, weightPct: '0.00' });
    await publish(item.route, 1).expect(200);
    items.push(item);
  }
  for (let i = 0; i < 9; i++) {
    if (i === 7) now = due;
    const actor = members[i % members.length];
    const uploaded = await stage(actor, 'answer-' + i + '.txt');
    assert.equal(uploaded.status, 201);
    await accept(items[Math.floor(i / 4)].route, uploaded.body.data.id, actor)
      .expect(201)
      .expect(({ body }) => assert.equal(body.data.isLate, i >= 7));
  }
  const result = await read('teacher', path + '/analytics/summary').expect(200);
  assert.equal(result.body.data.dueAssignmentOpportunities, 12);
  assert.equal(result.body.data.submittedAssignmentCount, 9);
  assert.equal(result.body.data.missingAssignmentCount, 3);
  assert.equal(result.body.data.lateSubmissionCount, 2);
  assert.equal(result.body.data.submissionRatePct, '75.00');
  await write('admin', 'post', adminPath + '/enrolments/' + ids['extra-two'] + '/withdraw')
    .send({})
    .expect(200);
  await write('admin', 'patch', '/admin/users/' + ids['extra-one'])
    .send({ isActive: false })
    .expect(200);
  await read('teacher', path + '/analytics/students')
    .expect(200)
    .expect(({ body }) => {
      assert.deepEqual(
        body.data.map((student: { studentId: string }) => student.studentId).sort(),
        [ids.student, ids.peer].sort(),
      );
    });
  await write('admin', 'patch', '/admin/users/' + ids['extra-one'])
    .send({ isActive: true })
    .expect(200);
});

test('T36/T54/T62: closed browsers reconcile once and unpublished history can be archived explicitly', async () => {
  const { path, adminPath } = await fixture(120);
  const due = now + 100_000;
  const quiz = await draft(path, {
    type: 'QUIZ',
    title: 'Timed manual quiz',
    openAt: instant(now - 1000),
    dueAt: instant(due),
    weightPct: '100',
    quizSettings: { maxAttempts: 1, timeLimitMinutes: 1, resultRelease: 'MANUAL' },
  });
  const bank = await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: 1, questions })
    .expect(200);
  await publish(quiz.route, bank.body.data.assessmentVersion).expect(200);
  const started = await write('student', 'post', quiz.route + '/attempts')
    .send({})
    .expect(201);
  now = due;
  await read('student', path + '/gradebook/me')
    .expect(200)
    .expect(({ body }) => {
      assert.equal(body.data.assessments[0].resultState, 'RESULT_PENDING');
      assert.equal(body.data.finalModuleScore, null);
    });
  const timedOut = (
    await pool.query('SELECT status,points FROM quiz_attempts WHERE id=$1', [started.body.data.attemptId])
  ).rows[0];
  assert.deepEqual(timedOut, { status: 'TIMED_OUT', points: '0.00' });
  await read('teacher', path + '/analytics/students')
    .expect(200)
    .expect(({ body }) => {
      const learner = body.data.find((row: { studentId: string }) => row.studentId === ids.student);
      assert.equal(learner.quizSampleCount, 1);
      assert.ok(!learner.reasons.some((reason: { code: string }) => reason.code === 'LOW_QUIZ_MEAN'));
    });
  const current = (await read('admin', adminPath).expect(200)).body.data.version;
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: current, confirmUnpublishedGrades: false })
    .expect(409);
  await write('admin', 'post', adminPath + '/archive')
    .send({ version: current, confirmUnpublishedGrades: true })
    .expect(200);
  await read('student', path + '/gradebook/me')
    .expect(200)
    .expect(({ body }) => assert.equal(body.data.assessments[0].publishedGrade, null));
});

test('T59/T69: cleanup and archive cannot interleave to lose an attached file or admit a new attempt', async () => {
  const { path, adminPath } = await fixture(180);
  const due = now + 2000,
    close = due + 2000;
  const item = await assignment(path, now - 1000, due, close);
  await publish(item.route, 1).expect(200);
  const [fresh, stale] = [await stage('student', 'current.txt'), await stage('student', 'expired.txt')];
  assert.equal(fresh.status, 201);
  assert.equal(stale.status, 201);
  await pool.query('UPDATE files SET expires_at=$2 WHERE id=$1', [stale.body.data.id, new Date(now)]);
  const [expired, accepted] = await Promise.all([
    accept(item.route, stale.body.data.id),
    accept(item.route, fresh.body.data.id).expect(201),
    cleanupUploads(services, createStorage(services.config)),
  ]);
  assert.ok([404, 409].includes(expired.status));
  await read('student', accepted.body.data.file.downloadUrl).expect(200);
  const quiz = await draft(path, {
    type: 'QUIZ',
    title: 'Archive race',
    openAt: instant(now - 1000),
    dueAt: instant(close),
  });
  const bank = await write('teacher', 'put', quiz.route + '/questions')
    .send({ assessmentVersion: 1, questions })
    .expect(200);
  await publish(quiz.route, bank.body.data.assessmentVersion).expect(200);
  const version = (await read('admin', adminPath).expect(200)).body.data.version;
  now = close - 1;
  const [archive, start] = await Promise.all([
    write('admin', 'post', adminPath + '/archive').send({ version, confirmUnpublishedGrades: false }),
    write('student', 'post', quiz.route + '/attempts').send({}),
  ]);
  assert.equal(archive.status, 409);
  assert.equal(start.status, 201);
  now = close;
  await write('admin', 'post', adminPath + '/archive')
    .send({ version, confirmUnpublishedGrades: true })
    .expect(200);
  await write('student', 'post', quiz.route + '/attempts')
    .send({})
    .expect(409);
});
