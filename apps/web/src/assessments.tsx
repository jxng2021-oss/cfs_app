import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, ArrowRight, ClipboardList, Download, FileUp, LockKeyhole, Plus, Timer } from 'lucide-react';
import { ApiError, get, list, mutate, stageFile, type FileMetadata, type Module, type Session } from './api.js';
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
  dateTime,
  field,
  submit,
  useAction,
  useConfirmation,
  useResource,
} from './ui.js';

type AssignmentSettings = {
  instructions: string;
  allowLateSubmission: boolean;
  maxSubmissions: number;
  allowedExtensions: string[];
  maxFileMiB: number;
};
type QuizSettings = {
  instructions: string;
  timeLimitMinutes: number | null;
  maxAttempts: number;
  shuffleQuestions: boolean;
  shuffleOptions: boolean;
  resultRelease: 'IMMEDIATE' | 'MANUAL';
  showAnswerReview: boolean;
};
export type ReleasedGrade = {
  points: string;
  maxPoints: string;
  percent: string;
  feedback: string;
  publishedAt: string;
  contribution?: string;
};
export type Assessment = {
  id: string;
  title: string;
  type: 'ASSIGNMENT' | 'QUIZ';
  status: 'DRAFT' | 'PUBLISHED';
  description?: string;
  topicId?: string | null;
  version?: number;
  availability?: string;
  openAt?: string;
  dueAt: string;
  closeAt?: string | null;
  effectiveCloseAt?: string;
  weightPct: string;
  maxPoints?: string | null;
  assignmentSettings?: AssignmentSettings | null;
  quizSettings?: QuizSettings | null;
  publishedGrade?: ReleasedGrade | null;
  submissionState?: string;
  canSubmit?: boolean;
  remainingSubmissions?: number;
  cannotSubmitReason?: string;
  currentAttemptId?: string | null;
  attemptsRemaining?: number;
  canStart?: boolean;
};
export type Receipt = {
  submissionId: string;
  versionNumber: number;
  submittedAt: string;
  isLate: boolean;
  file: FileMetadata;
  remainingSubmissions: number;
};
type History = { submissions: Receipt[]; current: Receipt | null };
type Choice = { id?: string; label: string };
type EditorQuestion = {
  id?: string;
  prompt: string;
  points: number;
  explanation: string;
  options: Choice[];
  correctOptionIndex: number | null;
};
type QuizBank = { assessmentVersion: number; maxPoints: string | null; questions: EditorQuestion[] };
type Topic = { id: string; title: string; status: string };
type Budget = { allocatedWeight: string; remainingWeight: string };
export type AttemptSummary = {
  attemptId: string;
  attemptNumber: number;
  status: string;
  serverNow: string;
  startedAt: string;
  expiresAt: string;
  finishedAt: string | null;
  questionCount: number;
  points?: string | null;
  maxPoints?: string | null;
  studentId?: string;
  displayName?: string;
};
type Question = {
  id: string;
  prompt: string;
  points: number;
  options: { id: string; label: string }[];
  selectedOptionId: string | null;
  revision: number;
  correctOptionId?: string;
  explanation?: string;
  earnedPoints?: number;
};
type Attempt = AttemptSummary & {
  questions: Question[];
  answeredCount: number;
  publishedBest?: ReleasedGrade | null;
};

const permitted = ['pdf', 'docx', 'pptx', 'xlsx', 'txt', 'md', 'png', 'jpg', 'jpeg', 'zip'];
const localDate = (value: string | number) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Singapore',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(new Date(value))
    .replace(' ', 'T');
const instant = (form: FormData, name: string) => new Date(field(form, name) + '+08:00').toISOString();

function useAssessmentRoute() {
  const { moduleId, assessmentId, attemptId } = useParams();
  const modulePath = '/modules/' + moduleId;
  const listPath = modulePath + '/assessments';
  const detailPath = listPath + '/' + assessmentId;
  return { modulePath, listPath, detailPath, attemptId };
}

