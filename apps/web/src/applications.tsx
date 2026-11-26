import { useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, CircleSlash, Plus, XCircle } from 'lucide-react';
import { get, list, mutate, query, type Applicant, type ApplicationStatus, type ApplicationSummary, type Intake, type Programme, type Qualification, type Session } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Textarea } from './components/ui/textarea.js';
import { CapacityBar } from './charts.js';
import { canEdit } from './applicants.js';
import {
  Badge, Details, Empty, ErrorMessage, Heading, Pagination, Resource, RowMenu, SearchField, SortHeader, applicationStatusOrder, calendarDate,
  dateOnly, dateTime, field, qualificationNames, qualificationTypeNames, relative, statusText, submit, toast, useAction, useConfirmation, useResource,
} from './ui.js';

type SortKey = 'reference' | 'applicant' | 'programme' | 'intake' | 'status' | 'submittedAt' | 'updatedAt' | 'deadline';
type Reviewer = { id: string; name: string; role: string };
type HistoryEntry = { id: string; fromStatus: ApplicationStatus | null; toStatus: ApplicationStatus; reason: string; occurredAt: string; actorName: string | null };
type Detail = ApplicationSummary & {
  applicant: Applicant;
  programme: Programme;
  intake: { id: string; name: string; academicYear: string; status: string; opensAt: string; closesAt: string; commencesOn: string; capacity: number; enrolled: number; remainingCapacity: number };
  requirements: { qualification: boolean; gpa: boolean | null; met: boolean };
  availableActions: { action: string; label: string; to: ApplicationStatus; reasonRequired: boolean }[];
  defaultOfferResponseDeadline: string;
  history: HistoryEntry[];
  decisions: HistoryEntry[];
  notes: { id: string; body: string; createdAt: string; authorName: string | null }[];
  otherApplications: { id: string; reference: string; status: ApplicationStatus; programmeCode: string; intakeName: string }[];
};

