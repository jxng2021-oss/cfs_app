import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../apps/api/app/app.js';
import { hashPassword } from '../../apps/api/app/auth.js';
import { parseConfig } from '../../apps/api/app/config.js';
import { createPool, databaseClock, migrate } from '../../apps/api/app/db.js';

const origin = 'http://localhost:3000';
const password = 'fixture for admissions integration';
const testUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://admissions:local-test-db-only@localhost:55433/admissions_test');
if (!/^\/[a-z0-9_]+_test$/i.test(testUrl.pathname)) throw new Error('Use a dedicated _test database');
const schema = 'admissions_' + randomUUID().replaceAll('-', '');
const root = createPool(testUrl.href);
testUrl.searchParams.set('options', '-c search_path=' + schema);
const pool = createPool(testUrl.href);
let app: Express;
const roles = { admin: 'ADMIN', officer: 'OFFICER', viewer: 'VIEWER' } as const;
type Actor = keyof typeof roles;
const sessions = {} as Record<Actor, { cookie: string; csrf: string }>;
const ids = {} as Record<Actor, string>;

before(async () => {
  await root.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: testUrl.href, SESSION_PEPPER: 'admissions test pepper with more than 32 characters' });
  app = createApp({ config, pool, clock: databaseClock });
  const hash = await hashPassword(password);
  for (const actor of Object.keys(roles) as Actor[]) {
    const { rows } = await pool.query<{ id: string }>(
      'INSERT INTO users (email_normalized, display_name, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, false) RETURNING id',
      [actor + '@example.test', actor, roles[actor], hash]);
    ids[actor] = rows[0].id;
    const response = await request(app).post('/api/auth/login').set('Origin', origin).send({ email: actor + '@example.test', password }).expect(200);
    sessions[actor] = { cookie: response.get('Set-Cookie')![0].split(';')[0], csrf: response.body.data.csrfToken };
  }
});
after(async () => {
  await pool.end();
  try { await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); } finally { await root.end(); }
});

const write = (actor: Actor, method: 'post' | 'patch' | 'put' | 'delete', path: string) =>
  request(app)[method]('/api' + path).set({ Origin: origin, Cookie: sessions[actor].cookie, 'X-CSRF-Token': sessions[actor].csrf });
const read = (actor: Actor, path: string) => request(app).get('/api' + path).set('Cookie', sessions[actor].cookie);
const code = (expected: string) => (response: { body: { error: { code: string } } }) => assert.equal(response.body.error.code, expected);
const day = 86_400_000;

async function programme(overrides: Record<string, unknown> = {}) {
  const { body } = await write('admin', 'post', '/programmes').send({
    code: 'P' + randomUUID().slice(0, 6).toUpperCase(), name: 'Bachelor of Testing', faculty: 'Faculty of Quality', qualificationType: 'BACHELOR',
    durationMonths: 36, minimumQualification: 'PRE_UNIVERSITY', minimumGpa: 3, ...overrides,
  }).expect(201);
  return body.data as { id: string; code: string; version: number };
}
async function intake(programmeId: string, capacity = 50, open = true) {
  const now = Date.now();
  const { body } = await write('admin', 'post', '/intakes').send({
    programmeId, name: 'Intake ' + randomUUID().slice(0, 6), academicYear: '2026/2027',
    opensAt: new Date(now - 10 * day).toISOString(), closesAt: new Date(now + 30 * day).toISOString(), commencesOn: new Date(now + 60 * day).toISOString().slice(0, 10), capacity,
  }).expect(201);
  if (open) await write('admin', 'post', '/intakes/' + body.data.id + '/status').send({ status: 'OPEN', version: body.data.version }).expect(200);
  return body.data as { id: string };
}
async function applicant(overrides: Record<string, unknown> = {}) {
  const { body } = await write('officer', 'post', '/applicants').send({
    firstName: 'Test', lastName: 'Applicant', email: randomUUID().slice(0, 8) + '@example.test', phone: '+65 9123 4567', dateOfBirth: '2006-05-04',
    nationality: 'Singaporean', address: '1 Example Road', previousInstitution: 'Example Junior College', highestQualification: 'PRE_UNIVERSITY', gpa: 3.4, ...overrides,
  }).expect(201);
  return body.data as { id: string; applicantNumber: string; version: number; email: string };
}
async function application(applicantId: string, programmeId: string, intakeId: string, submit = true) {
  const { body } = await write('officer', 'post', '/applications').send({ applicantId, programmeId, intakeId, submit }).expect(201);
  return body.data as { id: string; reference: string; status: string };
}
async function act(id: string, action: string, body: Record<string, unknown> = {}, actor: Actor = 'officer') {
  const current = await read(actor, '/applications/' + id).expect(200);
  return write(actor, 'post', `/applications/${id}/${action}`).send({ version: current.body.data.version, ...body });
}

