import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../../apps/api/app/config.js';
import {
  availableActions, decisionFor, formatReference, intakeTransitions, rate, requirementCheck, transition, TransitionError, workflow, workflowActions,
  type ApplicationStatus,
} from '../../apps/api/app/domain.js';

test('the happy path runs Draft → Submitted → Under review → Offer issued → Offer accepted → Enrolled', () => {
  let status: ApplicationStatus = 'DRAFT';
  for (const action of ['submit', 'start-review', 'issue-offer', 'accept-offer', 'enrol'] as const) status = transition(status, action);
  assert.equal(status, 'ENROLLED');
});

test('invalid transitions are rejected, including Draft straight to Enrolled', () => {
  assert.throws(() => transition('DRAFT', 'enrol'), TransitionError);
  assert.throws(() => transition('SUBMITTED', 'issue-offer'), TransitionError);
  assert.throws(() => transition('REJECTED', 'start-review'), TransitionError);
  assert.throws(() => transition('ENROLLED', 'withdraw'), TransitionError);
  assert.throws(() => transition('OFFER_ISSUED', 'enrol'), TransitionError);
});

test('terminal statuses offer no actions; review statuses offer exactly the documented ones', () => {
  for (const status of ['OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED'] as const) assert.deepEqual(availableActions(status), []);
  assert.deepEqual(availableActions('SUBMITTED'), ['start-review', 'withdraw']);
  assert.deepEqual(availableActions('UNDER_REVIEW'), ['request-information', 'waitlist', 'issue-offer', 'reject', 'withdraw']);
  assert.deepEqual(availableActions('OFFER_ISSUED'), ['accept-offer', 'decline-offer', 'withdraw']);
  assert.deepEqual(availableActions('OFFER_ACCEPTED'), ['enrol', 'withdraw']);
});

test('every workflow action leads somewhere reachable and records the right decision', () => {
  for (const action of workflowActions) for (const from of workflow[action].from) assert.equal(transition(from, action), workflow[action].to);
  assert.equal(decisionFor('OFFER_ISSUED'), 'OFFERED');
  assert.equal(decisionFor('REJECTED'), 'REJECTED');
  assert.equal(decisionFor('WAITLISTED'), 'WAITLISTED');
  assert.equal(decisionFor('ENROLLED'), null);
});

test('intakes cannot reopen once completed or cancelled', () => {
  assert.deepEqual(intakeTransitions.COMPLETED, []);
  assert.deepEqual(intakeTransitions.CANCELLED, []);
  assert.ok(intakeTransitions.UPCOMING.includes('OPEN'));
  assert.ok(!intakeTransitions.UPCOMING.includes('COMPLETED'));
});

test('requirement checks compare qualification rank and GPA; a missing GPA fails a GPA minimum', () => {
  assert.deepEqual(requirementCheck({ highestQualification: 'DIPLOMA', gpa: '3.20' }, { minimumQualification: 'PRE_UNIVERSITY', minimumGpa: '3.00' }), { qualification: true, gpa: true, met: true });
  assert.equal(requirementCheck({ highestQualification: 'SECONDARY', gpa: '4.00' }, { minimumQualification: 'PRE_UNIVERSITY', minimumGpa: null }).met, false);
  assert.deepEqual(requirementCheck({ highestQualification: 'BACHELOR', gpa: null }, { minimumQualification: 'BACHELOR', minimumGpa: '3.00' }), { qualification: true, gpa: false, met: false });
  assert.equal(requirementCheck({ highestQualification: 'BACHELOR', gpa: null }, { minimumQualification: 'BACHELOR', minimumGpa: null }).gpa, null);
});

test('rates handle division by zero and round to two decimals', () => {
  assert.equal(rate(0, 0), null);
  assert.equal(rate(5, 0), null);
  assert.equal(rate(1, 3), 33.33);
  assert.equal(rate(24, 40), 60);
});

test('reference numbers follow the configured prefix and year option', () => {
  assert.equal(formatReference('ADM', true, 2026, 42), 'ADM-2026-000042');
  assert.equal(formatReference('UG', false, 2026, 1234567), 'UG-1234567');
});

test('configuration needs no upload storage and keeps secure-cookie checks', () => {
  const config = parseConfig({ DATABASE_URL: 'postgres://a:b@localhost/db', APP_ORIGIN: 'https://admissions.example.test', SESSION_PEPPER: 'x'.repeat(32) });
  assert.equal(config.COOKIE_SECURE, true);
  assert.ok(!('UPLOAD_DIR' in config));
  assert.throws(() => parseConfig({ DATABASE_URL: 'postgres://a:b@localhost/db', APP_ORIGIN: 'https://x.test', SESSION_PEPPER: 'x'.repeat(32), COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
});