export function ApplicationList({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const value = (key: string) => params.get(key) ?? '';
  const set = (changes: Record<string, string>) => setParams(previous => {
    const next = new URLSearchParams(previous);
    for (const [key, entry] of Object.entries(changes)) if (entry) next.set(key, entry); else next.delete(key);
    if (!('page' in changes)) next.delete('page');
    return next;
  }, { replace: true });
  const sort = { key: (value('sort') || 'updatedAt') as SortKey, dir: (value('dir') || 'desc') as 'asc' | 'desc' };
  const path = '/applications' + query({ q: value('q'), status: value('status'), programmeId: value('programmeId'), intakeId: value('intakeId'),
    reviewerId: value('reviewerId'), attention: value('attention'), page: value('page'), sort: sort.key, dir: sort.dir });
  const state = useResource(() => list<ApplicationSummary>(path), path);
  const options = useResource(() => Promise.all([
    list<Programme>('/programmes?pageSize=100&sort=code'), list<Intake>('/intakes?pageSize=100'), get<Reviewer[]>('/applications/reviewers'),
  ]), 'application-filter-options');
  const [programmes, intakes, reviewers] = options.value ?? [];
  const onSort = (key: SortKey, dir: 'asc' | 'desc') => set({ sort: key, dir });
  return <>
    <Heading title="Applications" detail="Every admission application and where it is in the review workflow."
      action={canEdit(session) && <Button asChild><Link to="/applications/new"><Plus aria-hidden="true" />New application</Link></Button>} />
    <nav className="status-tabs" aria-label="Filter by status">
      {[['', 'All'], ['SUBMITTED', 'Pending review'], ['UNDER_REVIEW', 'Under review'], ['INFO_REQUIRED', 'Info required'], ['OFFER_ISSUED', 'Offers issued'], ['OFFER_ACCEPTED', 'Accepted']].map(([status, label]) =>
        <button key={status || 'all'} type="button" data-slot="pill" aria-pressed={value('status') === status && !value('attention')} onClick={() => set({ status, attention: '' })}>{label}</button>)}
      <button type="button" data-slot="pill" data-tone="warning" aria-pressed={value('attention') === 'true'} onClick={() => set({ attention: value('attention') ? '' : 'true', status: '' })}><AlertTriangle size={14} aria-hidden="true" />Needs attention</button>
    </nav>
    <section className="directory" aria-label="Applications">
      <div className="filters">
        <SearchField label="Search" placeholder="Reference, applicant name, ID or email" value={value('q')} onChange={q => set({ q })} />
        <label>Status<NativeSelect value={value('status')} onChange={event => set({ status: event.target.value })}>
          <NativeSelectOption value="">All statuses</NativeSelectOption>
          {applicationStatusOrder.map(status => <NativeSelectOption key={status} value={status}>{statusText(status)}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Programme<NativeSelect value={value('programmeId')} onChange={event => set({ programmeId: event.target.value, intakeId: '' })}>
          <NativeSelectOption value="">All programmes</NativeSelectOption>
          {programmes?.data.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.code} · {item.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Intake<NativeSelect value={value('intakeId')} onChange={event => set({ intakeId: event.target.value })}>
          <NativeSelectOption value="">All intakes</NativeSelectOption>
          {intakes?.data.filter(item => !value('programmeId') || item.programmeId === value('programmeId')).map(item => <NativeSelectOption key={item.id} value={item.id}>{item.programmeCode} · {item.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Reviewer<NativeSelect value={value('reviewerId')} onChange={event => set({ reviewerId: event.target.value })}>
          <NativeSelectOption value="">Anyone</NativeSelectOption><NativeSelectOption value="none">Unassigned</NativeSelectOption>
          {reviewers?.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      <Resource state={state}>{result => <>
        {!result.data.length ? <Empty>No applications match these filters.</Empty> : <div className="table-wrap"><Table>
          <TableHeader><TableRow>
            <SortHeader label="Reference" column="reference" sort={sort} onSort={onSort} />
            <SortHeader label="Applicant" column="applicant" sort={sort} onSort={onSort} />
            <SortHeader label="Programme" column="programme" sort={sort} onSort={onSort} />
            <SortHeader label="Intake" column="intake" sort={sort} onSort={onSort} />
            <SortHeader label="Submitted" column="submittedAt" sort={sort} onSort={onSort} />
            <SortHeader label="Status" column="status" sort={sort} onSort={onSort} />
            <TableHead scope="col">Reviewer</TableHead>
            <SortHeader label="Updated" column="updatedAt" sort={sort} onSort={onSort} />
            <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{result.data.map(item => <TableRow key={item.id} className="clickable-row">
            <TableHead scope="row"><Link className="row-link mono" to={'/applications/' + item.id}>{item.reference}</Link>
              {item.attention && <small className="attention"><AlertTriangle size={12} aria-hidden="true" />{item.attention}</small>}</TableHead>
            <TableCell><strong className="cell-strong">{item.applicant.name}</strong><small className="mono">{item.applicant.applicantNumber}</small></TableCell>
            <TableCell>{item.programme.code}<small>{item.programme.name}</small></TableCell>
            <TableCell>{item.intake.name}</TableCell>
            <TableCell>{item.submittedAt ? dateOnly(item.submittedAt) : '—'}</TableCell>
            <TableCell><Badge>{item.status}</Badge></TableCell>
            <TableCell>{item.reviewer?.name ?? <span className="muted">Unassigned</span>}</TableCell>
            <TableCell>{relative(item.updatedAt)}</TableCell>
            <TableCell className="menu-cell"><RowMenu label={'Actions for ' + item.reference} items={[
              { label: 'Open review', onSelect: () => navigate('/applications/' + item.id) },
              { label: 'View applicant', onSelect: () => navigate('/applicants/' + item.applicant.id) },
              { label: 'View programme', onSelect: () => navigate('/programmes/' + item.programme.id) },
            ]} /></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
        <div className="directory-foot"><span /><Pagination page={result} onPage={page => set({ page: String(page) })} /></div>
      </>}</Resource>
    </section>
  </>;
}

export function ApplicationCreate({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [search, setSearch] = useState('');
  const [applicantId, setApplicantId] = useState(params.get('applicantId') ?? '');
  const [programmeId, setProgrammeId] = useState(params.get('programmeId') ?? '');
  const [intakeId, setIntakeId] = useState(params.get('intakeId') ?? '');
  const action = useAction();
  const applicantPath = '/applicants' + query({ q: search, pageSize: 20, sort: 'name' });
  const applicants = useResource(() => list<Applicant>(applicantPath), applicantPath);
  const preset = useResource(() => applicantId ? get<Applicant>('/applicants/' + applicantId) : Promise.resolve(null), 'preset-' + (params.get('applicantId') ?? ''));
  const options = useResource(() => Promise.all([
    list<Programme>('/programmes?pageSize=100&status=ACTIVE&sort=code'), list<Intake>('/intakes?pageSize=100&sort=opensAt&dir=asc'), get<Reviewer[]>('/applications/reviewers'),
  ]), 'create-options');
  if (!canEdit(session)) return <Empty>Your role can view applications but not create them.</Empty>;
  return <Resource state={options}>{([programmes, intakes, reviewers]) => {
    const programme = programmes.data.find(item => item.id === programmeId);
    const available = intakes.data.filter(item => item.programmeId === programmeId && ['UPCOMING', 'OPEN', 'CLOSED'].includes(item.status));
    const intake = available.find(item => item.id === intakeId);
    const choices = [...(preset.value && !applicants.value?.data.some(item => item.id === preset.value!.id) ? [preset.value] : []), ...(applicants.value?.data ?? [])]
      .filter(item => item.status !== 'ARCHIVED');
    const create = (submitNow: boolean, form: FormData) => void action.run(async () => {
      const created = await mutate<{ id: string; reference: string }>('/applications', 'POST', {
        applicantId, programmeId, intakeId, reviewerId: field(form, 'reviewerId') || null, note: field(form, 'note'), submit: submitNow,
      }, session.csrfToken);
      toast('Application ' + created.reference + (submitNow ? ' submitted' : ' saved as draft'));
      navigate('/applications/' + created.id);
    });
    return <>
      <Heading title="New application" parent={{ to: '/applications', label: 'Applications' }} detail="Choose the applicant, programme and intake. A reference number is generated when you save." />
      <form className="form-sections" onSubmit={event => { event.preventDefault(); create((event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'submit', new FormData(event.currentTarget)); }}>
        <Card className="panel form-section"><div><h2>Applicant</h2><p>Search by name, email or applicant ID.</p></div>
          <div className="form-grid">
            <SearchField label="Find applicant" value={search} onChange={setSearch} placeholder="Start typing a name" />
            <label>Applicant<NativeSelect value={applicantId} required onChange={event => setApplicantId(event.target.value)}>
              <NativeSelectOption value="">Choose an applicant</NativeSelectOption>
              {choices.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.fullName} · {item.applicantNumber}</NativeSelectOption>)}
            </NativeSelect></label>
          </div></Card>
        <Card className="panel form-section"><div><h2>Programme and intake</h2><p>The intake must belong to the selected programme. Only open intakes accept submissions.</p></div>
          <div className="form-grid">
            <label>Programme<NativeSelect value={programmeId} required onChange={event => { setProgrammeId(event.target.value); setIntakeId(''); }}>
              <NativeSelectOption value="">Choose a programme</NativeSelectOption>
              {programmes.data.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.code} · {item.name}</NativeSelectOption>)}
            </NativeSelect></label>
            <label>Admission intake<NativeSelect value={intakeId} required disabled={!programmeId} onChange={event => setIntakeId(event.target.value)}>
              <NativeSelectOption value="">{programmeId ? (available.length ? 'Choose an intake' : 'No intakes available') : 'Choose a programme first'}</NativeSelectOption>
              {available.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name} · {statusText(item.status)} · {item.remainingCapacity} places left</NativeSelectOption>)}
            </NativeSelect></label>
            {programme && <p className="field-note span-2">Requires {qualificationNames[programme.minimumQualification as Qualification].toLowerCase()} qualification{programme.minimumGpa ? ' and GPA ' + programme.minimumGpa + '+' : ''}.
              {intake && ` Applications close ${dateTime(intake.closesAt)}.`}</p>}
          </div></Card>
        <Card className="panel form-section"><div><h2>Review</h2><p>Optional: assign a reviewer and add a first note.</p></div>
          <div className="form-grid">
            <label>Reviewer<NativeSelect name="reviewerId" defaultValue="">
              <NativeSelectOption value="">Assign later</NativeSelectOption>
              {reviewers.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.name}</NativeSelectOption>)}
            </NativeSelect></label>
            <label className="span-2">Review note (optional)<Textarea name="note" rows={3} maxLength={4000} /></label>
          </div></Card>
        <ErrorMessage message={action.error} />
        <div className="form-actions">
          <Button name="intent" value="submit" disabled={action.pending || intake?.status !== 'OPEN'} title={intake && intake.status !== 'OPEN' ? 'This intake is not open for submissions' : undefined}>Create and submit</Button>
          <Button name="intent" value="draft" variant="outline" disabled={action.pending}>Save as draft</Button>
          <Button type="button" variant="ghost" onClick={() => navigate(-1)}>Cancel</Button>
        </div>
      </form>
    </>;
  }}</Resource>;
}

const actionCopy: Record<string, { detail: string; destructive?: boolean; reasonLabel?: string }> = {
  submit: { detail: 'The application enters the review queue. The intake must be open.' },
  'start-review': { detail: 'You become the reviewer if none is assigned.' },
  'request-information': { detail: 'The applicant is asked for more information. Review pauses until you resume it.', reasonLabel: 'What information is needed?' },
  'resume-review': { detail: 'Continue reviewing now that the information has arrived.' },
  waitlist: { detail: 'The applicant is placed on the waitlist. You can issue an offer or reject later.', reasonLabel: 'Reason' },
  'issue-offer': { detail: 'An admission offer is recorded. The applicant must respond by the deadline.' },
  reject: { detail: 'The application is rejected. This ends the application.', destructive: true, reasonLabel: 'Reason for rejection' },
  'accept-offer': { detail: 'Record that the applicant accepted the offer.' },
  'decline-offer': { detail: 'Record that the applicant declined the offer. This ends the application.', destructive: true, reasonLabel: 'Reason (if given)' },
  enrol: { detail: 'Confirm enrolment. This uses one place in the intake and cannot be undone.' },
  withdraw: { detail: 'The application is withdrawn. This ends the application.', destructive: true, reasonLabel: 'Reason for withdrawal' },
};
const finalActions = ['reject', 'decline-offer', 'withdraw', 'enrol'];

export function ApplicationDetail({ session }: { session: Session }) {
  const { applicationId } = useParams();
  const path = '/applications/' + applicationId;
  const state = useResource(() => Promise.all([get<Detail>(path), get<Reviewer[]>('/applications/reviewers')]), path);
  const action = useAction();
  const confirmation = useConfirmation();
  const deadlineRef = useRef('');
  const editor = canEdit(session);
  return <Resource state={state}>{([item, reviewers]) => {
    const run = (name: string, label: string, reasonRequired: boolean) => {
      const copy = actionCopy[name];
      if (name === 'issue-offer') deadlineRef.current = item.defaultOfferResponseDeadline;
      confirmation.ask({
        title: label + '?', detail: copy.detail, label, destructive: copy.destructive,
        reason: copy.reasonLabel || reasonRequired ? { label: copy.reasonLabel ?? 'Remarks', required: reasonRequired } : { label: 'Remarks', required: false },
        extra: name === 'issue-offer' ? <OfferDeadline initial={item.defaultOfferResponseDeadline} onChange={value => { deadlineRef.current = value; }} /> : undefined,
        run: reason => void action.run(async () => {
          await mutate(path + '/' + name, 'POST', { version: item.version, reason, ...(name === 'issue-offer' ? { offerResponseDeadline: deadlineRef.current || item.defaultOfferResponseDeadline } : {}) }, session.csrfToken);
          toast(item.reference + ': ' + statusText(item.availableActions.find(entry => entry.action === name)!.to).toLowerCase());
          state.reload();
        }),
      });
    };
    const primary = item.availableActions.filter(entry => !finalActions.includes(entry.action) || entry.action === 'enrol');
    const secondary = item.availableActions.filter(entry => finalActions.includes(entry.action) && entry.action !== 'enrol');
    const terminal = !item.availableActions.length;
    const applicant = item.applicant;
    return <>
      <Heading title={item.reference} parent={{ to: '/applications', label: 'Applications' }}
        detail={<><Link className="text-link" to={'/applicants/' + applicant.id}>{applicant.fullName}</Link> · {item.programme.code} {item.programme.name} · {item.intake.name}</>}
        action={<Badge>{item.status}</Badge>} />
      <ErrorMessage message={action.error} />
      {item.attention && <div className="callout" data-tone="warning"><AlertTriangle size={17} aria-hidden="true" />{item.attention}</div>}
      <div className="review-layout">
        <div className="review-main">
          <Card className="panel">
            <div className="panel-head"><h2>Applicant</h2><Link className="text-link" to={'/applicants/' + applicant.id}>Full profile</Link></div>
            <div className="detail-columns">
              <Details items={[['Name', applicant.fullName], ['Applicant ID', <span className="mono">{applicant.applicantNumber}</span>], ['Date of birth', calendarDate(applicant.dateOfBirth)], ['Nationality', applicant.nationality]]} />
              <Details items={[['Email', applicant.email], ['Phone', applicant.phone], ['Previous institution', applicant.previousInstitution],
                ['Qualification', qualificationNames[applicant.highestQualification] + (applicant.gpa ? ' · GPA ' + applicant.gpa : '')]]} />
            </div>
          </Card>
          <Card className="panel">
            <div className="panel-head"><h2>Programme requirements</h2>
              <span className="flag" data-tone={item.requirements.met ? 'success' : 'danger'}>{item.requirements.met ? 'Requirements met' : 'Requirements not met'}</span></div>
            <ul className="checklist">
              <li data-ok={item.requirements.qualification}>{item.requirements.qualification ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
                Minimum qualification: {qualificationNames[item.programme.minimumQualification]} <span className="muted">(applicant: {qualificationNames[applicant.highestQualification]})</span></li>
              <li data-ok={item.requirements.gpa === null ? 'na' : item.requirements.gpa}>{item.requirements.gpa === null ? <CircleSlash aria-hidden="true" /> : item.requirements.gpa ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
                Minimum GPA: {item.programme.minimumGpa ?? 'none'} <span className="muted">(applicant: {applicant.gpa ?? 'not provided'})</span></li>
            </ul>
            {item.programme.admissionRequirements && <p className="plain-text requirements-text">{item.programme.admissionRequirements}</p>}
            <Details items={[['Programme', <Link className="text-link" to={'/programmes/' + item.programme.id}>{item.programme.code} · {item.programme.name}</Link>],
              ['Faculty', item.programme.faculty], ['Qualification', qualificationTypeNames[item.programme.qualificationType] + ' · ' + item.programme.durationMonths + ' months']]} />
          </Card>
          <Card className="panel">
            <h2>Review notes</h2>
            {editor && <form className="note-form" onSubmit={submit(form => void action.run(async () => {
              await mutate(path + '/notes', 'POST', { body: field(form, 'body') }, session.csrfToken);
              (document.getElementById('note-body') as HTMLTextAreaElement).value = '';
              toast('Note added'); state.reload();
            }))}>
              <label className="sr-label">New review note<Textarea id="note-body" name="body" rows={2} required maxLength={4000} placeholder="Add an internal review note…" /></label>
              <Button size="sm" disabled={action.pending}>Add note</Button>
            </form>}
            {item.notes.length ? <ul className="note-list">{item.notes.map(note => <li key={note.id}><p className="plain-text">{note.body}</p><small>{note.authorName ?? 'Unknown'} · {dateTime(note.createdAt)}</small></li>)}</ul>
              : <p className="reading-empty">No review notes yet.</p>}
          </Card>
        </div>
        <aside className="review-side">
          <Card className="panel action-panel">
            <h2>Actions</h2>
            {!editor ? <p className="reading-empty">Read-only access: you can view this application but not change it.</p>
              : terminal ? <p className="reading-empty">This application is {statusText(item.status).toLowerCase()}. No further actions are available.</p>
              : <div className="action-stack">
                {primary.map(entry => <Button key={entry.action} disabled={action.pending} onClick={() => run(entry.action, entry.label, entry.reasonRequired)}>{entry.label}</Button>)}
                {secondary.map(entry => <Button key={entry.action} variant="outline" className="danger-outline" disabled={action.pending} onClick={() => run(entry.action, entry.label, entry.reasonRequired)}>{entry.label}</Button>)}
              </div>}
          </Card>
          <Card className="panel">
            <h2>Assignment</h2>
            <Details items={[['Submitted', item.submittedAt ? dateTime(item.submittedAt) : 'Not submitted'], ['Decision', item.decision ? statusText(item.decision) + ' · ' + dateOnly(item.decidedAt!) : 'None yet'],
              ...(item.offerResponseDeadline ? [['Offer response by', calendarDate(item.offerResponseDeadline)] as [string, string]] : [])]} />
            {editor && !terminal && <AssignmentForm item={item} reviewers={reviewers} session={session} path={path} reload={state.reload} />}
          </Card>
          <Card className="panel">
            <h2>Intake</h2>
            <Details items={[['Intake', <Link className="text-link" to={'/intakes/' + item.intake.id}>{item.intake.name}</Link>], ['Status', <Badge>{item.intake.status}</Badge>],
              ['Applications close', dateTime(item.intake.closesAt)], ['Commences', calendarDate(item.intake.commencesOn)]]} />
            <CapacityBar capacity={item.intake.capacity} enrolled={item.intake.enrolled} />
          </Card>
          {item.otherApplications.length > 0 && <Card className="panel"><h2>Other applications</h2>
            <ul className="mini-list">{item.otherApplications.map(other => <li key={other.id}><Link className="text-link mono" to={'/applications/' + other.id}>{other.reference}</Link>
              <span>{other.programmeCode} · {other.intakeName}</span><Badge>{other.status}</Badge></li>)}</ul></Card>}
        </aside>
      </div>
      <Card className="panel">
        <h2>Status history</h2>
        <ol className="timeline-v">{item.history.map((entry, index) => <li key={entry.id} data-tone={entry.toStatus} data-last={index === item.history.length - 1 || undefined}>
          <span className="timeline-v-dot" aria-hidden="true" />
          <div>
            <p><Badge>{entry.toStatus}</Badge>{entry.fromStatus && <span className="muted"> from {statusText(entry.fromStatus)}</span>}</p>
            {entry.reason && <p className="timeline-reason">{entry.reason}</p>}
            <small>{entry.actorName ?? 'System'} · {dateTime(entry.occurredAt)}</small>
          </div>
        </li>)}</ol>
      </Card>
      {confirmation.dialog}
    </>;
  }}</Resource>;
}

/** Date picker shown inside the issue-offer confirmation. */
function OfferDeadline({ initial, onChange }: { initial: string; onChange: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore' }).format(new Date());
  return <label className="dialog-field">Offer response deadline<Input type="date" value={value} min={today} required onChange={event => { setValue(event.target.value); onChange(event.target.value); }} /></label>;
}

function AssignmentForm({ item, reviewers, session, path, reload }: { item: Detail; reviewers: Reviewer[]; session: Session; path: string; reload: () => void }) {
  const action = useAction();
  const movable = ['DRAFT', 'SUBMITTED'].includes(item.status);
  const options = useResource(() => movable ? Promise.all([list<Programme>('/programmes?pageSize=100&status=ACTIVE&sort=code'), list<Intake>('/intakes?pageSize=100')]) : Promise.resolve(null), 'assignment-' + item.id + movable);
  const [programmeId, setProgrammeId] = useState(item.programme.id);
  return <form className="stack compact-form" onSubmit={submit(form => void action.run(async () => {
    const body: Record<string, unknown> = { version: item.version, reviewerId: field(form, 'reviewerId') || null };
    if (movable) { body.programmeId = field(form, 'programmeId'); body.intakeId = field(form, 'intakeId'); }
    if (item.status === 'OFFER_ISSUED' && field(form, 'deadline')) body.offerResponseDeadline = field(form, 'deadline');
    await mutate(path, 'PATCH', body, session.csrfToken);
    toast('Application updated'); reload();
  }))}>
    <label>Reviewer<NativeSelect name="reviewerId" defaultValue={item.reviewer?.id ?? ''}>
      <NativeSelectOption value="">Unassigned</NativeSelectOption>
      {reviewers.map(reviewer => <NativeSelectOption key={reviewer.id} value={reviewer.id}>{reviewer.name}</NativeSelectOption>)}
    </NativeSelect></label>
    {movable && options.value && <>
      <label>Programme<NativeSelect name="programmeId" value={programmeId} onChange={event => setProgrammeId(event.target.value)}>
        {options.value[0].data.map(programme => <NativeSelectOption key={programme.id} value={programme.id}>{programme.code} · {programme.name}</NativeSelectOption>)}
      </NativeSelect></label>
      <label>Intake<NativeSelect name="intakeId" key={programmeId} defaultValue={programmeId === item.programme.id ? item.intake.id : ''} required>
        <NativeSelectOption value="">Choose an intake</NativeSelectOption>
        {options.value[1].data.filter(intake => intake.programmeId === programmeId && ['UPCOMING', 'OPEN', 'CLOSED'].includes(intake.status)).map(intake =>
          <NativeSelectOption key={intake.id} value={intake.id}>{intake.name} · {statusText(intake.status)}</NativeSelectOption>)}
      </NativeSelect></label>
    </>}
    {item.status === 'OFFER_ISSUED' && <label>Offer response deadline<Input name="deadline" type="date" defaultValue={item.offerResponseDeadline ?? ''} /></label>}
    <ErrorMessage message={action.error} />
    <Button size="sm" variant="outline" disabled={action.pending}>Save assignment</Button>
  </form>;
}
