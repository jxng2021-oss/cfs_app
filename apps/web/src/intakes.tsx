import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Pencil, Plus } from 'lucide-react';
import { get, list, mutate, query, type ApplicationSummary, type Funnel, type Intake, type IntakeStatus, type Programme, type Session, type StatusCount } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { CapacityBar, RateMeter, StatusStack } from './charts.js';
import { ActivityHistory } from './activity.js';
import { isAdmin } from './programmes.js';
import { useBranding } from './branding.js';
import {
  Badge, Details, Empty, ErrorMessage, Heading, Pagination, Resource, RowMenu, SearchField, SortHeader, calendarDate, dateOnly, dateTime, field,
  fromLocalInput, localInput, relative, submit, toast, useAction, useConfirmation, useResource,
} from './ui.js';

type SortKey = 'name' | 'programme' | 'academicYear' | 'opensAt' | 'closesAt' | 'capacity' | 'status' | 'utilisation';
type IntakeDetailData = Intake & { allowedStatuses: IntakeStatus[]; stats: Funnel & { statuses: StatusCount[] } };
const statusVerbs: Record<IntakeStatus, { label: string; detail: string; destructive?: boolean }> = {
  OPEN: { label: 'Open admissions', detail: 'Applications to this intake can be submitted until you close it.' },
  CLOSED: { label: 'Close admissions', detail: 'No new submissions are accepted. Applications already received continue through review.' },
  COMPLETED: { label: 'Mark completed', detail: 'The intake becomes read-only. Use this once the cohort has started.' },
  CANCELLED: { label: 'Cancel intake', detail: 'The intake is cancelled and becomes read-only. Existing applications keep their history.', destructive: true },
  UPCOMING: { label: 'Reset to upcoming', detail: '' },
};

