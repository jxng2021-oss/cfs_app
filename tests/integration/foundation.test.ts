import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import argon2 from 'argon2';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../../apps/api/app/app.js';
import { hashPassword } from '../../apps/api/app/auth.js';
import { parseConfig } from '../../apps/api/app/config.js';
import { createPool, migrate } from '../../apps/api/app/db.js';

const origin = 'http://localhost:3000';
const password = 'synthetic integration fixture';
const newer = 'synthetic replacement fixture';
const databaseUrl = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://lms:local-test-db-only@localhost:55433/lms_test');
if (!/^\/[a-z0-9_]+_test$/i.test(databaseUrl.pathname)) throw new Error('TEST_DATABASE_URL must name a dedicated database ending in _test');
const schema = 'suite_' + randomUUID().replaceAll('-', '');
const root = createPool(databaseUrl.href);
databaseUrl.searchParams.set('options', '-c search_path=' + schema);
const pool = createPool(databaseUrl.href);
let app: Express;
let now = new Date('2026-11-25T04:00:00.000Z');

before(async () => {
  await root.query('CREATE SCHEMA ' + schema);
  await migrate(pool);
  await migrate(pool);
  await pool.query("INSERT INTO users (email_normalized, display_name, role, password_hash, must_change_password) VALUES ('admin@example.test', 'Admin', 'ADMIN', $1, false)", [await hashPassword(password)]);
  const config = parseConfig({ NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: databaseUrl.href, SESSION_PEPPER: 'synthetic-integration-session-key-32-characters' });
  app = createApp({ pool, config, clock: async () => now });
});

after(async () => {
  await pool.end();
  try { await root.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE'); }
  finally { await root.end(); }
});

type SignedIn = { cookie: string; csrf: string };
async function login(address: string, supplied = password): Promise<SignedIn> {
  const response = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: address, password: supplied }).expect(200);
  const cookie = response.get('Set-Cookie')?.[0];
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  return { cookie: cookie.split(';')[0], csrf: response.body.data.csrfToken };
}
function write(method: 'post' | 'patch' | 'put', path: string, session: SignedIn) {
  return request(app)[method]('/api/v1' + path).set({ Origin: origin, Cookie: session.cookie, 'X-CSRF-Token': session.csrf });
}
function read(path: string, session: SignedIn) {
  return request(app).get('/api/v1' + path).set('Cookie', session.cookie);
}
async function provision(admin: SignedIn, key: string, role: 'STUDENT' | 'LECTURER') {
  const address = key + '@example.test';
  const { body } = await write('post', '/admin/users', admin).send({ email: '  ' + address.toUpperCase() + '  ', displayName: key, role }).expect(201);
  return { id: body.data.user.id as string, temporary: body.data.temporaryPassword as string, address };
}
async function finishTemporary(account: Awaited<ReturnType<typeof provision>>) {
  const temporary = await login(account.address, account.temporary);
  const response = await write('post', '/auth/change-password', temporary).send({ currentPassword: account.temporary, newPassword: newer }).expect(200);
  return { cookie: (response.get('Set-Cookie')?.[0] ?? '').split(';')[0], csrf: response.body.data.csrfToken as string };
}

test('T01–T04 and T08: provision, force password change, rotate and revoke sessions, block invalid CSRF', async () => {
  const admin = await login(' Admin@EXAMPLE.test ');
  const student = await provision(admin, 'auth-student', 'STUDENT');
  const stored = (await pool.query('SELECT * FROM users WHERE id = $1', [student.id])).rows[0];
  assert.equal(stored.email_normalized, student.address);
  assert.equal(stored.must_change_password, true);
  assert.notEqual(stored.password_hash, student.temporary);
  assert.equal(await argon2.verify(stored.password_hash, student.temporary), true);

  await write('post', '/admin/users', admin).send({ email: student.address, displayName: 'Duplicate', role: 'STUDENT' }).expect(409);
  await request(app).post('/api/v1/admin/users').set({ Origin: origin, Cookie: admin.cookie }).send({ email: 'should-not-exist@example.test', displayName: 'Blocked', role: 'STUDENT' }).expect(403);
  await request(app).post('/api/v1/auth/login').set('Origin', 'https://unknown.example.test').send({ email: student.address, password: student.temporary }).expect(403);

  const temporary = await login(student.address, student.temporary);
  await read('/modules', temporary).expect(403).expect(({ body }) => assert.equal(body.error.code, 'PASSWORD_CHANGE_REQUIRED'));
  await read('/auth/me', temporary).expect(200);
  const another = await login(student.address, student.temporary);
  const current = await finishTemporary(student);
  assert.notEqual(current.cookie, temporary.cookie);
  await read('/auth/me', temporary).expect(401);
  await read('/auth/me', another).expect(401);
  await read('/modules', current).expect(200);

  const wrong = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: student.address, password }).expect(401);
  const unknown = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: 'unknown@example.test', password }).expect(401);
  assert.equal(wrong.body.error.message, unknown.body.error.message);
  await write('post', '/auth/logout', current).send({}).expect(204);
  await read('/auth/me', current).expect(401);
  const afterLogout = await login(student.address, newer);
  const reset = await write('post', '/admin/users/' + student.id + '/reset-password', admin).send({}).expect(200);
  assert.equal(reset.get('Cache-Control'), 'no-store');
  await read('/auth/me', afterLogout).expect(401);
  const resetSession = await login(student.address, reset.body.data.temporaryPassword);
  await write('patch', '/admin/users/' + student.id, admin).send({ isActive: false }).expect(200);
  await read('/auth/me', resetSession).expect(401);
  const disabled = await request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: student.address, password: reset.body.data.temporaryPassword }).expect(401);
  assert.equal(disabled.body.error.message, wrong.body.error.message);
  await write('patch', '/admin/users/' + student.id, admin).send({ isActive: true }).expect(200);
  await read('/auth/me', resetSession).expect(401);
  const audit = await read('/admin/audit-events', admin).expect(200);
  assert.ok(audit.body.data.some((event: { eventType: string }) => event.eventType === 'USER_PASSWORD_RESET'));
  assert.doesNotMatch(JSON.stringify(audit.body), /temporaryPassword|password_hash/);
});

