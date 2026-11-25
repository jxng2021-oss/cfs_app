import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { finaliseAttempt, makePresentation, questions, type Attempt } from './quiz-engine.js';
import type { StorageAdapter } from './storage.js';

const hour = 3_600_000;
const day = 24 * hour;
const prompts = [
  ['Which activity turns an observable requirement into a repeatable check?', 'Writing a test', 'Changing the logo'],
  ['What should a work item make clear?', 'The expected outcome', 'The developer’s favourite tool'],
  ['What prevents two submissions from taking the same last slot?', 'A transaction lock', 'A browser countdown'],
  ['Where should application secrets be kept?', 'A secret store', 'A committed configuration file'],
  ['What makes a database migration repeatable?', 'A recorded migration history', 'An undocumented manual edit'],
  ['When should an API verify a deadline?', 'At server acceptance', 'When the browser opens'],
  [
    'Which score should learners see in a controlled release workflow?',
    'The published result',
    'Every private draft',
  ],
  ['What information makes a progress percentage interpretable?', 'Its denominator', 'An unrelated icon'],
  ['What is an idempotent write?', 'A safe retry of the same operation', 'A request that can succeed only once'],
  ['Where should access checks be enforced?', 'On the server for each operation', 'Only in navigation controls'],
];
type DemoQuiz = { id: string; moduleId: string; started: Date; publishedAt: Date; maximum: string };

async function seedQuiz(
  db: Db,
  moduleId: string,
  topicId: string | null,
  title: string,
  weight: string,
  begin: number,
  end: number,
  bank: string[][],
  at: Date,
) {
  const started = new Date(begin),
    close = new Date(end);
  const {
    rows: [item],
  } = await db.query<{ id: string; max_points: string }>(
    `INSERT INTO assessments(module_id,topic_id,type,title,description,status,open_at,due_at,close_at,max_points,weight_pct,published_at,created_at,updated_at)
     VALUES ($1,$2,'QUIZ',$3,'One answer per question.',$4,$5,$6,$6,$7,$8,$9,$9,$9) RETURNING id,max_points`,
    [moduleId, topicId, title, 'PUBLISHED', started, close, bank.length, weight, at],
  );
  await db.query(
    "INSERT INTO quiz_settings VALUES ($1,'Select the best answer to each question.',5,2,false,true,'IMMEDIATE',true)",
    [item.id],
  );
  for (const [index, [prompt, correct, alternative]] of bank.entries()) {
    const {
      rows: [q],
    } = await db.query<{ id: string }>(
      'INSERT INTO quiz_questions(assessment_id,prompt,points,position) VALUES ($1,$2,1,$3) RETURNING id',
      [item.id, prompt, index + 1],
    );
    const {
      rows: [option],
    } = await db.query<{ id: string }>(
      'INSERT INTO quiz_options(question_id,label,position) VALUES ($1,$2,1),($1,$3,2) RETURNING id',
      [q.id, correct, alternative],
    );
    await db.query('UPDATE quiz_questions SET correct_option_id=$2 WHERE id=$1', [q.id, option.id]);
  }
  return { id: item.id, moduleId, started, publishedAt: at, maximum: item.max_points };
}