test('health checks and instance identity are public and contain no secrets', async () => {
  await request(app).get('/health').expect(200).expect(({ body }) => assert.equal(body.status, 'ok'));
  await request(app).get('/health/ready').expect(200);
  const { body } = await request(app).get('/api/infrastructure/instance').expect(200);
  assert.equal(body.data.deployment, 'Local development');
  assert.equal(body.data.instanceId, null);
  const text = JSON.stringify(body).toLowerCase();
  for (const secret of ['pepper', 'database_url', 'password', 'token', 'secret']) assert.ok(!text.includes(secret), secret);
  await request(app).get('/api/infrastructure/status').expect(401);
  await read('viewer', '/infrastructure/status').expect(200).expect(({ body: status }) => assert.equal(status.data.health, 'healthy'));
});

test('roles are enforced on the server: viewers read only, officers cannot manage programmes', async () => {
  await read('viewer', '/applicants').expect(200);
  await write('viewer', 'post', '/applicants').send({}).expect(403).expect(code('FORBIDDEN'));
  await write('officer', 'post', '/programmes').send({}).expect(403);
  await read('officer', '/activity').expect(403);
  await read('admin', '/activity').expect(200);
  await read('officer', '/users').expect(403);
});

test('intakes validate dates and capacity, and belong to their programme', async () => {
  const course = await programme();
  const now = Date.now();
  const base = { programmeId: course.id, name: 'Bad', academicYear: '2026/2027', commencesOn: new Date(now + 90 * day).toISOString().slice(0, 10) };
  await write('admin', 'post', '/intakes').send({ ...base, opensAt: new Date(now + day).toISOString(), closesAt: new Date(now).toISOString(), capacity: 10 }).expect(422);
  await write('admin', 'post', '/intakes').send({ ...base, opensAt: new Date(now).toISOString(), closesAt: new Date(now + day).toISOString(), capacity: 0 }).expect(422);
  await write('admin', 'post', '/intakes').send({ ...base, opensAt: new Date(now).toISOString(), closesAt: new Date(now + day).toISOString(), capacity: 1.5 }).expect(422);
  const other = await programme();
  const otherIntake = await intake(other.id);
  const person = await applicant();
  await write('officer', 'post', '/applications').send({ applicantId: person.id, programmeId: course.id, intakeId: otherIntake.id, submit: true })
    .expect(422).expect(({ body }) => assert.match(body.error.message, /different programme/));
  const upcoming = await intake(course.id, 10, false);
  await write('officer', 'post', '/applications').send({ applicantId: person.id, programmeId: course.id, intakeId: upcoming.id, submit: true }).expect(409).expect(code('INTAKE_NOT_OPEN'));
});

test('the full admission workflow records history, decisions and activity; invalid transitions are refused', async () => {
  const course = await programme();
  const window = await intake(course.id);
  const person = await applicant();
  await write('officer', 'post', '/applicants').send({ firstName: 'Dup', lastName: 'Licate', email: person.email, phone: '+65 9000 0000', dateOfBirth: '2006-01-01',
    nationality: 'Malaysian', address: 'x', previousInstitution: 'y', highestQualification: 'DIPLOMA' }).expect(409).expect(code('DUPLICATE_EMAIL'));
  const created = await application(person.id, course.id, window.id);
  assert.match(created.reference, /^ADM-\d{4}-\d{6}$/);
  assert.equal(created.status, 'SUBMITTED');
  await write('officer', 'post', '/applications').send({ applicantId: person.id, programmeId: course.id, intakeId: window.id }).expect(409).expect(code('DUPLICATE_APPLICATION'));
  await act(created.id, 'enrol').then(response => { assert.equal(response.status, 409); assert.equal(response.body.error.code, 'INVALID_TRANSITION'); });
  await act(created.id, 'start-review').then(response => assert.equal(response.status, 200));
  await act(created.id, 'request-information').then(response => assert.equal(response.status, 422, 'reason is required'));
  await act(created.id, 'request-information', { reason: 'Need transcript' }).then(response => assert.equal(response.status, 200));
  await act(created.id, 'resume-review').then(response => assert.equal(response.status, 200));
  await act(created.id, 'issue-offer', { offerResponseDeadline: new Date(Date.now() + 10 * day).toISOString().slice(0, 10) }).then(response => assert.equal(response.status, 200));
  await act(created.id, 'accept-offer').then(response => assert.equal(response.status, 200));
  await act(created.id, 'enrol').then(response => assert.equal(response.status, 200));
  const { body } = await read('viewer', '/applications/' + created.id).expect(200);
  assert.equal(body.data.status, 'ENROLLED');
  assert.equal(body.data.decision, 'OFFERED');
  assert.deepEqual(body.data.history.map((entry: { toStatus: string }) => entry.toStatus),
    ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'UNDER_REVIEW', 'OFFER_ISSUED', 'OFFER_ACCEPTED', 'ENROLLED']);
  assert.equal(body.data.history[3].reason, 'Need transcript');
  assert.deepEqual(body.data.availableActions, []);
  assert.equal(body.data.requirements.met, true);
  await act(created.id, 'withdraw', { reason: 'late' }).then(response => assert.equal(response.status, 409));
  await read('viewer', '/applications/' + created.id).then(response => assert.equal(response.body.data.reviewer.id, ids.officer));
  const activity = await read('admin', '/activity?entityType=APPLICATION&q=' + created.reference).expect(200);
  assert.ok(activity.body.data.some((entry: { action: string }) => entry.action === 'ENROLMENT_CONFIRMED'));
  await write('officer', 'delete', '/applications/' + created.id).expect(409).expect(code('HAS_HISTORY'));
});

