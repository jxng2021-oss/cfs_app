import assert from 'node:assert/strict';
import test from 'node:test';
import { type Assessment } from '../../apps/api/app/assessment-model.js';
import { Ratio, scoreRatio } from '../../apps/api/app/decimal.js';
import { inspectUpload } from '../../apps/api/app/file-validation.js';
import { combineGrades, type AssessmentRecord } from '../../apps/api/app/gradebook.js';

const start = new Date('2027-01-04T00:00:00Z');
const due = new Date('2027-01-05T00:00:00Z');
const after = new Date('2027-01-06T00:00:00Z');

function assessment(
  id: string,
  weight: string,
  maximum = '100.00',
  type: Assessment['type'] = 'ASSIGNMENT',
): Assessment {
  return {
    id,
    module_id: 'demo',
    title: id,
    description: '',
    topic_id: null,
    topic_status: null,
    type,
    status: 'PUBLISHED',
    open_at: start,
    due_at: due,
    close_at: null,
    max_points: maximum,
    weight_pct: weight,
    published_at: start,
    version: 2,
    assignment_settings: null,
    quiz_settings: null,
  };
}

function record(item: Assessment, points?: string, release = true): AssessmentRecord {
  const grading =
    points === undefined
      ? null
      : {
          id: 'grade',
          assessment_id: item.id,
          student_id: 'student',
          points,
          feedback: '',
          submission_id: item.type === 'ASSIGNMENT' ? 'submission' : null,
          attempt_id: item.type === 'QUIZ' ? 'attempt' : null,
          published_revision_id: release ? 'revision' : null,
          version: 1,
        };
  return {
    student_id: 'student',
    assessment_id: item.id,
    version_number: item.type === 'ASSIGNMENT' ? 1 : null,
    is_late: false,
    finalised: item.type === 'QUIZ',
    live: false,
    draft: grading,
    published:
      grading && release
        ? {
            id: 'revision',
            grade_id: 'grade',
            revision_number: 1,
            points: grading.points,
            max_points: item.max_points,
            feedback: '',
            submission_id: grading.submission_id,
            attempt_id: grading.attempt_id,
            published_by: null,
            published_at: start,
          }
        : null,
  };
}

test('T43–T45 and T68 exact gradebook examples retain pending vs missing and exclude practice weight', () => {
  const quiz = assessment('Quiz', '20.00', '10.00', 'QUIZ');
  const first = assessment('Assignment', '30.00');
  const final = assessment('Final', '50.00');
  const practice = assessment('Practice', '0.00', '10.00', 'QUIZ');
  const items = [quiz, first, final, practice];
  const records = new Map([
    [quiz.id, record(quiz, '8.00')],
    [first.id, record(first, '85.00')],
    [final.id, record(final, '90.00', false)],
    [practice.id, record(practice, '10.00')],
  ]);
  const pending = combineGrades(items, records, after);
  assert.equal(pending.summary.currentReleasedAverage, '83.00');
  assert.equal(pending.summary.releasedWeight, '50.00');
  assert.equal(pending.summary.releasedContribution, '41.50');
  assert.equal(pending.summary.finalModuleScore, null);
  assert.equal(pending.rows[2].resultState, 'RESULT_PENDING');
  records.set(final.id, record(final, '90.00'));
  assert.equal(combineGrades(items, records, after).summary.finalModuleScore, '86.50');
  records.delete(final.id);
  assert.equal(combineGrades(items, records, start).rows[2].resultState, 'NOT_COMPLETED');
  const missing = combineGrades(items, records, after);
  assert.equal(missing.rows[2].resultState, 'MISSING_CLOSED');
  assert.equal(missing.summary.missingClosedWeight, '50.00');
  assert.equal(missing.summary.finalModuleScore, '41.50');
  assert.equal(combineGrades([practice], records, after).summary.currentReleasedAverage, null);
  assert.equal(combineGrades([quiz, first], records, after).summary.finalModuleScore, null);
});

test('T48 exact quiz threshold checks ignore rounding until display', () => {
  const threshold = Ratio.decimal('70.00');
  const near = scoreRatio('69.99', '99.99').scale(100n);
  assert.equal(near.format(), '70.00');
  assert.equal(near.below(threshold), true);
  assert.equal(scoreRatio('7.00', '10.00').scale(100n).below(threshold), false);
});

test('staged uploads recognise byte signatures, valid UTF-8 and filename rules', async () => {
  const text = Buffer.from('Synthetic teaching material — references');
  const accepted = await inspectUpload('lecture notes.txt', text);
  assert.equal(accepted.contentType, 'text/plain; charset=utf-8');
  await assert.rejects(inspectUpload('notes.js.txt', text), { code: 'UNSUPPORTED_FILE_TYPE' });
  await assert.rejects(inspectUpload('notes.pdf', text), { code: 'UNSUPPORTED_FILE_TYPE' });
  await assert.rejects(inspectUpload('notes.txt', Buffer.from([0xa0, 0x04])), { code: 'UNSUPPORTED_FILE_TYPE' });
  const zip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  assert.equal((await inspectUpload('example.zip', zip)).extension, 'zip');
  await assert.rejects(inspectUpload('example.docx', zip), { code: 'UNSUPPORTED_FILE_TYPE' });
});