async function seedAttempt(db: Db, quiz: DemoQuiz, studentId: string, correctCount: number, now: Date) {
  const bank = await questions(db, quiz.id);
  const enrolment = (
    await db.query<{ enrolled_at: Date }>(
      "SELECT enrolled_at FROM enrolments WHERE module_id=$1 AND student_id=$2 AND status='ACTIVE'",
      [quiz.moduleId, studentId],
    )
  ).rows[0];
  if (!enrolment) return;
  const started = new Date(
    Math.max(quiz.started.getTime() + hour, quiz.publishedAt.getTime() + 1, enrolment.enrolled_at.getTime()),
  );
  const finished = new Date(started.getTime() + 1000);
  if (finished > now) return;
  const {
    rows: [attempt],
  } = await db.query<Attempt>(
    `INSERT INTO quiz_attempts(assessment_id,student_id,attempt_number,status,started_at,expires_at,max_points,presentation)
     VALUES ($1,$2,1,'IN_PROGRESS',$3,$4,$5,$6) RETURNING *`,
    [
      quiz.id,
      studentId,
      started,
      new Date(started.getTime() + 300_000),
      quiz.maximum,
      JSON.stringify(makePresentation(bank, false, true)),
    ],
  );
  for (const question of bank.slice(0, correctCount)) {
    await db.query('INSERT INTO quiz_answers VALUES ($1,$2,$3,1,$4)', [
      attempt.id,
      question.id,
      question.correct_option_id,
      finished,
    ]);
  }
  await finaliseAttempt(db, attempt, finished);
}

async function seedAssignment(
  db: Db,
  moduleId: string,
  title: string,
  weight: string,
  start: number,
  due: number,
  close: number | null,
  at: Date,
) {
  const {
    rows: [item],
  } = await db.query<{ id: string }>(
    `INSERT INTO assessments(module_id,type,title,description,status,open_at,due_at,close_at,max_points,weight_pct,published_at,created_at,updated_at)
     VALUES ($1,'ASSIGNMENT',$2,'Individual submission.','PUBLISHED',$3,$4,$5,100,$6,$7,$7,$7) RETURNING id`,
    [moduleId, title, new Date(start), new Date(due), close === null ? null : new Date(close), weight, at],
  );
  await db.query(
    "INSERT INTO assignment_settings VALUES ($1,'Write a brief response and upload one file.',$2,2,ARRAY['pdf','docx','txt'],10)",
    [item.id, close !== null],
  );
  return item.id;
}