test('rejection requires a reason by default; drafts must be submitted before review', async () => {
  const course = await programme();
  const window = await intake(course.id);
  const draft = await application((await applicant()).id, course.id, window.id, false);
  assert.equal(draft.status, 'DRAFT');
  await act(draft.id, 'start-review').then(response => assert.equal(response.status, 409));
  await act(draft.id, 'submit').then(response => assert.equal(response.status, 200));
  await act(draft.id, 'start-review');
  await act(draft.id, 'reject').then(response => assert.equal(response.status, 422));
  await act(draft.id, 'reject', { reason: 'Below minimum GPA' }).then(response => assert.equal(response.status, 200));
  await act(draft.id, 'issue-offer').then(response => assert.equal(response.status, 409));
  await read('viewer', '/applications/' + draft.id).then(response => assert.equal(response.body.data.decision, 'REJECTED'));
});

test('confirmed enrolments never exceed intake capacity, even under concurrent requests', async () => {
  const course = await programme();
  const window = await intake(course.id, 1);
  const accepted: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const created = await application((await applicant()).id, course.id, window.id);
    for (const step of ['start-review', 'issue-offer', 'accept-offer']) assert.equal((await act(created.id, step)).status, 200);
    accepted.push(created.id);
  }
  const versions = await Promise.all(accepted.map(id => read('officer', '/applications/' + id).then(response => response.body.data.version as number)));
  const results = await Promise.all(accepted.map((id, index) => write('officer', 'post', `/applications/${id}/enrol`).send({ version: versions[index] })));
  assert.deepEqual(results.map(response => response.status).sort(), [200, 409]);
  assert.equal(results.find(response => response.status === 409)!.body.error.code, 'CAPACITY_REACHED');
  const { body } = await read('viewer', '/intakes/' + window.id).expect(200);
  assert.equal(body.data.enrolled, 1);
  assert.equal(body.data.remainingCapacity, 0);
  const current = await read('admin', '/intakes/' + window.id);
  await write('admin', 'patch', '/intakes/' + window.id).send({ capacity: 1, version: current.body.data.version }).expect(200);
});

test('stale versions are refused so two officers cannot overwrite each other', async () => {
  const course = await programme();
  const created = await application((await applicant()).id, course.id, (await intake(course.id)).id);
  const { body } = await read('officer', '/applications/' + created.id);
  await write('officer', 'post', `/applications/${created.id}/start-review`).send({ version: body.data.version }).expect(200);
  await write('admin', 'post', `/applications/${created.id}/withdraw`).send({ version: body.data.version, reason: 'x' }).expect(409).expect(code('VERSION_CONFLICT'));
});

test('applicants with applications are archived rather than deleted; open applications block archiving', async () => {
  const course = await programme();
  const person = await applicant();
  const created = await application(person.id, course.id, (await intake(course.id)).id);
  await write('officer', 'delete', '/applicants/' + person.id).expect(409).expect(code('HAS_HISTORY'));
  await write('officer', 'post', `/applicants/${person.id}/archive`).send({ version: person.version }).expect(409).expect(code('INVALID_STATE'));
  await act(created.id, 'withdraw', { reason: 'Changed plans' });
  await write('officer', 'post', `/applicants/${person.id}/archive`).send({ version: person.version }).expect(200);
  await read('viewer', '/applicants?q=' + person.applicantNumber).expect(200).expect(({ body }) => assert.equal(body.data.length, 0));
  await read('viewer', '/applicants?status=ARCHIVED&q=' + person.applicantNumber).expect(200).expect(({ body }) => assert.equal(body.data.length, 1));
  const unused = await applicant();
  await write('officer', 'delete', '/applicants/' + unused.id).expect(204);
});