test('T06, T09–T11 and T63: draft visibility, duplicate enrolment, lecturer isolation, transfer and stale edits', async () => {
  const admin = await login('admin@example.test');
  const lecturer = await provision(admin, 'primary-lecturer', 'LECTURER');
  const otherLecturer = await provision(admin, 'other-lecturer', 'LECTURER');
  const student = await provision(admin, 'module-student', 'STUDENT');
  const primary = await finishTemporary(lecturer);
  const other = await finishTemporary(otherLecturer);
  const learner = await finishTemporary(student);
  const fixture = { code: 'se101', name: 'Software engineering', term: 'Demo term', lecturerId: lecturer.id };
  const { body } = await write('post', '/admin/modules', admin).send(fixture).expect(201);
  const moduleId = body.data.id;
  const adminPath = '/admin/modules/' + moduleId;
  const path = '/modules/' + moduleId;
  await write('post', '/admin/modules', admin).send({ ...fixture, term: 'DEMO TERM' }).expect(409);
  await write('post', adminPath + '/enrolments', admin).send({ studentId: student.id }).expect(201);
  await write('post', adminPath + '/enrolments', admin).send({ studentId: student.id }).expect(409);

  await read('/modules', learner).expect(200).expect(({ body }) => assert.deepEqual(body.data, []));
  await read(path, learner).expect(404);
  await read(path, primary).expect(200);
  await read(path, other).expect(404);
  await read('/admin/users', primary).expect(403);
  await read(path, admin).expect(403);
  await write('patch', '/admin/users/' + lecturer.id, admin).send({ isActive: false }).expect(409);

  await write('post', adminPath + '/activate', admin).send({ version: 1 }).expect(200);
  await read('/modules', learner).expect(200).expect(({ body }) => assert.equal(body.data[0].id, moduleId));
  await read(path, learner).expect(200);
  await read(path + '/roster', learner).expect(403);
  await read(path + '/roster', primary).expect(200).expect(({ body }) => assert.equal(body.data[0].studentId, student.id));
  await write('post', adminPath + '/enrolments/' + student.id + '/withdraw', admin).send({}).expect(200);
  await read(path, learner).expect(404);
  await write('post', adminPath + '/enrolments/' + student.id + '/reactivate', admin).send({}).expect(200);
  await read(path, learner).expect(200);
  const records = await pool.query('SELECT * FROM enrolments WHERE module_id = $1 AND student_id = $2', [moduleId, student.id]);
  assert.equal(records.rowCount, 1);

  await write('patch', adminPath, admin).send({ version: 1, name: 'Stale update' }).expect(409);
  await write('patch', adminPath, admin).send({ version: 2, lecturerId: otherLecturer.id }).expect(200);
  await read(path, primary).expect(404);
  await read(path, other).expect(200);
  await read(adminPath, admin).expect(200).expect(({ body }) => assert.equal(body.data.description, ''));
});

test('T66 login limits and exact idle and absolute session boundaries use the injected clock', async () => {
  const user = 'rate-test@example.test';
  const attempt = () => request(app).post('/api/v1/auth/login').set('Origin', origin).send({ email: user, password: 'incorrect' });
  for (let i = 0; i < 10; i++) await attempt().expect(401);
  await attempt().expect(429).expect('Retry-After', '900');
  now = new Date(now.getTime() + 15 * 60_000);
  await attempt().expect(401);
  const admin = await login('admin@example.test');
  now = new Date(now.getTime() + 60 * 60_000 - 1000);
  await read('/auth/me', admin).expect(200);
  now = new Date(now.getTime() + 60 * 60_000);
  await read('/auth/me', admin).expect(401);
  const nextSession = await login('admin@example.test');
  for (let i = 0; i < 23; i++) {
    now = new Date(now.getTime() + 30 * 60_000);
    await read('/auth/me', nextSession).expect(200);
  }
  now = new Date(now.getTime() + 30 * 60_000);
  await read('/auth/me', nextSession).expect(401);
});