export async function seedAcademicDemo(
  db: Db,
  storage: StorageAdapter,
  keys: string[],
  moduleId: string,
  studentIds: Map<string, string>,
  now: Date,
) {
  const first = (
    await db.query<{ id: string; published_at: Date }>(
      "SELECT id,published_at FROM topics WHERE module_id=$1 AND position=1 AND status='PUBLISHED' AND title='Week 1: Getting started'",
      [moduleId],
    )
  ).rows[0];
  if (!first || (await db.query('SELECT 1 FROM assessments WHERE module_id=$1 LIMIT 1', [moduleId])).rowCount) return;
  const time = now.getTime();
  const past = new Date(time - 5 * day);
  const weekTwoDate = new Date(Math.max(past.getTime(), first.published_at.getTime()));
  const quiz = await seedQuiz(
    db,
    moduleId,
    first.id,
    'Quiz 1 · Software engineering fundamentals',
    '20',
    time - 3 * day,
    time + 5 * day,
    prompts,
    weekTwoDate,
  );
  const practice = await seedQuiz(
    db,
    moduleId,
    null,
    'Practice quiz · Project checks',
    '0',
    time - 3 * day,
    time + 8 * day,
    prompts.slice(0, 4),
    past,
  );
  await seedAssignment(
    db,
    moduleId,
    'Assignment 1 · Requirements brief',
    '30',
    time - day,
    time + 3 * day,
    time + 5 * day,
    past,
  );
  await seedAssignment(
    db,
    moduleId,
    'Final assignment · Delivery plan',
    '50',
    time + 7 * day,
    time + 14 * day,
    null,
    past,
  );
  const closed = await seedAssignment(
    db,
    moduleId,
    'Practice assignment · Test plan',
    '0',
    time - 4 * day,
    time - day,
    null,
    past,
  );
  const positions = await db.query<{ next: number }>(
    'SELECT coalesce(max(position),0)+1 AS next FROM topics WHERE module_id=$1',
    [moduleId],
  );
  const next = positions.rows[0].next;
  const {
    rows: [second],
  } = await db.query<{ id: string }>(
    `INSERT INTO topics(module_id,title,description,position,created_at,updated_at)
     VALUES ($1,'Week 2: Designing the solution','Apply the earlier material to a small system design.',$2,$3,$3) RETURNING id`,
    [moduleId, next, weekTwoDate],
  );
  for (const [index, title] of ['Identify system boundaries', 'Trace a user action'].entries()) {
    await db.query(
      "INSERT INTO materials(topic_id,title,type,text_body,position,status,published_at,created_at,updated_at) VALUES ($1,$2,'TEXT',$3,$4,'PUBLISHED',$5,$5,$5)",
      [
        second.id,
        title,
        'Sketch an example from the requirements brief and explain the decision in your own words.',
        index + 1,
        weekTwoDate,
      ],
    );
  }
  await db.query("INSERT INTO release_rules(target_topic_id,type,source_topic_id) VALUES ($1,'TOPIC_COMPLETE',$2)", [
    second.id,
    first.id,
  ]);
  await db.query(
    "INSERT INTO release_rules(target_topic_id,type,source_assessment_id,threshold_pct) VALUES ($1,'QUIZ_SCORE_AT_LEAST',$2,70)",
    [second.id, quiz.id],
  );
  await db.query("UPDATE topics SET status='PUBLISHED',published_at=$2 WHERE id=$1", [second.id, weekTwoDate]);
  await db.query("INSERT INTO topics(module_id,title,position) VALUES ($1,'Week 3: Delivery and review',$2)", [
    moduleId,
    next + 1,
  ]);
  await db.query('UPDATE modules SET version=version+1 WHERE id=$1', [moduleId]);
  await db.query(
    `INSERT INTO announcements(module_id,title,body,is_pinned,status,published_at,updated_at)
     VALUES ($1,'Week 1 checklist','Complete the required readings and the software engineering quiz before moving to Week 2.',true,'PUBLISHED',$2,$2)`,
    [moduleId, past],
  );

  const studentB = studentIds.get('student-b')!;
  const studentC = studentIds.get('student-c')!;
  const enrolment = (
    await db.query<{ enrolled_at: Date }>(
      "SELECT enrolled_at FROM enrolments WHERE module_id=$1 AND student_id=$2 AND status='ACTIVE'",
      [moduleId, studentB],
    )
  ).rows[0];
  await seedAttempt(db, quiz, studentB, 4, now);
  await seedAttempt(db, practice, studentB, 1, now);
  await seedAttempt(db, quiz, studentC, 8, now);
  if (enrolment)
    await db.query(
      `INSERT INTO material_completions(student_id,material_id,completed_at)
     SELECT $1,id,$3 FROM materials WHERE topic_id=$2 AND is_required AND status='PUBLISHED' ORDER BY position LIMIT 2 ON CONFLICT DO NOTHING`,
      [
        studentB,
        first.id,
        new Date(Math.max(first.published_at.getTime(), time - hour, enrolment.enrolled_at.getTime())),
      ],
    );
  const submitted = new Date(time - 2 * day);
  if (!enrolment || enrolment.enrolled_at > submitted) return;
  const bytes = Buffer.from('Synthetic example: explain how an acceptance check detects a missed deadline.');
  const key = await storage.put(bytes, 'text/plain; charset=utf-8');
  keys.push(key);
  const {
    rows: [file],
  } = await db.query<{ id: string }>(
    `INSERT INTO files(owner_id,purpose,storage_key,original_filename,extension,detected_content_type,size_bytes,sha256,status,created_at,attached_at)
     VALUES ($1,'SUBMISSION',$2,'sample-test-plan.txt','txt','text/plain; charset=utf-8',$3,$4,'ATTACHED',$5,$5) RETURNING id`,
    [studentB, key, bytes.length, createHash('sha256').update(bytes).digest('hex'), submitted],
  );
  await db.query(
    'INSERT INTO assignment_submissions(assessment_id,student_id,file_id,version_number,submitted_at,is_late) VALUES ($1,$2,$3,1,$4,false)',
    [closed, studentB, file.id, submitted],
  );
}