export function AssessmentList({ session }: { session: Session }) {
  const { modulePath, listPath } = useAssessmentRoute();
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const query = listPath + '?' + new URLSearchParams({ page: String(page), ...(type ? { type } : {}) });
  const state = useResource(() => Promise.all([get<Module>(modulePath), list<Assessment>(query)]), query);
  const lecturer = session.user.role === 'LECTURER';
  return (
    <Resource state={state}>
      {([module, result]) => (
        <>
          <Heading
            title="Assessments"
            detail={module.name}
            parent={{ to: modulePath, label: 'Module overview' }}
            action={
              lecturer &&
              module.status !== 'ARCHIVED' && (
                <Button asChild>
                  <Link to={listPath + '/new'}>
                    <Plus aria-hidden="true" />
                    New assessment
                  </Link>
                </Button>
              )
            }
          />
          <section className="directory" aria-label="Assessments">
            <div className="filters">
              <label>
                Type
                <NativeSelect
                  value={type}
                  onChange={(event) => {
                    setType(event.target.value);
                    setPage(1);
                  }}
                >
                  <NativeSelectOption value="">All assessments</NativeSelectOption>
                  <NativeSelectOption value="ASSIGNMENT">Assignment</NativeSelectOption>
                  <NativeSelectOption value="QUIZ">Quiz</NativeSelectOption>
                </NativeSelect>
              </label>
            </div>
            {!result.data.length ? (
              <Empty>No assessments in this view.</Empty>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Assessment</TableHead>
                    <TableHead scope="col">Due</TableHead>
                    <TableHead scope="col">Weight</TableHead>
                    <TableHead scope="col">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.data.map((item) => (
                    <TableRow key={item.id}>
                      <TableHead scope="row">
                        <Link className="learning-title" to={listPath + '/' + item.id + (lecturer ? '/edit' : '')}>
                          {item.title}
                        </Link>
                        <small>{item.type === 'QUIZ' ? 'Quiz' : 'Assignment'}</small>
                      </TableHead>
                      <TableCell>{dateTime(item.dueAt)}</TableCell>
                      <TableCell>{item.weightPct}%</TableCell>
                      <TableCell>
                        <Badge>{item.availability ?? item.status}</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
            <Pagination page={result} onPage={setPage} />
          </section>
        </>
      )}
    </Resource>
  );
}

function AssessmentForm({
  item,
  topics,
  onSave,
  pending,
}: {
  item?: Assessment;
  topics: Topic[];
  onSave: (input: unknown) => void;
  pending: boolean;
}) {
  const [type, setType] = useState<Assessment['type']>(item?.type ?? 'ASSIGNMENT');
  const [late, setLate] = useState(item?.assignmentSettings?.allowLateSubmission ?? false);
  const [untimed, setUntimed] = useState(item?.quizSettings?.timeLimitMinutes === null);
  const fixed = item?.status === 'PUBLISHED';
  const assignment = item?.assignmentSettings;
  const quiz = item?.quizSettings;
  return (
    <form
      className="stack"
      onSubmit={submit((form) => {
        const heading = { title: field(form, 'title'), description: field(form, 'description') };
        const version = item ? { version: item.version } : { type };
        if (fixed) {
          onSave({ ...heading, ...version });
          return;
        }
        const shared = {
          ...heading,
          ...version,
          topicId: field(form, 'topicId') || null,
          openAt: instant(form, 'openAt'),
          dueAt: instant(form, 'dueAt'),
          weightPct: field(form, 'weightPct'),
        };
        if (type === 'ASSIGNMENT') {
          onSave({
            ...shared,
            closeAt: late ? instant(form, 'closeAt') : null,
            maxPoints: field(form, 'maxPoints'),
            assignmentSettings: {
              instructions: field(form, 'instructions'),
              allowLateSubmission: late,
              maxSubmissions: Number(field(form, 'maxSubmissions')),
              allowedExtensions: form.getAll('extensions'),
              maxFileMiB: Number(field(form, 'maxFileMiB')),
            },
          });
        } else {
          onSave({
            ...shared,
            quizSettings: {
              instructions: field(form, 'instructions'),
              timeLimitMinutes: untimed ? null : Number(field(form, 'timeLimitMinutes')),
              maxAttempts: Number(field(form, 'maxAttempts')),
              shuffleQuestions: form.has('shuffleQuestions'),
              shuffleOptions: form.has('shuffleOptions'),
              resultRelease: field(form, 'resultRelease'),
              showAnswerReview: form.has('showAnswerReview'),
            },
          });
        }
      })}
    >
      {!item && (
        <label>
          Assessment type
          <NativeSelect value={type} onChange={(event) => setType(event.target.value as Assessment['type'])}>
            <NativeSelectOption value="ASSIGNMENT">Assignment</NativeSelectOption>
            <NativeSelectOption value="QUIZ">Quiz</NativeSelectOption>
          </NativeSelect>
        </label>
      )}
      <label>
        Assessment title
        <Input required name="title" maxLength={120} defaultValue={item?.title} />
      </label>
      <label>
        Description
        <Textarea name="description" maxLength={10000} defaultValue={item?.description} />
      </label>
      {!fixed && (
        <>
          <label>
            Linked topic
            <NativeSelect name="topicId" defaultValue={item?.topicId ?? ''}>
              <NativeSelectOption value="">No linked topic</NativeSelectOption>
              {topics.map((topic) => (
                <NativeSelectOption key={topic.id} value={topic.id}>
                  {topic.title} · {topic.status === 'DRAFT' ? 'Draft' : 'Published'}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </label>
          <fieldset className="picker">
            <legend>Availability in Singapore time (SGT)</legend>
            <div className="form-row">
              <label>
                Opens
                <Input
                  name="openAt"
                  type="datetime-local"
                  required
                  defaultValue={localDate(item?.openAt ?? Date.now() - 3_600_000)}
                />
              </label>
              <label>
                Due
                <Input
                  name="dueAt"
                  type="datetime-local"
                  required
                  defaultValue={localDate(item?.dueAt ?? Date.now() + 604_800_000)}
                />
              </label>
            </div>
            {type === 'ASSIGNMENT' && (
              <>
                <label className="checkbox">
                  <input type="checkbox" checked={late} onChange={(event) => setLate(event.target.checked)} />
                  Allow late submissions
                </label>
                {late && (
                  <label>
                    Closes
                    <Input
                      name="closeAt"
                      type="datetime-local"
                      required
                      defaultValue={localDate(item?.closeAt ?? Date.now() + 691_200_000)}
                    />
                  </label>
                )}
              </>
            )}
          </fieldset>
          <div className="form-row">
            <label>
              Weight percent (0 for practice)
              <Input
                name="weightPct"
                type="number"
                min="0"
                max="100"
                step=".01"
                required
                defaultValue={item?.weightPct ?? '0'}
              />
            </label>
            {type === 'ASSIGNMENT' && (
              <label>
                Maximum points
                <Input
                  name="maxPoints"
                  type="number"
                  min=".01"
                  max="1000"
                  step=".01"
                  required
                  defaultValue={item?.maxPoints ?? '100'}
                />
              </label>
            )}
          </div>
          <label>
            Instructions
            <Textarea
              key={type}
              name="instructions"
              maxLength={20000}
              required={type === 'ASSIGNMENT'}
              defaultValue={type === 'ASSIGNMENT' ? assignment?.instructions : quiz?.instructions}
            />
          </label>
          {type === 'ASSIGNMENT' ? (
            <>
              <div className="form-row">
                <label>
                  Maximum submissions
                  <Input
                    name="maxSubmissions"
                    type="number"
                    min="1"
                    max="5"
                    required
                    defaultValue={assignment?.maxSubmissions ?? 1}
                  />
                </label>
                <label>
                  File size limit (MiB)
                  <Input
                    name="maxFileMiB"
                    type="number"
                    min="1"
                    max="20"
                    required
                    defaultValue={assignment?.maxFileMiB ?? 10}
                  />
                </label>
              </div>
              <fieldset className="picker">
                <legend>Allowed file types</legend>
                <div className="file-types">
                  {permitted.map((ext) => (
                    <label className="checkbox" key={ext}>
                      <input
                        type="checkbox"
                        name="extensions"
                        value={ext}
                        defaultChecked={(assignment?.allowedExtensions ?? ['pdf', 'docx', 'zip']).includes(ext)}
                      />
                      {ext.toUpperCase()}
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          ) : (
            <>
              <div className="form-row">
                <label>
                  Maximum attempts
                  <Input
                    name="maxAttempts"
                    type="number"
                    min="1"
                    max="5"
                    required
                    defaultValue={quiz?.maxAttempts ?? 1}
                  />
                </label>
                <label>
                  Time limit (minutes)
                  <Input
                    name="timeLimitMinutes"
                    type="number"
                    min="1"
                    max="180"
                    disabled={untimed}
                    required={!untimed}
                    defaultValue={quiz?.timeLimitMinutes ?? 20}
                  />
                </label>
              </div>
              <label className="checkbox">
                <input type="checkbox" checked={untimed} onChange={(event) => setUntimed(event.target.checked)} />
                Untimed within the quiz window
              </label>
              <label>
                Result release
                <NativeSelect name="resultRelease" defaultValue={quiz?.resultRelease ?? 'IMMEDIATE'}>
                  <NativeSelectOption value="IMMEDIATE">Immediate</NativeSelectOption>
                  <NativeSelectOption value="MANUAL">Release manually</NativeSelectOption>
                </NativeSelect>
              </label>
              <label className="checkbox">
                <input type="checkbox" name="shuffleQuestions" defaultChecked={quiz?.shuffleQuestions} />
                Shuffle questions
              </label>
              <label className="checkbox">
                <input type="checkbox" name="shuffleOptions" defaultChecked={quiz?.shuffleOptions} />
                Shuffle options
              </label>
              <label className="checkbox">
                <input type="checkbox" name="showAnswerReview" defaultChecked={quiz?.showAnswerReview} />
                Allow answer review after close
              </label>
            </>
          )}
        </>
      )}
      <div>
        <Button disabled={pending}>{item ? 'Save assessment' : 'Create draft'}</Button>
      </div>
    </form>
  );
}

const newQuestion = (): EditorQuestion => ({
  prompt: '',
  points: 1,
  explanation: '',
  options: [{ label: '' }, { label: '' }],
  correctOptionIndex: null,
});
function QuestionEditor({ path, session, changed }: { path: string; session: Session; changed: () => void }) {
  const state = useResource(() => get<QuizBank>(path + '/questions'), path);
  return (
    <Resource state={state}>
      {(bank) => (
        <QuestionForm
          bank={bank}
          path={path}
          session={session}
          changed={() => {
            state.reload();
            changed();
          }}
        />
      )}
    </Resource>
  );
}
function QuestionForm({
  bank,
  path,
  session,
  changed,
}: {
  bank: QuizBank;
  path: string;
  session: Session;
  changed: () => void;
}) {
  const [items, setItems] = useState(bank.questions);
  const action = useAction();
  const [preview, setPreview] = useState(false);
  const update = (index: number, question: EditorQuestion) =>
    setItems((all) => all.map((old, i) => (i === index ? question : old)));
  function move(index: number, direction: number) {
    setItems((all) => {
      const copy = [...all];
      [copy[index], copy[index + direction]] = [copy[index + direction], copy[index]];
      return copy;
    });
  }
  return (
    <Card className="panel">
      <div className="page-heading">
        <div>
          <h2>Quiz questions</h2>
          <p>{items.reduce((sum, q) => sum + q.points, 0)} points total</p>
        </div>
        <Button type="button" variant="outline" onClick={() => setPreview((value) => !value)}>
          {preview ? 'Back to editor' : 'Student preview'}
        </Button>
      </div>
      <form
        className="stack"
        onSubmit={submit(
          () =>
            void action.run(async () => {
              const questions = items.map((q) => ({
                id: q.id,
                prompt: q.prompt,
                points: q.points,
                explanation: q.explanation,
                options: q.options,
                correctOptionIndex: q.correctOptionIndex,
              }));
              await mutate(
                path + '/questions',
                'PUT',
                { assessmentVersion: bank.assessmentVersion, questions },
                session.csrfToken,
              );
              changed();
            }),
        )}
      >
        {items.map((q, index) => (
          <fieldset className="picker" key={q.id ?? index}>
            <legend>Question {index + 1}</legend>
            {preview ? (
              <>
                <p>{q.prompt}</p>
                <ol>
                  {q.options.map((option, n) => (
                    <li key={n}>{option.label}</li>
                  ))}
                </ol>
              </>
            ) : (
              <>
                <label>
                  Prompt
                  <Textarea
                    required
                    value={q.prompt}
                    maxLength={2000}
                    onChange={(event) => update(index, { ...q, prompt: event.target.value })}
                  />
                </label>
                <label>
                  Points
                  <Input
                    type="number"
                    min="1"
                    max="20"
                    required
                    value={q.points}
                    onChange={(event) => update(index, { ...q, points: Number(event.target.value) })}
                  />
                </label>
                {q.options.map((option, n) => (
                  <div className="quiz-editor-option" key={option.id ?? n}>
                    <label className="checkbox">
                      <input
                        type="radio"
                        name={'correct-' + index}
                        checked={q.correctOptionIndex === n}
                        onChange={() => update(index, { ...q, correctOptionIndex: n })}
                      />
                      Correct
                    </label>
                    <label className="quiz-option-input">
                      Option {n + 1}
                      <Input
                        required
                        value={option.label}
                        maxLength={500}
                        onChange={(event) =>
                          update(index, {
                            ...q,
                            options: q.options.map((value, i) =>
                              i === n ? { ...value, label: event.target.value } : value,
                            ),
                          })
                        }
                      />
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={n === 0}
                      onClick={() => {
                        const options = [...q.options];
                        [options[n - 1], options[n]] = [options[n], options[n - 1]];
                        const correct =
                          q.correctOptionIndex === n
                            ? n - 1
                            : q.correctOptionIndex === n - 1
                              ? n
                              : q.correctOptionIndex;
                        update(index, { ...q, options, correctOptionIndex: correct });
                      }}
                    >
                      Move up
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        update(index, {
                          ...q,
                          options: q.options.filter((_, i) => i !== n),
                          correctOptionIndex:
                            q.correctOptionIndex === n
                              ? null
                              : q.correctOptionIndex !== null && q.correctOptionIndex > n
                                ? q.correctOptionIndex - 1
                                : q.correctOptionIndex,
                        })
                      }
                    >
                      Remove option
                    </Button>
                  </div>
                ))}
                <label>
                  Explanation (optional)
                  <Textarea
                    value={q.explanation}
                    maxLength={2000}
                    onChange={(event) => update(index, { ...q, explanation: event.target.value })}
                  />
                </label>
                <div className="actions">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={q.options.length >= 6}
                    onClick={() => update(index, { ...q, options: [...q.options, { label: '' }] })}
                  >
                    Add option
                  </Button>
                  <Button type="button" variant="outline" size="sm" disabled={!index} onClick={() => move(index, -1)}>
                    Move question up
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    Move question down
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setItems((all) => all.filter((_, i) => i !== index))}
                  >
                    Remove question
                  </Button>
                </div>
              </>
            )}
          </fieldset>
        ))}
        <ErrorMessage message={action.error} />
        {!preview && (
          <div className="actions">
            <Button
              type="button"
              variant="outline"
              disabled={items.length >= 50}
              onClick={() => setItems((all) => [...all, newQuestion()])}
            >
              <Plus aria-hidden="true" />
              Add question
            </Button>
            <Button disabled={action.pending}>Save questions</Button>
          </div>
        )}
      </form>
    </Card>
  );
}

export function AssessmentEdit({ session, fresh = false }: { session: Session; fresh?: boolean }) {
  const { modulePath, listPath, detailPath } = useAssessmentRoute();
  const navigate = useNavigate();
  const action = useAction();
  const confirmation = useConfirmation();
  const key = fresh ? listPath : detailPath;
  const state = useResource(
    () =>
      Promise.all([
        get<Module>(modulePath),
        get<Topic[]>(modulePath + '/topics'),
        get<Budget>(modulePath + '/weight-budget'),
        fresh ? Promise.resolve(undefined) : get<Assessment>(detailPath),
      ]),
    key,
  );
  return (
    <Resource state={state}>
      {([module, topics, budget, item]) => (
        <>
          <Heading
            title={fresh ? 'New assessment' : item!.title}
            detail={module.name}
            parent={{ to: listPath, label: 'Assessments' }}
            action={item && <Badge>{item.status}</Badge>}
          />
          <ErrorMessage message={action.error} />
          <Card className="panel">
            <h2>Weight budget</h2>
            <p>
              {budget.allocatedWeight}% of 100% allocated · {budget.remainingWeight}% available
              {item?.status === 'DRAFT' ? ' · ' + item.weightPct + '% proposed' : ''}
            </p>
            {module.status === 'ARCHIVED' ? (
              <p>This archived module is read-only.</p>
            ) : (
              <AssessmentForm
                item={item}
                topics={topics}
                pending={action.pending}
                onSave={(input) =>
                  void action.run(async () => {
                    const saved = await mutate<Assessment>(
                      fresh ? listPath : detailPath,
                      fresh ? 'POST' : 'PATCH',
                      input,
                      session.csrfToken,
                    );
                    if (fresh) navigate(listPath + '/' + saved.id + '/edit');
                    else state.reload();
                  })
                }
              />
            )}
          </Card>
          {item?.type === 'QUIZ' && item.status === 'DRAFT' && module.status !== 'ARCHIVED' && (
            <QuestionEditor path={detailPath} session={session} changed={state.reload} />
          )}
          {item && (
            <div className="actions">
              {item.status === 'PUBLISHED' ? (
                <Button asChild variant="outline">
                  <Link to={detailPath + '/marking'}>
                    <ClipboardList aria-hidden="true" />
                    Marking and results
                  </Link>
                </Button>
              ) : (
                module.status !== 'ARCHIVED' && (
                  <>
                    <Button
                      disabled={action.pending}
                      onClick={() =>
                        confirmation.ask({
                          title: 'Publish ' + item.title + '?',
                          detail:
                            'The assessment settings, placement, dates, weights and quiz answers become fixed. Students can access it according to its release settings.',
                          label: 'Publish assessment',
                          run: () =>
                            void action.run(async () => {
                              await mutate(
                                detailPath + '/publish',
                                'POST',
                                { version: item.version },
                                session.csrfToken,
                              );
                              state.reload();
                            }),
                        })
                      }
                    >
                      Publish assessment
                    </Button>
                    <Button
                      variant="outline"
                      disabled={action.pending}
                      onClick={() =>
                        confirmation.ask({
                          title: 'Delete this draft assessment?',
                          detail: 'Its draft settings and questions will be removed.',
                          label: 'Delete draft',
                          destructive: true,
                          run: () =>
                            void action.run(async () => {
                              await mutate(detailPath, 'DELETE', undefined, session.csrfToken);
                              navigate(listPath);
                            }),
                        })
                      }
                    >
                      Delete draft
                    </Button>
                  </>
                )
              )}
            </div>
          )}
          {confirmation.dialog}
        </>
      )}
    </Resource>
  );
}

export function GradeView({ grade }: { grade?: ReleasedGrade | null }) {
  return grade ? (
    <div className="released-grade">
      <strong>
        {grade.points} / {grade.maxPoints} · {grade.percent}%
      </strong>
      {grade.feedback && <p className="plain-text">{grade.feedback}</p>}
      <small>Released {dateTime(grade.publishedAt)}</small>
    </div>
  ) : (
    <p>Result pending.</p>
  );
}

export function ReceiptList({ items }: { items: Receipt[] }) {
  return items.length ? (
    <ul className="receipt-list">
      {items.map((item) => (
        <li key={item.submissionId}>
          <div>
            <strong>Version {item.versionNumber}</strong>
            <small>
              {dateTime(item.submittedAt)} · {item.isLate ? 'Late' : 'On time'}
            </small>
          </div>
          <Button asChild variant="outline" size="sm">
            <a href={item.file.downloadUrl}>
              <Download aria-hidden="true" />
              {item.file.originalFilename}
            </a>
          </Button>
        </li>
      ))}
    </ul>
  ) : (
    <p>No submissions yet.</p>
  );
}

function AssignmentLearner({
  item,
  path,
  session,
  reload,
}: {
  item: Assessment;
  path: string;
  session: Session;
  reload: () => void;
}) {
  const state = useResource(() => get<History>(path + '/submissions/me'), path);
  const [staged, setStaged] = useState<{ file: FileMetadata; key: string } | null>(null);
  const action = useAction();
  const confirmation = useConfirmation();
  return (
    <>
      <Card className="panel">
        <h2>Submission</h2>
        <p>
          {item.remainingSubmissions} remaining · {item.assignmentSettings!.maxFileMiB} MiB maximum ·{' '}
          {item.assignmentSettings!.allowedExtensions.map((ext) => ext.toUpperCase()).join(', ')}
        </p>
        {item.canSubmit ? (
          <>
            <form
              className="stack"
              onSubmit={submit(
                (form) =>
                  void action.run(async () => {
                    const file = form.get('file');
                    if (!(file instanceof File) || !file.size) throw new Error('Choose a file to upload.');
                    if (staged)
                      await mutate('/files/staged/' + staged.file.id, 'DELETE', undefined, session.csrfToken);
                    setStaged({
                      file: await stageFile(file, 'SUBMISSION', session.csrfToken),
                      key: crypto.randomUUID(),
                    });
                  }),
              )}
            >
              <label>
                Assignment file
                <Input
                  name="file"
                  type="file"
                  required
                  accept={item.assignmentSettings!.allowedExtensions.map((ext) => '.' + ext).join(',')}
                />
              </label>
              <div>
                <Button variant="outline" disabled={action.pending}>
                  <FileUp aria-hidden="true" />
                  Stage file
                </Button>
              </div>
            </form>
            {staged && (
              <div className="actions staged-receipt">
                <strong>{staged.file.originalFilename}</strong>
                <Button
                  disabled={action.pending}
                  onClick={() =>
                    confirmation.ask({
                      title: 'Submit this file?',
                      detail: 'The latest accepted version is the one your lecturer will mark.',
                      label: 'Submit assignment',
                      run: () =>
                        void action.run(async () => {
                          await mutate<Receipt>(
                            path + '/submissions',
                            'POST',
                            { fileId: staged.file.id },
                            session.csrfToken,
                            { 'Idempotency-Key': staged.key },
                          );
                          setStaged(null);
                          state.reload();
                          reload();
                        }),
                    })
                  }
                >
                  Submit assignment
                </Button>
              </div>
            )}
          </>
        ) : (
          <p>
            {item.cannotSubmitReason === 'GRADING_STARTED'
              ? 'Your lecturer has started marking.'
              : item.cannotSubmitReason === 'SUBMISSION_LIMIT_REACHED'
                ? 'You have used all available submissions.'
                : 'Submissions are unavailable.'}
          </p>
        )}
        <ErrorMessage message={action.error} />
      </Card>
      <Card className="panel">
        <h2>Submission history</h2>
        <Resource state={state}>{(value) => <ReceiptList items={value.submissions} />}</Resource>
      </Card>
      {confirmation.dialog}
    </>
  );
}
type HistoryAttempts = {
  attempts: AttemptSummary[];
  currentAttemptId: string | null;
  publishedBest: ReleasedGrade | null;
  reviewAttemptId: string | null;
};
function QuizLearner({ item, path, session }: { item: Assessment; path: string; session: Session }) {
  const state = useResource(() => get<HistoryAttempts>(path + '/attempts/me'), path);
  const confirmation = useConfirmation();
  const action = useAction();
  const navigate = useNavigate();
  const config = item.quizSettings!;
  return (
    <Card className="panel">
      <h2>Quiz attempts</h2>
      <p>
        {item.attemptsRemaining} of {config.maxAttempts} attempts remaining.{' '}
        {config.timeLimitMinutes
          ? config.timeLimitMinutes + ' minutes maximum per attempt.'
          : 'Untimed within the quiz window.'}
      </p>
      {item.canStart &&
        (item.currentAttemptId ? (
          <Button asChild>
            <Link to={path + '/attempt/' + item.currentAttemptId}>Resume quiz</Link>
          </Button>
        ) : (
          <Button
            disabled={action.pending}
            onClick={() =>
              confirmation.ask({
                title: 'Start this quiz?',
                detail:
                  'The timer starts when you confirm. Your attempt ends at the timer or the closing time, whichever comes first.',
                label: 'Start quiz',
                run: () =>
                  void action.run(async () => {
                    const attempt = await mutate<Attempt>(path + '/attempts', 'POST', {}, session.csrfToken);
                    navigate(path + '/attempt/' + attempt.attemptId);
                  }),
              })
            }
          >
            Start quiz
          </Button>
        ))}
      <ErrorMessage message={action.error} />
      <Resource state={state}>
        {(value) =>
          value.attempts.length ? (
            <ul className="receipt-list">
              {value.attempts.map((attempt) => (
                <li key={attempt.attemptId}>
                  <Link className="learning-title" to={path + '/attempt/' + attempt.attemptId}>
                    Attempt {attempt.attemptNumber}
                  </Link>
                  <Badge>{attempt.status}</Badge>
                  {attempt.attemptId === value.reviewAttemptId && (
                    <Link className="back" to={path + '/review/' + attempt.attemptId}>
                      Review answers
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p>No attempts yet.</p>
          )
        }
      </Resource>
      {confirmation.dialog}
    </Card>
  );
}

export function AssessmentDetail({ session }: { session: Session }) {
  const { listPath, detailPath } = useAssessmentRoute();
  const state = useResource(() => get<Assessment>(detailPath), detailPath);
  return (
    <Resource state={state}>
      {(item) => (
        <>
          <Heading
            title={item.title}
            detail={(item.type === 'QUIZ' ? 'Quiz' : 'Assignment') + ' · ' + item.weightPct + '% of module grade'}
            parent={{ to: listPath, label: 'Assessments' }}
            action={<Badge>{item.availability ?? item.status}</Badge>}
          />
          {item.availability === 'LOCKED' ? (
            <Empty>
              <LockKeyhole size={18} aria-hidden="true" />
              Complete the linked topic requirements to open this assessment.
            </Empty>
          ) : (
            <>
              <Card className="panel">
                <h2>Instructions</h2>
                <p className="plain-text">
                  {item.assignmentSettings?.instructions ?? item.quizSettings?.instructions ?? item.description}
                </p>
                <dl className="timing">
                  <dt>Opens</dt>
                  <dd>{dateTime(item.openAt!)}</dd>
                  <dt>Due</dt>
                  <dd>{dateTime(item.dueAt)}</dd>
                  <dt>Closes</dt>
                  <dd>{dateTime(item.effectiveCloseAt!)}</dd>
                </dl>
              </Card>
              {item.type === 'ASSIGNMENT' ? (
                <AssignmentLearner item={item} path={detailPath} session={session} reload={state.reload} />
              ) : (
                <QuizLearner item={item} path={detailPath} session={session} />
              )}
              <Card className="panel">
                <h2>Published result</h2>
                <GradeView grade={item.publishedGrade} />
              </Card>
            </>
          )}
        </>
      )}
    </Resource>
  );
}

export function QuizAttempt({ session, review = false }: { session: Session; review?: boolean }) {
  const { detailPath, attemptId } = useAssessmentRoute();
  const route = detailPath + '/attempts/' + attemptId + (review ? '/review' : '');
  const state = useResource(() => get<Attempt>(route), route);
  return (
    <Resource state={state}>
      {(attempt) => (
        <AttemptContent
          key={attempt.attemptId + attempt.status + review}
          data={attempt}
          detailPath={detailPath}
          apiPath={route}
          session={session}
          reload={state.reload}
          review={review}
        />
      )}
    </Resource>
  );
}

function AttemptContent({
  data,
  detailPath,
  apiPath,
  session,
  reload,
  review,
}: {
  data: Attempt;
  detailPath: string;
  apiPath: string;
  session: Session;
  reload: () => void;
  review: boolean;
}) {
  const [questions, setQuestions] = useState(data.questions);
  const [index, setIndex] = useState(0);
  const [offset] = useState(() => Date.parse(data.serverNow) - Date.now());
  const [now, setNow] = useState(Date.now);
  const action = useAction();
  const confirmation = useConfirmation();
  const [unsaved, setUnsaved] = useState<{ questionId: string; selectedOptionId: string | null } | null>(null);
  const active = data.status === 'IN_PROGRESS';
  const seconds = Math.max(0, Math.ceil((Date.parse(data.expiresAt) - now - offset) / 1000));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (active && seconds === 0) reload();
    // Reload depends on the attempt reaching zero, not on incidental renders.
    // The resource unmounts the attempt while reconciling on the server.
  }, [active, seconds, reload]);
  const answered = questions.filter((question) => question.selectedOptionId).length;
  const item = questions[index];
  function save(selectedOptionId: string | null) {
    const previous = item.selectedOptionId;
    setUnsaved(null);
    setQuestions((all) =>
      all.map((question) => (question.id === item.id ? { ...question, selectedOptionId } : question)),
    );
    void action.run(async () => {
      try {
        const result = await mutate<{ selectedOptionId: string | null; revision: number }>(
          apiPath + '/answers/' + item.id,
          'PUT',
          { selectedOptionId, expectedRevision: item.revision },
          session.csrfToken,
        );
        setQuestions((all) =>
          all.map((question) => (question.id === item.id ? { ...question, ...result } : question)),
        );
      } catch (error) {
        setQuestions((all) =>
          all.map((question) => (question.id === item.id ? { ...question, selectedOptionId: previous } : question)),
        );
        if (error instanceof ApiError && error.status === 409) reload();
        else setUnsaved({ questionId: item.id, selectedOptionId });
        throw error;
      }
    });
  }
  return (
    <>
      <Heading
        title={review ? 'Quiz answer review' : 'Quiz attempt ' + data.attemptNumber}
        parent={{ to: detailPath, label: 'Assessment details' }}
        action={active && <Badge>{data.status}</Badge>}
      />
      {active ? (
        <Card className="panel quiz-timer">
          <Timer size={21} aria-hidden="true" />
          <strong>
            {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
          </strong>
          <span>
            {answered} of {questions.length} answered
          </span>
        </Card>
      ) : (
        <Card className="panel">
          <h2>{review ? 'Released attempt' : data.status === 'TIMED_OUT' ? 'Time expired' : 'Attempt submitted'}</h2>
          {review ? (
            <p>
              {data.points} / {data.maxPoints} points
            </p>
          ) : (
            <GradeView grade={data.publishedBest} />
          )}
        </Card>
      )}
      {item && (
        <div className="quiz-workbench">
          <Card className="panel">
            <h2>
              Question {index + 1} of {questions.length}
            </h2>
            <p className="plain-text">{item.prompt}</p>
            <fieldset className="quiz-options" disabled={!active || action.pending || seconds === 0}>
              <legend className="sr-only">Select one answer</legend>
              {item.options.map((option) => (
                <label
                  className={'quiz-option' + (review && option.id === item.correctOptionId ? ' correct' : '')}
                  key={option.id}
                >
                  <input
                    type="radio"
                    name="answer"
                    checked={item.selectedOptionId === option.id}
                    onChange={() => save(option.id)}
                  />
                  {option.label}
                  {review && option.id === item.correctOptionId && <strong>Correct answer</strong>}
                </label>
              ))}
            </fieldset>
            {review && item.explanation && <p className="plain-text">{item.explanation}</p>}
            {active && (
              <div className="actions">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!item.selectedOptionId || action.pending}
                  onClick={() => save(null)}
                >
                  Clear selection
                </Button>
                {unsaved?.questionId === item.id && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={action.pending}
                    onClick={() => save(unsaved.selectedOptionId)}
                  >
                    Retry save
                  </Button>
                )}
                <small role="status">
                  {action.pending
                    ? 'Saving…'
                    : unsaved?.questionId === item.id
                      ? 'Save failed'
                      : item.revision
                        ? 'Saved'
                        : 'No answer saved'}
                </small>
              </div>
            )}
            <ErrorMessage message={action.error} />
            <div className="actions quiz-nav">
              <Button
                variant="outline"
                disabled={!index || action.pending}
                onClick={() => setIndex((value) => value - 1)}
              >
                <ArrowLeft aria-hidden="true" />
                Previous
              </Button>
              <Button
                variant="outline"
                disabled={index === questions.length - 1 || action.pending}
                onClick={() => setIndex((value) => value + 1)}
              >
                Next
                <ArrowRight aria-hidden="true" />
              </Button>
            </div>
          </Card>
          <Card className="panel">
            <h2>Questions</h2>
            <div className="question-grid">
              {questions.map((question, n) => (
                <Button
                  key={question.id}
                  size="icon"
                  variant={n === index ? 'default' : question.selectedOptionId ? 'secondary' : 'outline'}
                  aria-label={'Question ' + (n + 1) + (question.selectedOptionId ? ', answered' : '')}
                  aria-pressed={n === index}
                  disabled={action.pending}
                  onClick={() => setIndex(n)}
                >
                  {n + 1}
                </Button>
              ))}
            </div>
            {active && (
              <Button
                className="quiz-submit"
                disabled={action.pending || seconds === 0 || !!unsaved}
                onClick={() =>
                  confirmation.ask({
                    title: 'Submit quiz?',
                    label: 'Submit quiz',
                    detail: questions.length - answered + ' unanswered. Your saved selections will be final.',
                    run: () =>
                      void action.run(async () => {
                        await mutate(apiPath + '/submit', 'POST', {}, session.csrfToken);
                        reload();
                      }),
                  })
                }
              >
                Submit quiz
              </Button>
            )}
          </Card>
        </div>
      )}
      {confirmation.dialog}
    </>
  );
}
