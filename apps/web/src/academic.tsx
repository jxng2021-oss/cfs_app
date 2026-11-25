import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  BookOpen,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  CheckCircle2,
  ClipboardList,
  Flag,
  GraduationCap,
  Megaphone,
  Pin,
  Plus,
  UsersRound,
} from 'lucide-react';
import { get, list, mutate, type Module, type Page, type Session } from './api.js';
import {
  type Assessment,
  type AttemptSummary,
  type Receipt,
  type ReleasedGrade,
  GradeView,
  ReceiptList,
} from './assessments.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Textarea } from './components/ui/textarea.js';
import {
  Badge,
  Empty,
  ErrorMessage,
  Heading,
  Pagination,
  Resource,
  SearchField,
  dateTime,
  field,
  submit,
  useAction,
  useConfirmation,
  useResource,
} from './ui.js';

type Draft = { points: string; feedback: string; version: number };
type Grade = { state: string; draft: Draft | null; published: ReleasedGrade | null };
type SubmissionRow = {
  studentId: string;
  displayName: string;
  current: Receipt | null;
  submissionState: string;
  grade: Grade;
};
type MarkingHistory = { submissions: Receipt[]; grade: Grade };
type PreviewRow = { studentId: string; displayName: string; expectedVersion: number; enrolmentStatus: string };
type QuizMarking = AttemptSummary & {
  questions?: {
    prompt: string;
    options: { id: string; label: string }[];
    selectedOptionId: string | null;
    correctOptionId: string;
    earnedPoints: number;
    points: number;
  }[];
};
type GradeCell = {
  id: string;
  title: string;
  type: string;
  weightPct: string;
  dueAt: string;
  resultState: string;
  contribution: string | null;
  publishedGrade: ReleasedGrade | null;
  grade?: Grade;
  locked?: boolean;
};
type GradeSummary = {
  allocatedWeight: string;
  releasedWeight: string;
  resolvedWeight: string;
  missingClosedWeight: string;
  currentReleasedAverage: string | null;
  finalModuleScore: string | null;
  assessments: GradeCell[];
};
type LearnerRow = GradeSummary & { id: string; displayName: string; workingScore: string | null };
type LecturerBook = {
  allocatedWeight: string;
  assessments: GradeCell[];
  students: LearnerRow[];
  pagination: Page<unknown>['pagination'];
};
const percent = (value: string | null | undefined) => (value == null ? '—' : value + '%');

function useModulePath() {
  const { moduleId, assessmentId, studentId } = useParams();
  const root = '/modules/' + moduleId;
  return { root, assessment: root + '/assessments/' + assessmentId, studentId };
}

function PublishGrades({
  path,
  session,
  readOnly,
  reload,
}: {
  path: string;
  session: Session;
  readOnly: boolean;
  reload: () => void;
}) {
  const confirmation = useConfirmation();
  const action = useAction();
  const [feedback, setFeedback] = useState('');
  if (readOnly) return null;
  return (
    <div className="publish-grades">
      <Button
        variant="outline"
        disabled={action.pending}
        onClick={() =>
          void action.run(async () => {
            const result = await get<{ count: number; grades: PreviewRow[] }>(path + '/grades/publication-preview');
            if (!result.count) {
              setFeedback('No unpublished results.');
              return;
            }
            const batch = result.grades.slice(0, 100);
            confirmation.ask({
              title: 'Publish ' + batch.length + ' results?',
              label: 'Publish results',
              detail:
                'These results will become visible to the students. ' +
                batch
                  .map((item) => item.displayName + (item.enrolmentStatus === 'WITHDRAWN' ? ' (withdrawn)' : ''))
                  .join(', '),
              run: () =>
                void action.run(async () => {
                  const result = await mutate<{
                    publishedCount: number;
                    failedCount: number;
                    unchangedCount: number;
                  }>(
                    path + '/grades/publish-bulk',
                    'POST',
                    { grades: batch.map(({ studentId, expectedVersion }) => ({ studentId, expectedVersion })) },
                    session.csrfToken,
                  );
                  setFeedback(
                    result.publishedCount +
                      ' published · ' +
                      result.unchangedCount +
                      ' unchanged · ' +
                      result.failedCount +
                      ' require review',
                  );
                  reload();
                }),
            });
          })
        }
      >
        Preview bulk publication
      </Button>
      {feedback && <p role="status">{feedback}</p>}
      <ErrorMessage message={action.error} />
      {confirmation.dialog}
    </div>
  );
}