export function IntakeList({ session }: { session: Session }) {
  const navigate = useNavigate();
  const { settings } = useBranding();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [programmeId, setProgrammeId] = useState('');
  const [academicYear, setAcademicYear] = useState(settings.defaultAcademicYear);
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'opensAt', dir: 'desc' });
  const path = '/intakes' + query({ q: search, status, programmeId, academicYear, page, sort: sort.key, dir: sort.dir });
  const state = useResource(() => list<Intake>(path), path);
  const options = useResource(() => Promise.all([list<Programme>('/programmes?pageSize=100&sort=code'), get<string[]>('/intakes/years')]), 'intake-options');
  const reset = (apply: () => void) => { apply(); setPage(1); };
  const onSort = (key: SortKey, dir: 'asc' | 'desc') => reset(() => setSort({ key, dir }));
  return <>
    <Heading title="Admission Intakes" detail="Application windows and enrolment capacity for each programme."
      action={isAdmin(session) && <Button asChild><Link to="/intakes/new"><Plus aria-hidden="true" />New intake</Link></Button>} />
    <section className="directory" aria-label="Admission intakes">
      <div className="filters">
        <SearchField label="Search" placeholder="Intake or programme" value={search} onChange={value => reset(() => setSearch(value))} />
        <label>Academic year<NativeSelect value={academicYear} onChange={event => reset(() => setAcademicYear(event.target.value))}>
          <NativeSelectOption value="">All years</NativeSelectOption>
          {[...new Set([settings.defaultAcademicYear, ...(options.value?.[1] ?? [])])].sort().reverse().map(year => <NativeSelectOption key={year} value={year}>{year}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Programme<NativeSelect value={programmeId} onChange={event => reset(() => setProgrammeId(event.target.value))}>
          <NativeSelectOption value="">All programmes</NativeSelectOption>
          {options.value?.[0].data.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.code} · {item.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Status<NativeSelect value={status} onChange={event => reset(() => setStatus(event.target.value))}>
          <NativeSelectOption value="">All statuses</NativeSelectOption>
          {(['UPCOMING', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED'] as const).map(value => <NativeSelectOption key={value} value={value}>{value[0] + value.slice(1).toLowerCase()}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      <Resource state={state}>{result => <>
        {!result.data.length ? <Empty>No intakes match these filters.</Empty> : <div className="table-wrap"><Table>
          <TableHeader><TableRow>
            <SortHeader label="Intake" column="name" sort={sort} onSort={onSort} />
            <SortHeader label="Programme" column="programme" sort={sort} onSort={onSort} />
            <SortHeader label="Year" column="academicYear" sort={sort} onSort={onSort} />
            <SortHeader label="Opens" column="opensAt" sort={sort} onSort={onSort} />
            <SortHeader label="Closes" column="closesAt" sort={sort} onSort={onSort} />
            <SortHeader label="Capacity used" column="utilisation" sort={sort} onSort={onSort} />
            <SortHeader label="Status" column="status" sort={sort} onSort={onSort} />
            <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{result.data.map(intake => <TableRow key={intake.id} className="clickable-row">
            <TableHead scope="row"><Link className="row-link" to={'/intakes/' + intake.id}>{intake.name}</Link><small>{intake.applications} applications</small></TableHead>
            <TableCell><span className="mono">{intake.programmeCode}</span><small>{intake.programmeName}</small></TableCell>
            <TableCell>{intake.academicYear}</TableCell>
            <TableCell>{dateOnly(intake.opensAt)}</TableCell>
            <TableCell>{dateOnly(intake.closesAt)}{intake.status === 'OPEN' && <small>{relative(intake.closesAt)}</small>}</TableCell>
            <TableCell><CapacityBar capacity={intake.capacity} enrolled={intake.enrolled} accepted={intake.acceptedOffers} compact /></TableCell>
            <TableCell><Badge>{intake.status}</Badge></TableCell>
            <TableCell className="menu-cell"><RowMenu label={'Actions for ' + intake.name} items={[
              { label: 'View intake', onSelect: () => navigate('/intakes/' + intake.id) },
              { label: 'Edit', onSelect: () => navigate('/intakes/' + intake.id + '/edit'), hidden: !isAdmin(session) || ['COMPLETED', 'CANCELLED'].includes(intake.status) },
              { label: 'View applications', onSelect: () => navigate('/applications' + query({ programmeId: intake.programmeId, intakeId: intake.id })) },
            ]} /></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
        <div className="directory-foot"><span /><Pagination page={result} onPage={setPage} /></div>
      </>}</Resource>
    </section>
  </>;
}

export function IntakeDetail({ session }: { session: Session }) {
  const { intakeId } = useParams();
  const navigate = useNavigate();
  const path = '/intakes/' + intakeId;
  const [page, setPage] = useState(1);
  const applicationsPath = '/applications' + query({ intakeId, page, pageSize: 10, sort: 'submittedAt', dir: 'desc' });
  const state = useResource(() => get<IntakeDetailData>(path), path);
  const applications = useResource(() => list<ApplicationSummary>(applicationsPath), applicationsPath);
  const action = useAction();
  const confirmation = useConfirmation();
  const admin = isAdmin(session);
  return <Resource state={state}>{intake => {
    const changeStatus = (status: IntakeStatus) => confirmation.ask({
      title: statusVerbs[status].label + '?', detail: statusVerbs[status].detail, label: statusVerbs[status].label, destructive: statusVerbs[status].destructive,
      run: () => void action.run(async () => { await mutate(path + '/status', 'POST', { status, version: intake.version }, session.csrfToken); toast(intake.name + ': ' + status.toLowerCase()); state.reload(); }),
    });
    const editable = !['COMPLETED', 'CANCELLED'].includes(intake.status);
    const { stats } = intake;
    return <>
      <Heading title={intake.name} parent={{ to: '/intakes', label: 'Admission Intakes' }}
        detail={<><Link className="text-link" to={'/programmes/' + intake.programmeId}>{intake.programmeCode} · {intake.programmeName}</Link> · Academic year {intake.academicYear}</>}
        action={<>
          <Badge>{intake.status}</Badge>
          {admin && editable && <Button variant="outline" asChild><Link to={path + '/edit'}><Pencil aria-hidden="true" />Edit</Link></Button>}
          {admin && intake.allowedStatuses.filter(status => status !== 'CANCELLED').map(status =>
            <Button key={status} variant={status === 'OPEN' || status === 'CLOSED' ? 'default' : 'outline'} disabled={action.pending} onClick={() => changeStatus(status)}>{statusVerbs[status].label}</Button>)}
          {admin && <RowMenu label="More intake actions" items={[
            { label: 'Cancel intake', danger: true, hidden: !intake.allowedStatuses.includes('CANCELLED'), onSelect: () => changeStatus('CANCELLED') },
            { label: 'Delete intake', danger: true, hidden: intake.applications !== 0 || stats.totalApplications !== 0, onSelect: () => confirmation.ask({
              title: 'Delete ' + intake.name + '?', detail: 'This intake has no applications, so it can be removed permanently.', label: 'Delete intake', destructive: true,
              run: () => void action.run(async () => { await mutate(path, 'DELETE', undefined, session.csrfToken); toast('Deleted ' + intake.name); navigate('/intakes'); }),
            }) },
          ]} />}
        </>} />
      <ErrorMessage message={action.error} />
      <div className="detail-grid">
        <Card className="panel">
          <h2>Application window</h2>
          <Details items={[['Opens', dateTime(intake.opensAt)], ['Closes', dateTime(intake.closesAt) + (intake.status === 'OPEN' ? ' (' + relative(intake.closesAt) + ')' : '')],
            ['Programme starts', calendarDate(intake.commencesOn)]]} />
          <p className="field-note">Times are Singapore time. Opening and closing are manual so admissions staff stay in control; the dates are the published window.</p>
        </Card>
        <Card className="panel">
          <h2>Enrolment capacity</h2>
          <div className="capacity-figure"><strong>{intake.remainingCapacity}</strong><span>of {intake.capacity} places remaining</span></div>
          <CapacityBar capacity={intake.capacity} enrolled={intake.enrolled} accepted={intake.acceptedOffers} />
          <p className="field-note">Enrolment is blocked once confirmed enrolments reach capacity. {intake.acceptedOffers} accepted offer{intake.acceptedOffers === 1 ? ' is' : 's are'} awaiting confirmation.</p>
        </Card>
        <Card className="panel">
          <h2>Admission statistics</h2>
          <div className="rates">
            <RateMeter label="Offer rate" value={stats.offerRate} numerator={stats.offersIssued} denominator={stats.submitted} definition="offers ÷ submitted" />
            <RateMeter label="Acceptance rate" value={stats.acceptanceRate} numerator={stats.offersAccepted} denominator={stats.offersIssued} definition="accepted ÷ offers" />
            <RateMeter label="Utilisation" value={intake.utilisation} numerator={intake.enrolled} denominator={intake.capacity} definition="enrolled ÷ capacity" />
          </div>
        </Card>
      </div>
      <Card className="panel"><h2>Status distribution</h2><StatusStack statuses={stats.statuses} href={status => '/applications' + query({ intakeId: intake.id, status })} /></Card>
      <Card className="panel">
        <div className="panel-head"><h2>Applications <span className="count">{stats.totalApplications}</span></h2>
          {session.user.role !== 'VIEWER' && intake.status !== 'CANCELLED' && intake.status !== 'COMPLETED' && <Button size="sm" variant="outline" asChild>
            <Link to={'/applications/new' + query({ programmeId: intake.programmeId, intakeId: intake.id })}><Plus aria-hidden="true" />New application</Link></Button>}</div>
        <Resource state={applications}>{result => result.data.length ? <>
          <div className="table-wrap flush"><Table>
            <TableHeader><TableRow><TableHead scope="col">Reference</TableHead><TableHead scope="col">Applicant</TableHead><TableHead scope="col">Submitted</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader>
            <TableBody>{result.data.map(item => <TableRow key={item.id} className="clickable-row">
              <TableHead scope="row"><Link className="row-link mono" to={'/applications/' + item.id}>{item.reference}</Link></TableHead>
              <TableCell>{item.applicant.name}</TableCell><TableCell>{item.submittedAt ? dateOnly(item.submittedAt) : '—'}</TableCell><TableCell><Badge>{item.status}</Badge></TableCell>
            </TableRow>)}</TableBody>
          </Table></div>
          <Pagination page={result} onPage={setPage} />
        </> : <p className="reading-empty">No applications yet.</p>}</Resource>
      </Card>
      <Card className="panel"><h2>Activity history</h2><ActivityHistory entityType="INTAKE" entityId={intake.id} /></Card>
      {confirmation.dialog}
    </>;
  }}</Resource>;
}

export function IntakeForm({ session }: { session: Session }) {
  const { intakeId } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { settings } = useBranding();
  const path = intakeId ? '/intakes/' + intakeId : '';
  const state = useResource(() => Promise.all([intakeId ? get<Intake>(path) : Promise.resolve(null), list<Programme>('/programmes?pageSize=100&status=ACTIVE&sort=code')]), path || 'new-intake');
  const action = useAction();
  if (!isAdmin(session)) return <Empty>Only administrators can create or edit admission intakes.</Empty>;
  return <Resource state={state}>{([intake, programmes]) => <>
    <Heading title={intake ? 'Edit ' + intake.name : 'New admission intake'} parent={intake ? { to: path, label: intake.name } : { to: '/intakes', label: 'Admission Intakes' }}
      detail="Times are entered in Singapore time. New intakes start as Upcoming; open admissions from the intake page." />
    <form className="form-sections" onSubmit={submit(form => void action.run(async () => {
      const opensAt = fromLocalInput(field(form, 'opensAt'));
      const closesAt = fromLocalInput(field(form, 'closesAt'));
      if (Date.parse(closesAt) <= Date.parse(opensAt)) throw new Error('The closing date must be after the opening date.');
      const body = { name: field(form, 'name'), academicYear: field(form, 'academicYear'), opensAt, closesAt, commencesOn: field(form, 'commencesOn'), capacity: Number(field(form, 'capacity')) };
      const saved = intake
        ? await mutate<Intake>(path, 'PATCH', { ...body, version: intake.version }, session.csrfToken)
        : await mutate<Intake>('/intakes', 'POST', { ...body, programmeId: field(form, 'programmeId') }, session.csrfToken);
      toast(intake ? 'Intake updated' : 'Intake ' + saved.name + ' created');
      navigate('/intakes/' + saved.id);
    }))}>
      <Card className="panel form-section"><div><h2>Intake</h2><p>An intake belongs to one programme.</p></div>
        <div className="form-grid">
          {intake ? <label>Programme<Input value={intake.programmeCode + ' · ' + intake.programmeName} disabled /></label>
            : <label>Programme<NativeSelect name="programmeId" required defaultValue={params.get('programmeId') ?? ''}>
              <NativeSelectOption value="">Choose a programme</NativeSelectOption>
              {programmes.data.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.code} · {item.name}</NativeSelectOption>)}
            </NativeSelect></label>}
          <label>Intake name<Input name="name" required maxLength={120} placeholder="e.g. August 2027 intake" defaultValue={intake?.name} /></label>
          <label>Academic year<Input name="academicYear" required pattern="[0-9]{4}/[0-9]{4}" title="Format: 2026/2027" defaultValue={intake?.academicYear ?? settings.defaultAcademicYear} /></label>
          <label>Maximum enrolment capacity<Input name="capacity" type="number" min={Math.max(1, intake?.enrolled ?? 1)} max={100000} step={1} required defaultValue={intake?.capacity ?? 50} /></label>
        </div></Card>
      <Card className="panel form-section"><div><h2>Dates</h2><p>The programme must start on or after the closing date.</p></div>
        <div className="form-grid">
          <label>Applications open<Input name="opensAt" type="datetime-local" required defaultValue={localInput(intake?.opensAt)} /></label>
          <label>Applications close<Input name="closesAt" type="datetime-local" required defaultValue={localInput(intake?.closesAt)} /></label>
          <label>Programme commences<Input name="commencesOn" type="date" required defaultValue={intake?.commencesOn} /></label>
        </div></Card>
      <ErrorMessage message={action.error} />
      <div className="form-actions"><Button disabled={action.pending}>{intake ? 'Save changes' : 'Create intake'}</Button>
        <Button type="button" variant="outline" onClick={() => navigate(intake ? path : '/intakes')}>Cancel</Button></div>
    </form>
  </>}</Resource>;
}