test('applicant search, filters, sorting and CSV export', async () => {
  const marker = 'Zq' + randomUUID().slice(0, 5);
  await applicant({ lastName: marker + 'b', nationality: 'Thai', gpa: 2.5 });
  await applicant({ lastName: marker + 'a', nationality: 'Thai', gpa: 3.9, highestQualification: 'DIPLOMA' });
  const sorted = await read('viewer', `/applicants?q=${marker}&sort=gpa&dir=desc`).expect(200);
  assert.deepEqual(sorted.body.data.map((row: { gpa: string }) => row.gpa), ['3.90', '2.50']);
  await read('viewer', `/applicants?q=${marker}&qualification=DIPLOMA`).expect(({ body }) => assert.equal(body.data.length, 1));
  await read('viewer', `/applicants?q=${marker}&nationality=Thai&pageSize=1`).expect(({ body }) => assert.equal(body.pagination.totalPages, 2));
  const csv = await read('viewer', `/applicants/export?q=${marker}`).expect(200).expect('Content-Type', /text\/csv/);
  assert.equal(csv.text.trim().split('\r\n').length, 3);
  await read('viewer', '/applicants?sort=password').expect(422);
});

test('analytics compute rates from data and report null instead of dividing by zero', async () => {
  const course = await programme({ faculty: 'Faculty of Analytics ' + randomUUID().slice(0, 4) });
  const window = await intake(course.id, 4);
  const offered = await application((await applicant()).id, course.id, window.id);
  await act(offered.id, 'start-review');
  await act(offered.id, 'issue-offer');
  const rejected = await application((await applicant()).id, course.id, window.id);
  await act(rejected.id, 'start-review');
  await act(rejected.id, 'reject', { reason: 'No' });
  await application((await applicant()).id, course.id, window.id);
  const { body } = await read('viewer', '/analytics?programmeId=' + course.id).expect(200);
  assert.equal(body.data.summary.submitted, 3);
  assert.equal(body.data.summary.offersIssued, 1);
  assert.equal(body.data.summary.offerRate, 33.33);
  assert.equal(body.data.summary.rejectionRate, 33.33);
  assert.equal(body.data.summary.acceptanceRate, 0);
  const empty = await read('viewer', '/analytics?faculty=Nowhere').expect(200);
  assert.equal(empty.body.data.summary.offerRate, null);
  assert.equal(empty.body.data.summary.acceptanceRate, null);
  await read('viewer', '/analytics?from=2026-05-01&to=2026-01-01').expect(422);
  const dashboard = await read('officer', '/dashboard').expect(200);
  assert.equal(dashboard.body.data.recentActivity, null, 'activity is administrator-only');
  assert.ok(dashboard.body.data.cards.totalApplications >= 3);
});

test('settings change behaviour and are audited; the activity log is append-only', async () => {
  await write('officer', 'patch', '/settings').send({ referencePrefix: 'UG' }).expect(403);
  await write('admin', 'patch', '/settings').send({ referencePrefix: 'UG', referenceIncludeYear: false, requireRejectionReason: false }).expect(200);
  const course = await programme();
  const created = await application((await applicant()).id, course.id, (await intake(course.id)).id);
  assert.match(created.reference, /^UG-\d{6}$/);
  await act(created.id, 'start-review');
  await act(created.id, 'reject').then(response => assert.equal(response.status, 200, 'reason optional once the setting is off'));
  await write('admin', 'patch', '/settings').send({ institutionLogo: 'data:text/html;base64,PHNjcmlwdD4=' }).expect(422);
  const publicSettings = await request(app).get('/api/settings/public').expect(200);
  assert.deepEqual(Object.keys(publicSettings.body.data).sort(), ['adminNumber', 'dateFormat', 'defaultAcademicYear', 'institutionLogo', 'institutionName']);
  await write('admin', 'patch', '/settings').send({ referencePrefix: 'ADM', referenceIncludeYear: true, requireRejectionReason: true }).expect(200);
  const log = await read('admin', '/activity?action=SETTINGS_UPDATED').expect(200);
  assert.ok(log.body.data.length >= 2);
  await assert.rejects(pool.query("UPDATE audit_events SET description = 'tampered'"), /read-only/);
  await assert.rejects(pool.query('DELETE FROM audit_events'), /read-only/);
});