function AssignmentMarker({
  path,
  person,
  session,
  item,
  readOnly,
  reload,
}: {
  path: string;
  person: string;
  session: Session;
  item: Assessment;
  readOnly: boolean;
  reload: () => void;
}) {
  const endpoint = path + '/submissions/' + person + '/history';
  const state = useResource(() => get<MarkingHistory>(endpoint), endpoint);
  const action = useAction();
  const confirmation = useConfirmation();
  const result = useResource(
    () => get<(ReleasedGrade & { revisionNumber: number })[]>(path + '/grades/' + person + '/revisions'),
    person,
  );
  const refresh = () => {
    state.reload();
    result.reload();
    reload();
  };
  return (
    <Resource state={state}>
      {(history) => (
        <>
          <Card className="panel">
            <h2>Submission versions</h2>
            <ReceiptList items={history.submissions} />
          </Card>
          <Card className="panel">
            <h2>Draft and released result</h2>
            {!readOnly && history.submissions.length > 0 && (
              <form
                className="stack"
                key={history.grade.draft?.version ?? 0}
                onSubmit={submit((form) => {
                  const save = () =>
                    void action.run(async () => {
                      await mutate(
                        path + '/grades/' + person + '/draft',
                        'PUT',
                        {
                          points: field(form, 'points'),
                          feedback: field(form, 'feedback'),
                          expectedVersion: history.grade.draft?.version ?? 0,
                        },
                        session.csrfToken,
                      );
                      refresh();
                    });
                  if (
                    !history.grade.draft &&
                    item.effectiveCloseAt &&
                    Date.parse(item.effectiveCloseAt) > Date.now()
                  ) {
                    confirmation.ask({
                      title: 'Start marking this submission?',
                      detail: 'Saving a draft stops further resubmissions for this student.',
                      label: 'Save draft',
                      run: save,
                    });
                  } else save();
                })}
              >
                <label>
                  Points out of {item.maxPoints}
                  <Input
                    name="points"
                    type="number"
                    step=".01"
                    min="0"
                    max={item.maxPoints ?? undefined}
                    required
                    defaultValue={history.grade.draft?.points}
                  />
                </label>
                <label>
                  Feedback
                  <Textarea name="feedback" maxLength={5000} defaultValue={history.grade.draft?.feedback} />
                </label>
                <div className="actions">
                  <Button variant="outline" disabled={action.pending}>
                    Save draft
                  </Button>
                  {history.grade.draft && (
                    <Button
                      type="button"
                      disabled={action.pending}
                      onClick={() =>
                        confirmation.ask({
                          title: 'Publish this result?',
                          detail: 'The student will see the points and feedback.',
                          label: 'Publish result',
                          run: () =>
                            void action.run(async () => {
                              await mutate(
                                path + '/grades/' + person + '/publish',
                                'POST',
                                { expectedVersion: history.grade.draft!.version },
                                session.csrfToken,
                              );
                              refresh();
                            }),
                        })
                      }
                    >
                      Publish result
                    </Button>
                  )}
                </div>
              </form>
            )}
            <ErrorMessage message={action.error} />
            <h3 className="subheading">Published result</h3>
            <GradeView grade={history.grade.published} />
          </Card>
          <Card className="panel">
            <h2>Revision history</h2>
            <Resource state={result}>
              {(rows) =>
                rows.length ? (
                  <ol className="receipt-list">
                    {rows.map((row) => (
                      <li key={row.revisionNumber}>
                        <strong>Revision {row.revisionNumber}</strong>
                        <GradeView grade={row} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>No published revisions.</p>
                )
              }
            </Resource>
          </Card>
          {confirmation.dialog}
        </>
      )}
    </Resource>
  );
}

function QuizMarkingDetail({ path, attempt }: { path: string; attempt: string }) {
  const endpoint = path + '/attempts/' + attempt + '/marking-detail';
  const state = useResource(() => get<QuizMarking>(endpoint), endpoint);
  return (
    <Resource state={state}>
      {(result) => (
        <Card className="panel">
          <h2>Attempt {result.attemptNumber}</h2>
          {result.questions ? (
            <>
              <p>
                {result.points} / {result.maxPoints} points
              </p>
              <ol className="receipt-list">
                {result.questions.map((question, index) => (
                  <li key={index}>
                    <div>
                      <strong>{question.prompt}</strong>
                      <p>
                        Selected:{' '}
                        {question.options.find((option) => option.id === question.selectedOptionId)?.label ??
                          'No answer'}
                      </p>
                      <p>
                        Correct: {question.options.find((option) => option.id === question.correctOptionId)?.label}
                      </p>
                    </div>
                    <Badge>{question.earnedPoints + ' / ' + question.points}</Badge>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p>Answers are available after the attempt is finalised.</p>
          )}
        </Card>
      )}
    </Resource>
  );
}

function MarkingResults({
  path,
  item,
  session,
  readOnly,
}: {
  path: string;
  item: Assessment;
  session: Session;
  readOnly: boolean;
}) {
  const [search, setSearch] = useSearchParams();
  const [page, setPage] = useState(1);
  const [roster, setRoster] = useState('ACTIVE');
  const [status, setStatus] = useState('');
  const [attempt, setAttempt] = useState('');
  const studentId = search.get('studentId') ?? '';
  const quiz = item.type === 'QUIZ';
  const query =
    path +
    (quiz ? '/attempts?' : '/submissions?') +
    new URLSearchParams({
      page: String(page),
      ...(quiz ? (studentId ? { studentId } : {}) : { enrolmentStatus: roster }),
      ...(status ? (quiz ? { status } : { submissionStatus: status }) : {}),
    });
  const state = useResource(() => list<AttemptSummary | SubmissionRow>(query), query);
  return (
    <>
      <Card className="panel">
        <h2>Release results</h2>
        {readOnly ? (
          <p>This archived module is read-only.</p>
        ) : (
          <PublishGrades path={path} session={session} readOnly={readOnly} reload={state.reload} />
        )}
      </Card>
      <div className="filters">
        {!quiz && (
          <label>
            Enrolment
            <NativeSelect
              value={roster}
              onChange={(event) => {
                setRoster(event.target.value);
                setPage(1);
              }}
            >
              <NativeSelectOption value="ACTIVE">Active students</NativeSelectOption>
              <NativeSelectOption value="WITHDRAWN">Withdrawn students</NativeSelectOption>
            </NativeSelect>
          </label>
        )}
        <label>
          Status
          <NativeSelect
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            <NativeSelectOption value="">All statuses</NativeSelectOption>
            {(quiz
              ? ['IN_PROGRESS', 'SUBMITTED', 'TIMED_OUT']
              : ['NOT_SUBMITTED', 'MISSING', 'SUBMITTED_ON_TIME', 'SUBMITTED_LATE']
            ).map((value) => (
              <NativeSelectOption key={value} value={value}>
                {value.toLowerCase().replaceAll('_', ' ')}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
        {quiz && studentId && (
          <Button
            variant="outline"
            onClick={() => {
              setSearch({});
              setPage(1);
            }}
          >
            Show all students
          </Button>
        )}
      </div>
      <Resource state={state}>
        {(result) => (
          <>
            {!result.data.length ? (
              <Empty>No records match these filters.</Empty>
            ) : (
              <div className="table-wrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Student</TableHead>
                      <TableHead scope="col">Status</TableHead>
                      <TableHead scope="col">{quiz ? 'Attempt' : 'Latest submission'}</TableHead>
                      <TableHead scope="col">Marking</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.map((row) =>
                      'attemptId' in row ? (
                        <TableRow key={row.attemptId}>
                          <TableHead scope="row">{row.displayName}</TableHead>
                          <TableCell>
                            <Badge>{row.status}</Badge>
                          </TableCell>
                          <TableCell>
                            Attempt {row.attemptNumber} · {dateTime(row.startedAt)}
                          </TableCell>
                          <TableCell>
                            <Button variant="outline" size="sm" onClick={() => setAttempt(row.attemptId)}>
                              View attempt
                            </Button>
                          </TableCell>
                        </TableRow>
                      ) : (
                        <TableRow key={row.studentId}>
                          <TableHead scope="row">{row.displayName}</TableHead>
                          <TableCell>
                            <Badge>{row.submissionState}</Badge>
                          </TableCell>
                          <TableCell>
                            {row.current
                              ? 'Version ' + row.current.versionNumber + ' · ' + dateTime(row.current.submittedAt)
                              : '—'}
                          </TableCell>
                          <TableCell>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => setSearch({ studentId: row.studentId })}
                            >
                              {row.grade.state === 'NOT_GRADED' ? 'View submission' : 'View grade'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      ),
                    )}
                  </TableBody>
                </Table>
              </div>
            )}
            <Pagination page={result} onPage={setPage} />
          </>
        )}
      </Resource>
      {attempt && quiz && <QuizMarkingDetail path={path} attempt={attempt} />}
      {studentId && !quiz && (
        <AssignmentMarker
          path={path}
          person={studentId}
          session={session}
          item={item}
          readOnly={readOnly}
          reload={state.reload}
        />
      )}
    </>
  );
}

export function Marking({ session }: { session: Session }) {
  const { root, assessment } = useModulePath();
  const state = useResource(() => Promise.all([get<Module>(root), get<Assessment>(assessment)]), assessment);
  return (
    <Resource state={state}>
      {([module, item]) => (
        <>
          <Heading
            title="Marking and results"
            detail={item.title}
            parent={{ to: assessment + '/edit', label: 'Assessment details' }}
          />
          <MarkingResults path={assessment} item={item} session={session} readOnly={module.status === 'ARCHIVED'} />
        </>
      )}
    </Resource>
  );
}

function Metrics({ items }: { items: { label: string; value: string | number; icon: typeof BookOpen }[] }) {
  return (
    <div className="metrics">
      {items.map(({ label, value, icon: Icon }) => (
        <Card key={label} className="metric">
          <span className="metric-icon">
            <Icon size={19} aria-hidden="true" />
          </span>
          <span>
            <span className="metric-label">{label}</span>
            <strong className="metric-value">{value}</strong>
          </span>
        </Card>
      ))}
    </div>
  );
}

function GradeSummaryCards({ summary }: { summary: GradeSummary }) {
  return (
    <Metrics
      items={[
        { label: 'Allocated weight', value: percent(summary.allocatedWeight), icon: ClipboardList },
        {
          label: 'Current released average · ' + summary.releasedWeight + '% coverage',
          value: percent(summary.currentReleasedAverage),
          icon: ChartNoAxesColumnIncreasing,
        },
        { label: 'Calculated module score', value: percent(summary.finalModuleScore), icon: GraduationCap },
      ]}
    />
  );
}

function GradeRows({ rows, path }: { rows: GradeCell[]; path: string }) {
  return rows.length ? (
    <div className="table-wrap">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Assessment</TableHead>
            <TableHead scope="col">Weight</TableHead>
            <TableHead scope="col">Result</TableHead>
            <TableHead scope="col">Contribution</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              <TableHead scope="row">
                <Link className="learning-title" to={path + '/assessments/' + row.id}>
                  {row.title}
                </Link>
                <small>{dateTime(row.dueAt)}</small>
              </TableHead>
              <TableCell>{percent(row.weightPct)}</TableCell>
              <TableCell>
                {row.publishedGrade ? (
                  <GradeView grade={row.publishedGrade} />
                ) : (
                  <Badge>{row.locked ? 'LOCKED' : row.resultState}</Badge>
                )}
              </TableCell>
              <TableCell>{row.contribution ?? '—'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  ) : (
    <Empty>No assessments have been published.</Empty>
  );
}

function LecturerGradebook({ path }: { path: string }) {
  const [page, setPage] = useState(1);
  const [roster, setRoster] = useState('ACTIVE');
  const [filter, setFilter] = useState('');
  const query =
    path +
    '/gradebook?' +
    new URLSearchParams({ page: String(page), enrolmentStatus: roster, ...(filter ? { filter } : {}) });
  const state = useResource(() => get<LecturerBook>(query), query);
  return (
    <>
      <div className="filters">
        <label>
          Enrolment
          <NativeSelect
            value={roster}
            onChange={(event) => {
              setRoster(event.target.value);
              setPage(1);
            }}
          >
            <NativeSelectOption value="ACTIVE">Active students</NativeSelectOption>
            <NativeSelectOption value="WITHDRAWN">Withdrawn students</NativeSelectOption>
          </NativeSelect>
        </label>
        <label>
          Result filter
          <NativeSelect
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              setPage(1);
            }}
          >
            <NativeSelectOption value="">All results</NativeSelectOption>
            <NativeSelectOption value="PENDING">Pending</NativeSelectOption>
            <NativeSelectOption value="PUBLISHED">Published</NativeSelectOption>
            <NativeSelectOption value="MISSING">Missing</NativeSelectOption>
          </NativeSelect>
        </label>
      </div>
      <Resource state={state}>
        {(book) => (
          <>
            <p>{percent(book.allocatedWeight)} of module weight allocated.</p>
            {book.students.length ? (
              <div className="table-wrap">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Student</TableHead>
                      {book.assessments.map((column) => (
                        <TableHead scope="col" key={column.id}>
                          {column.title}
                          <small>{percent(column.weightPct)}</small>
                        </TableHead>
                      ))}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {book.students.map((person) => (
                      <TableRow key={person.id}>
                        <TableHead scope="row">
                          <Link className="learning-title" to={path + '/gradebook/' + person.id}>
                            {person.displayName}
                          </Link>
                        </TableHead>
                        {person.assessments.map((cell) => (
                          <TableCell key={cell.id}>
                            <Link
                              className="learning-title"
                              to={path + '/assessments/' + cell.id + '/marking?studentId=' + person.id}
                            >
                              {cell.grade?.draft?.points ?? '—'}
                            </Link>
                            <small>
                              {cell.grade?.state === 'PUBLISHED'
                                ? 'Published'
                                : cell.publishedGrade
                                  ? 'Published ' + cell.publishedGrade.points
                                  : cell.resultState.toLowerCase().replaceAll('_', ' ')}
                            </small>
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            ) : (
              <Empty>No students match this view.</Empty>
            )}
            <Pagination page={{ data: book.students, pagination: book.pagination }} onPage={setPage} />
          </>
        )}
      </Resource>
    </>
  );
}

export function Gradebook({ session }: { session: Session }) {
  const { root, studentId } = useModulePath();
  if (session.user.role === 'STUDENT') return <StudentBook path={root} />;
  if (studentId) return <IndividualBook path={root} studentId={studentId} />;
  return (
    <>
      <Heading title="Gradebook" parent={{ to: root, label: 'Module overview' }} />
      <LecturerGradebook path={root} />
    </>
  );
}

function StudentBook({ path }: { path: string }) {
  const state = useResource(() => get<GradeSummary>(path + '/gradebook/me'), path);
  return (
    <>
      <Heading title="Gradebook" parent={{ to: path, label: 'Module overview' }} />
      <Resource state={state}>
        {(summary) => (
          <>
            <GradeSummaryCards summary={summary} />
            <p>
              {summary.resolvedWeight}% resolved · {summary.missingClosedWeight}% closed without completed work.
            </p>
            <GradeRows rows={summary.assessments} path={path} />
          </>
        )}
      </Resource>
    </>
  );
}

function IndividualBook({ path, studentId }: { path: string; studentId: string }) {
  const state = useResource(() => get<LearnerRow>(path + '/gradebook/' + studentId), studentId);
  return (
    <Resource state={state}>
      {(person) => (
        <>
          <Heading title={person.displayName} parent={{ to: path + '/gradebook', label: 'Gradebook' }} />
          <GradeSummaryCards summary={person} />
          {person.assessments.map((cell) => (
            <Card key={cell.id} className="panel">
              <h2>{cell.title}</h2>
              <p>Draft: {cell.grade?.draft?.points ?? '—'}</p>
              <GradeView grade={cell.publishedGrade} />
              <Button variant="outline" size="sm" asChild>
                <Link to={path + '/assessments/' + cell.id + '/marking?studentId=' + studentId}>Marking detail</Link>
              </Button>
            </Card>
          ))}
        </>
      )}
    </Resource>
  );
}

type AnalyticsSummary = {
  asOf: string;
  enrolledCount: number;
  submissionRatePct: string | null;
  classWorkingAveragePct: string | null;
  studentsNeedingReview: number;
  submittedAssignmentCount: number;
  dueAssignmentOpportunities: number;
  missingAssignmentCount: number;
  lateSubmissionCount: number;
  workingScoreSampleCount: number;
  quizSampleCount: number;
  quizMeanPct: string | null;
  scoreDistribution: { label: string; count: number }[];
  scoreNoData: number;
};
type Reason = {
  code: string;
  actualCount?: number;
  thresholdCount?: number;
  actualPct?: string;
  thresholdPct?: string;
  assessmentIds?: string[];
  lockedAssessmentIds?: string[];
  sampleCount?: number;
  resolvedWeight?: string;
  completedCount?: number;
  totalCount?: number;
};
type ReviewStudent = {
  studentId: string;
  displayName: string;
  needsReview: boolean;
  missingAssignmentCount: number;
  quizMeanPct: string | null;
  quizSampleCount: number;
  workingScorePct: string | null;
  resolvedWorkingWeight: string;
  overallProgress: { percent: string | null; completed: number; total: number };
  accessibleProgress: { percent: string | null; completed: number; total: number };
  reasons: Reason[];
};
function reasonText(reason: Reason) {
  if (reason.code === 'MISSING_ASSIGNMENTS')
    return reason.actualCount + ' missing assignments · threshold ' + reason.thresholdCount;
  if (reason.code === 'LOW_QUIZ_MEAN')
    return (
      percent(reason.actualPct) +
      ' quiz mean · below ' +
      percent(reason.thresholdPct) +
      ' · ' +
      reason.sampleCount +
      ' quizzes'
    );
  if (reason.code === 'LOW_WORKING_GRADE')
    return (
      percent(reason.actualPct) +
      ' working score · below ' +
      percent(reason.thresholdPct) +
      ' · ' +
      reason.resolvedWeight +
      '% engaged weight'
    );
  return (
    percent(reason.actualPct) +
    ' accessible progress · below ' +
    percent(reason.thresholdPct) +
    ' · ' +
    reason.completedCount +
    '/' +
    reason.totalCount +
    ' completed'
  );
}

export function Analytics() {
  const { root } = useModulePath();
  const path = root + '/analytics';
  const [page, setPage] = useState(1);
  const [filter, setFilter] = useState(false);
  const [search, setSearch] = useState('');
  const query =
    path +
    '/students?' +
    new URLSearchParams({ page: String(page), q: search, ...(filter ? { needsReview: 'true' } : {}) });
  const summary = useResource(() => get<AnalyticsSummary>(path + '/summary'), path);
  const students = useResource(() => list<ReviewStudent>(query), query);
  return (
    <>
      <Heading
        title="Class analytics"
        detail="Review submissions, working scores and learner progress."
        parent={{ to: root, label: 'Module overview' }}
        action={
          <Button variant="outline" asChild>
            <Link to={path + '/settings'}>Analytics settings</Link>
          </Button>
        }
      />
      <Resource state={summary}>
        {(result) => (
          <>
            <Metrics
              items={[
                { label: 'Enrolled students', value: result.enrolledCount, icon: UsersRound },
                { label: 'Due assignments submitted', value: percent(result.submissionRatePct), icon: CheckCircle2 },
                { label: 'Students needing review', value: result.studentsNeedingReview, icon: Flag },
              ]}
            />
            <div className="module-detail">
              <Card className="panel">
                <h2>Submission activity</h2>
                <p>
                  {result.submittedAssignmentCount} of {result.dueAssignmentOpportunities} due opportunities submitted
                  · {result.lateSubmissionCount} late · {result.missingAssignmentCount} missing.
                </p>
                <p>
                  Working average {percent(result.classWorkingAveragePct)} across {result.workingScoreSampleCount}{' '}
                  students. Quiz mean {percent(result.quizMeanPct)} across {result.quizSampleCount} student-quiz
                  results.
                </p>
                <small>As of {dateTime(result.asOf)}</small>
              </Card>
              <Card className="panel">
                <h2>Working score distribution</h2>
                <dl className="distribution">
                  {result.scoreDistribution.map((bucket) => (
                    <div key={bucket.label}>
                      <dt>{bucket.label}%</dt>
                      <dd>
                        <progress
                          max={result.enrolledCount || 1}
                          value={bucket.count}
                          aria-label={bucket.label + ' percent'}
                        />
                        <span>{bucket.count}</span>
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt>No score</dt>
                    <dd>{result.scoreNoData}</dd>
                  </div>
                </dl>
              </Card>
            </div>
          </>
        )}
      </Resource>
      <section className="directory" aria-label="Student analytics">
        <div className="filters">
          <SearchField
            label="Find a student"
            value={search}
            onChange={(value) => {
              setSearch(value);
              setPage(1);
            }}
          />
          <label className="checkbox">
            <input
              type="checkbox"
              checked={filter}
              onChange={(event) => {
                setFilter(event.target.checked);
                setPage(1);
              }}
            />
            Needs review only
          </label>
        </div>
        <Resource state={students}>
          {(result) => (
            <>
              {result.data.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead scope="col">Student</TableHead>
                      <TableHead scope="col">Missing</TableHead>
                      <TableHead scope="col">Quiz mean</TableHead>
                      <TableHead scope="col">Working score</TableHead>
                      <TableHead scope="col">Progress</TableHead>
                      <TableHead scope="col">Review reasons</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {result.data.map((student) => (
                      <TableRow key={student.studentId}>
                        <TableHead scope="row">
                          <Link className="learning-title" to={root + '/gradebook/' + student.studentId}>
                            {student.displayName}
                          </Link>
                        </TableHead>
                        <TableCell>{student.missingAssignmentCount}</TableCell>
                        <TableCell>
                          {percent(student.quizMeanPct)}
                          <small>{student.quizSampleCount} samples</small>
                        </TableCell>
                        <TableCell>
                          {percent(student.workingScorePct)}
                          <small>{student.resolvedWorkingWeight}% working weight</small>
                        </TableCell>
                        <TableCell>
                          {percent(student.overallProgress.percent)}
                          <small>
                            {student.overallProgress.completed} / {student.overallProgress.total} required
                          </small>
                        </TableCell>
                        <TableCell>
                          {student.reasons.length ? (
                            <ul className="reason-list">
                              {student.reasons.map((reason) => (
                                <li key={reason.code}>
                                  {reasonText(reason)}
                                  {reason.assessmentIds?.map((assessment, index) => (
                                    <Link
                                      className="back"
                                      key={assessment}
                                      to={
                                        root +
                                        '/assessments/' +
                                        assessment +
                                        '/marking?studentId=' +
                                        student.studentId
                                      }
                                    >
                                      {reason.lockedAssessmentIds?.includes(assessment)
                                        ? 'Locked assessment'
                                        : 'Source assessment'}{' '}
                                      {index + 1}
                                    </Link>
                                  ))}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <Empty>No students match this view.</Empty>
              )}
              <Pagination page={result} onPage={setPage} />
            </>
          )}
        </Resource>
      </section>
    </>
  );
}

const defaults = {
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
type Thresholds = typeof defaults & { version: number };
type RuleOption = {
  title: string;
  enabled: 'missingAssignmentsEnabled' | 'lowQuizEnabled' | 'lowGradeEnabled' | 'lowProgressEnabled';
  fields: {
    key: Exclude<
      keyof typeof defaults,
      'missingAssignmentsEnabled' | 'lowQuizEnabled' | 'lowGradeEnabled' | 'lowProgressEnabled'
    >;
    label: string;
    min: number;
    max: number;
    step: number;
  }[];
};
const ruleOptions: RuleOption[] = [
  {
    title: 'Missing assignments',
    enabled: 'missingAssignmentsEnabled',
    fields: [{ key: 'missingAssignmentsThreshold', label: 'Missing count at or above', min: 1, max: 20, step: 1 }],
  },
  {
    title: 'Low quiz mean',
    enabled: 'lowQuizEnabled',
    fields: [
      { key: 'lowQuizThresholdPct', label: 'Below percent', min: 0, max: 100, step: 0.01 },
      { key: 'lowQuizMinSamples', label: 'Minimum finalised quizzes', min: 1, max: 10, step: 1 },
    ],
  },
  {
    title: 'Low working grade',
    enabled: 'lowGradeEnabled',
    fields: [
      { key: 'lowGradeThresholdPct', label: 'Below percent', min: 0, max: 100, step: 0.01 },
      { key: 'lowGradeMinWeight', label: 'Minimum resolved weight', min: 0.01, max: 100, step: 0.01 },
    ],
  },
  {
    title: 'Incomplete learning content',
    enabled: 'lowProgressEnabled',
    fields: [
      { key: 'lowProgressThresholdPct', label: 'Below percent', min: 0, max: 100, step: 0.01 },
      { key: 'lowProgressMinMaterials', label: 'Minimum accessible materials', min: 1, max: 100, step: 1 },
    ],
  },
];
function ThresholdForm({
  input,
  session,
  path,
  reload,
  readOnly,
}: {
  input: Thresholds;
  session: Session;
  path: string;
  reload: () => void;
  readOnly: boolean;
}) {
  const [value, setValue] = useState(input);
  const action = useAction();
  const confirmation = useConfirmation();
  return (
    <Card className="panel">
      <form
        className="stack"
        onSubmit={submit(
          () =>
            void action.run(async () => {
              await mutate(path, 'PUT', value, session.csrfToken);
              reload();
            }),
        )}
      >
        {ruleOptions.map((rule) => (
          <fieldset className="picker" key={rule.enabled} disabled={readOnly}>
            <legend>{rule.title}</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={value[rule.enabled]}
                onChange={(event) => setValue((current) => ({ ...current, [rule.enabled]: event.target.checked }))}
              />
              Evaluate this rule
            </label>
            {rule.fields.map((option) => (
              <label key={option.key}>
                {option.label}
                <Input
                  type="number"
                  disabled={!value[rule.enabled]}
                  required
                  min={option.min}
                  max={option.max}
                  step={option.step}
                  value={value[option.key]}
                  onChange={(event) =>
                    setValue((current) => ({
                      ...current,
                      [option.key]: option.step === 1 ? Number(event.target.value) : event.target.value,
                    }))
                  }
                />
              </label>
            ))}
            {rule.enabled === 'lowProgressEnabled' && (
              <small>Enable this when students have had enough time to complete the accessible material.</small>
            )}
          </fieldset>
        ))}
        <ErrorMessage message={action.error} />
        {!readOnly && (
          <div className="actions">
            <Button disabled={action.pending}>Save settings</Button>
            <Button
              variant="outline"
              type="button"
              onClick={() =>
                confirmation.ask({
                  title: 'Reset to default settings?',
                  detail: 'The defaults take effect when you save.',
                  label: 'Reset form',
                  run: () => setValue({ ...defaults, version: value.version }),
                })
              }
            >
              Reset defaults
            </Button>
          </div>
        )}
      </form>
      {confirmation.dialog}
    </Card>
  );
}
export function AnalyticsSettings({ session }: { session: Session }) {
  const { root } = useModulePath();
  const path = root + '/analytics/settings';
  const state = useResource(() => Promise.all([get<Thresholds>(path), get<Module>(root)]), path);
  return (
    <>
      <Heading
        title="Analytics settings"
        detail="Thresholds flag students for lecturer review."
        parent={{ to: root + '/analytics', label: 'Class analytics' }}
      />
      <Resource state={state}>
        {([input, module]) => (
          <ThresholdForm
            input={input}
            path={path}
            session={session}
            reload={state.reload}
            readOnly={module.status === 'ARCHIVED'}
          />
        )}
      </Resource>
    </>
  );
}

type Announcement = {
  id: string;
  title: string;
  body: string;
  isPinned: boolean;
  status?: string;
  version?: number;
  publishedAt: string | null;
  updatedAt: string;
};
export function Announcements({ session }: { session: Session }) {
  const { root } = useModulePath();
  const path = root + '/announcements';
  const [selected, setSelected] = useState<Announcement | 'NEW' | null>(null);
  const action = useAction();
  const confirmation = useConfirmation();
  const state = useResource(() => Promise.all([get<Announcement[]>(path), get<Module>(root)]), path);
  return (
    <Resource state={state}>
      {([items, module]) => {
        const edit = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED';
        const current = selected === 'NEW' ? null : selected;
        return (
          <>
            <Heading
              title="Announcements"
              detail={module.name}
              parent={{ to: root, label: 'Module overview' }}
              action={
                edit && (
                  <Button onClick={() => setSelected('NEW')}>
                    <Plus aria-hidden="true" />
                    New announcement
                  </Button>
                )
              }
            />
            {selected && edit && (
              <Card className="panel">
                <h2>{current ? 'Edit announcement' : 'New announcement'}</h2>
                <form
                  className="stack"
                  key={current?.id ?? 'new'}
                  onSubmit={submit(
                    (form) =>
                      void action.run(async () => {
                        await mutate(
                          current ? path + '/' + current.id : path,
                          current ? 'PATCH' : 'POST',
                          {
                            title: field(form, 'title'),
                            body: field(form, 'body'),
                            isPinned: form.has('pinned'),
                            ...(current ? { version: current.version } : {}),
                          },
                          session.csrfToken,
                        );
                        setSelected(null);
                        state.reload();
                      }),
                  )}
                >
                  <label>
                    Title
                    <Input name="title" required maxLength={120} defaultValue={current?.title} />
                  </label>
                  <label>
                    Message
                    <Textarea name="body" required maxLength={5000} defaultValue={current?.body} />
                  </label>
                  <label className="checkbox">
                    <input type="checkbox" name="pinned" defaultChecked={current?.isPinned} />
                    Pin announcement
                  </label>
                  <div className="actions">
                    <Button disabled={action.pending}>Save announcement</Button>
                    <Button type="button" variant="outline" onClick={() => setSelected(null)}>
                      Cancel
                    </Button>
                  </div>
                </form>
              </Card>
            )}
            <ErrorMessage message={action.error} />
            {!items.length ? (
              <Empty>
                <Megaphone size={18} aria-hidden="true" />
                No announcements.
              </Empty>
            ) : (
              items.map((item) => (
                <Card key={item.id} className="panel">
                  <div className="learning-row">
                    <h2>{item.title}</h2>
                    <div className="actions">
                      {item.isPinned && <Pin size={16} aria-label="Pinned" />}
                      {item.status && <Badge>{item.status}</Badge>}
                    </div>
                  </div>
                  <p className="plain-text">{item.body}</p>
                  <small>
                    {item.publishedAt ? 'Published ' + dateTime(item.publishedAt) : 'Draft'} · Updated{' '}
                    {dateTime(item.updatedAt)}
                  </small>
                  {edit && item.status !== 'ARCHIVED' && (
                    <div className="actions topic-actions">
                      <Button variant="outline" size="sm" onClick={() => setSelected(item)}>
                        Edit
                      </Button>
                      {item.status === 'DRAFT' ? (
                        <>
                          <Button
                            size="sm"
                            onClick={() =>
                              confirmation.ask({
                                title: 'Publish this announcement?',
                                detail: 'Enrolled students will be able to read it.',
                                label: 'Publish announcement',
                                run: () =>
                                  void action.run(async () => {
                                    await mutate(
                                      path + '/' + item.id + '/publish',
                                      'POST',
                                      { version: item.version },
                                      session.csrfToken,
                                    );
                                    state.reload();
                                  }),
                              })
                            }
                          >
                            Publish
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              confirmation.ask({
                                title: 'Delete this draft announcement?',
                                detail: 'The draft will be removed.',
                                label: 'Delete draft',
                                destructive: true,
                                run: () =>
                                  void action.run(async () => {
                                    await mutate(path + '/' + item.id, 'DELETE', undefined, session.csrfToken);
                                    state.reload();
                                  }),
                              })
                            }
                          >
                            Delete
                          </Button>
                        </>
                      ) : (
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            confirmation.ask({
                              title: 'Archive this announcement?',
                              detail: 'It will be hidden from students.',
                              label: 'Archive announcement',
                              run: () =>
                                void action.run(async () => {
                                  await mutate(
                                    path + '/' + item.id + '/archive',
                                    'POST',
                                    { version: item.version },
                                    session.csrfToken,
                                  );
                                  state.reload();
                                }),
                            })
                          }
                        >
                          Archive
                        </Button>
                      )}
                    </div>
                  )}
                </Card>
              ))
            )}
            {confirmation.dialog}
          </>
        );
      }}
    </Resource>
  );
}

export function Upcoming({ path, items }: { path: string; items: Assessment[] }) {
  return (
    <Card className="panel">
      <h2>
        <CalendarDays size={17} aria-hidden="true" /> Upcoming deadlines
      </h2>
      {items.length ? (
        <ul className="receipt-list">
          {items.map((item) => (
            <li key={item.id}>
              <Link className="learning-title" to={path + '/assessments/' + item.id}>
                {item.title}
                <small>{dateTime(item.dueAt)}</small>
              </Link>
              {item.availability === 'LOCKED' && <Badge>LOCKED</Badge>}
            </li>
          ))}
        </ul>
      ) : (
        <p>No upcoming deadlines.</p>
      )}
    </Card>
  );
}