test('T12, T14–T18 and T50: publish required materials, hide drafts, retain progress and archive read-only', async () => {
  const admin = await login('admin@example.test');
  const lecturer = await provision(admin, 'content-lecturer', 'LECTURER');
  const student = await provision(admin, 'content-student', 'STUDENT');
  const teacher = await finishTemporary(lecturer);
  const learner = await finishTemporary(student);
  const module = await write('post', '/admin/modules', admin).send({
    code: 'ENG101', name: 'Reading and writing', term: 'Demo term', lecturerId: lecturer.id,
  }).expect(201);
  const moduleId = module.body.data.id;
  const adminPath = '/admin/modules/' + moduleId;
  const modulePath = '/modules/' + moduleId;
  const base = modulePath + '/topics';
  await write('post', adminPath + '/enrolments', admin).send({ studentId: student.id }).expect(201);
  await write('post', adminPath + '/activate', admin).send({ version: 1 }).expect(200);
  await read(modulePath + '/progress/me', learner).expect(200).expect(({ body }) => {
    assert.deepEqual(body.data.overall, { completed: 0, total: 0, percent: null });
  });
  const createTopic = async (title: string) => (await write('post', base, teacher).send({ title }).expect(201)).body.data.id as string;
  const createMaterial = async (path: string, title: string, required: boolean) => (
    await write('post', path + '/materials', teacher).send({ title, required, type: 'TEXT', textBody: '<script>plain text</script>' }).expect(201)
  ).body.data.id as string;
  const publishMaterial = (path: string) => write('post', path + '/publish', teacher).send({ version: 1 }).expect(200);
  const publishTopic = async (path: string, status: number) => {
    const current = await read(path, teacher).expect(200);
    await write('post', path + '/publish', teacher).send({ version: current.body.data.version }).expect(status);
  };

  const first = base + '/' + await createTopic('Week 1');
  const optional = first + '/materials/' + await createMaterial(first, 'Optional reading', false);
  await publishMaterial(optional);
  await publishTopic(first, 422);
  await read(first, learner).expect(404);
  await write('post', first + '/materials', teacher).send({ title: 'Unsafe link', type: 'LINK', externalUrl: 'javascript:alert(1)' }).expect(422);
  const required = first + '/materials/' + await createMaterial(first, 'Required reading', true);
  const hidden = first + '/materials/' + (await write('post', first + '/materials', teacher).send({
    title: 'Draft link', type: 'LINK', externalUrl: 'https://example.test/reading',
  }).expect(201)).body.data.id;
  await publishMaterial(required);
  await publishTopic(first, 200);
  await read(hidden, learner).expect(404);
  await read(first, learner).expect(200).expect(({ body }) => {
    assert.equal(body.data.materials.length, 2);
    assert.ok(body.data.materials.every((item: Record<string, unknown>) => !('textBody' in item) && !('externalUrl' in item)));
  });
  await write('patch', required, teacher).send({ version: 2, textBody: 'changed' }).expect(409);
  await read(required, learner).expect(200).expect(({ body }) => assert.equal(body.data.textBody, '<script>plain text</script>'));
  await write('put', optional + '/completion', learner).send({}).expect(409);
  const [one, two] = await Promise.all([
    write('put', required + '/completion', learner).send({}).expect(200),
    write('put', required + '/completion', learner).send({}).expect(200),
  ]);
  assert.deepEqual(one.body, two.body);
  const completions = await pool.query('SELECT * FROM material_completions WHERE student_id = $1', [student.id]);
  assert.equal(completions.rowCount, 1);

  const second = base + '/' + await createTopic('Week 2');
  await read(base, learner).expect(200).expect(({ body }) => assert.equal(body.data.length, 1));
  await publishMaterial(second + '/materials/' + await createMaterial(second, 'Second reading', true));
  await publishTopic(second, 200);
  await read(modulePath + '/progress/me', learner).expect(200).expect(({ body }) => {
    assert.deepEqual(body.data.overall, { completed: 1, total: 2, percent: 50 });
  });
  const currentModule = await read(adminPath, admin).expect(200);
  await write('post', adminPath + '/archive', admin).send({ version: currentModule.body.data.version, confirmUnpublishedGrades: false }).expect(200);
  await read(required, learner).expect(200);
  await write('put', required + '/completion', learner).send({}).expect(409);
  await write('post', base, teacher).send({ title: 'Archived mutation' }).expect(409);
  await write('post', adminPath + '/enrolments/' + student.id + '/withdraw', admin).send({}).expect(409);
});

test('liveness bypasses authentication and readiness verifies PostgreSQL', async () => {
  await request(app).get('/health').expect(200, { status: 'ok' });
  await request(app).get('/health/ready').expect(200, { status: 'ready' });
});
