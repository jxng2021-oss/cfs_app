import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ClipboardList, GraduationCap, Pencil, Plus } from 'lucide-react';
import { get, list, mutate, query, type Funnel, type Programme, type Session, type StatusCount, type Utilisation } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Textarea } from './components/ui/textarea.js';
import { CapacityBar, RateMeter, StatusStack } from './charts.js';
import { ActivityHistory } from './activity.js';
import {
  Badge, Details, Empty, ErrorMessage, Heading, Pagination, Resource, RowMenu, SearchField, SortHeader, dateOnly, field, qualificationNames,
  qualificationOptions, qualificationTypeNames, submit, toast, useAction, useConfirmation, useResource,
} from './ui.js';

type SortKey = 'code' | 'name' | 'faculty' | 'status' | 'applications' | 'updatedAt';
export const isAdmin = (session: Session) => session.user.role === 'ADMIN';
type ProgrammeDetailData = Programme & { stats: Funnel & { statuses: StatusCount[] }; intakes: Utilisation[] };

export function ProgrammeList({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [faculty, setFaculty] = useState('');
  const [qualificationType, setQualificationType] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'code', dir: 'asc' });
  const path = '/programmes' + query({ q: search, status, faculty, qualificationType, page, sort: sort.key, dir: sort.dir });
  const state = useResource(() => list<Programme>(path), path);
  const faculties = useResource(() => get<string[]>('/programmes/faculties'), 'faculties');
  const reset = (apply: () => void) => { apply(); setPage(1); };
  const onSort = (key: SortKey, dir: 'asc' | 'desc') => reset(() => setSort({ key, dir }));
  return <>
    <Heading title="Programmes" detail="Degrees, diplomas and certificates open for admission."
      action={isAdmin(session) && <Button asChild><Link to="/programmes/new"><Plus aria-hidden="true" />New programme</Link></Button>} />
    <section className="directory" aria-label="Programmes">
      <div className="filters">
        <SearchField label="Search" placeholder="Code or name" value={search} onChange={value => reset(() => setSearch(value))} />
        <label>Faculty<NativeSelect value={faculty} onChange={event => reset(() => setFaculty(event.target.value))}>
          <NativeSelectOption value="">All faculties</NativeSelectOption>
          {faculties.value?.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Qualification<NativeSelect value={qualificationType} onChange={event => reset(() => setQualificationType(event.target.value))}>
          <NativeSelectOption value="">All types</NativeSelectOption>
          {Object.entries(qualificationTypeNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Status<NativeSelect value={status} onChange={event => reset(() => setStatus(event.target.value))}>
          <NativeSelectOption value="">All statuses</NativeSelectOption><NativeSelectOption value="ACTIVE">Active</NativeSelectOption>
          <NativeSelectOption value="INACTIVE">Inactive</NativeSelectOption><NativeSelectOption value="ARCHIVED">Archived</NativeSelectOption>
        </NativeSelect></label>
      </div>
      <Resource state={state}>{result => <>
        {!result.data.length ? <Empty>No programmes match these filters.</Empty> : <div className="table-wrap"><Table>
          <TableHeader><TableRow>
            <SortHeader label="Code" column="code" sort={sort} onSort={onSort} />
            <SortHeader label="Programme" column="name" sort={sort} onSort={onSort} />
            <SortHeader label="Faculty" column="faculty" sort={sort} onSort={onSort} />
            <TableHead scope="col">Minimum entry</TableHead>
            <SortHeader label="Applications" column="applications" sort={sort} onSort={onSort} />
            <SortHeader label="Status" column="status" sort={sort} onSort={onSort} />
            <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
          </TableRow></TableHeader>
          <TableBody>{result.data.map(programme => <TableRow key={programme.id} className="clickable-row">
            <TableHead scope="row"><Link className="row-link mono" to={'/programmes/' + programme.id}>{programme.code}</Link></TableHead>
            <TableCell><strong className="cell-strong">{programme.name}</strong><small>{qualificationTypeNames[programme.qualificationType]} · {programme.durationMonths} months</small></TableCell>
            <TableCell>{programme.faculty}</TableCell>
            <TableCell>{qualificationNames[programme.minimumQualification]}{programme.minimumGpa && <small>GPA {programme.minimumGpa}+</small>}</TableCell>
            <TableCell>{programme.applicationCount}<small>{programme.intakeCount} intake{programme.intakeCount === 1 ? '' : 's'}</small></TableCell>
            <TableCell><Badge>{programme.status}</Badge></TableCell>
            <TableCell className="menu-cell"><RowMenu label={'Actions for ' + programme.code} items={[
              { label: 'View programme', onSelect: () => navigate('/programmes/' + programme.id) },
              { label: 'Edit', onSelect: () => navigate('/programmes/' + programme.id + '/edit'), hidden: !isAdmin(session) },
              { label: 'New intake', onSelect: () => navigate('/intakes/new' + query({ programmeId: programme.id })), hidden: !isAdmin(session) || programme.status !== 'ACTIVE' },
              { label: 'View applications', onSelect: () => navigate('/applications' + query({ programmeId: programme.id })) },
            ]} /></TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
        <div className="directory-foot"><span /><Pagination page={result} onPage={setPage} /></div>
      </>}</Resource>
    </section>
  </>;
}

export function ProgrammeDetail({ session }: { session: Session }) {
  const { programmeId } = useParams();
  const navigate = useNavigate();
  const path = '/programmes/' + programmeId;
  const state = useResource(() => get<ProgrammeDetailData>(path), path);
  const action = useAction();
  const confirmation = useConfirmation();
  const admin = isAdmin(session);
  return <Resource state={state}>{programme => {
    const setStatus = (status: Programme['status'], verb: string) => confirmation.ask({
      title: verb + ' ' + programme.code + '?',
      detail: status === 'ARCHIVED' ? 'Archived programmes stay visible in history but cannot receive new intakes or applications.'
        : status === 'INACTIVE' ? 'New applications are paused until the programme is reactivated.' : 'The programme accepts applications again.',
      label: verb + ' programme', destructive: status === 'ARCHIVED',
      run: () => void action.run(async () => { await mutate(path, 'PATCH', { status, version: programme.version }, session.csrfToken); toast(programme.code + ' ' + verb.toLowerCase() + 'd'); state.reload(); }),
    });
    const { stats } = programme;
    return <>
      <Heading title={programme.name} parent={{ to: '/programmes', label: 'Programmes' }}
        detail={<><span className="mono">{programme.code}</span> · {programme.faculty} · {qualificationTypeNames[programme.qualificationType]}</>}
        action={<>
          <Badge>{programme.status}</Badge>
          {admin && <Button variant="outline" asChild><Link to={path + '/edit'}><Pencil aria-hidden="true" />Edit</Link></Button>}
          {admin && programme.status === 'ACTIVE' && <Button asChild><Link to={'/intakes/new' + query({ programmeId: programme.id })}><Plus aria-hidden="true" />New intake</Link></Button>}
          {admin && <RowMenu label="More programme actions" items={[
            { label: 'Mark inactive', onSelect: () => setStatus('INACTIVE', 'Deactivate'), hidden: programme.status !== 'ACTIVE' },
            { label: 'Reactivate', onSelect: () => setStatus('ACTIVE', 'Reactivate'), hidden: programme.status === 'ACTIVE' },
            { label: 'Archive', onSelect: () => setStatus('ARCHIVED', 'Archive'), hidden: programme.status === 'ARCHIVED', danger: true },
            { label: 'Delete', danger: true, hidden: programme.applicationCount !== 0 || programme.intakeCount !== 0, onSelect: () => confirmation.ask({
              title: 'Delete ' + programme.code + '?', detail: 'This programme has no intakes or applications, so it can be removed permanently.', label: 'Delete programme', destructive: true,
              run: () => void action.run(async () => { await mutate(path, 'DELETE', undefined, session.csrfToken); toast('Deleted ' + programme.code); navigate('/programmes'); }),
            }) },
          ]} />}
        </>} />
      <ErrorMessage message={action.error} />
      <div className="metrics">
        <div className="metric"><span className="metric-icon" aria-hidden="true"><ClipboardList size={18} /></span><span><span className="metric-label">Submitted applications</span><span className="metric-value">{stats.submitted}</span></span></div>
        <div className="metric"><span className="metric-icon" data-tone="warning" aria-hidden="true"><ClipboardList size={18} /></span><span><span className="metric-label">Awaiting a decision</span><span className="metric-value">{stats.pending}</span></span></div>
        <div className="metric"><span className="metric-icon" data-tone="success" aria-hidden="true"><GraduationCap size={18} /></span><span><span className="metric-label">Enrolled</span><span className="metric-value">{stats.enrolled}</span></span></div>
      </div>
      <div className="detail-grid two">
        <Card className="panel">
          <h2>Programme details</h2>
          <Details items={[['Duration', programme.durationMonths + ' months'], ['Minimum qualification', qualificationNames[programme.minimumQualification]],
            ['Minimum GPA', programme.minimumGpa ? programme.minimumGpa + ' / 4.00' : 'None'], ['Created', dateOnly(programme.createdAt)], ['Last updated', dateOnly(programme.updatedAt)]]} />
          {programme.description && <><h3 className="subheading">Description</h3><p className="plain-text">{programme.description}</p></>}
          {programme.admissionRequirements && <><h3 className="subheading">Admission requirements</h3><p className="plain-text">{programme.admissionRequirements}</p></>}
        </Card>
        <Card className="panel">
          <h2>Admission statistics</h2>
          <StatusStack statuses={stats.statuses} href={status => '/applications' + query({ programmeId: programme.id, status })} />
          <div className="rates">
            <RateMeter label="Offer rate" value={stats.offerRate} numerator={stats.offersIssued} denominator={stats.submitted} definition="offers ÷ submitted" />
            <RateMeter label="Acceptance rate" value={stats.acceptanceRate} numerator={stats.offersAccepted} denominator={stats.offersIssued} definition="accepted ÷ offers" />
          </div>
        </Card>
      </div>
      <Card className="panel">
        <div className="panel-head"><h2>Admission intakes <span className="count">{programme.intakes.length}</span></h2>
          <Link className="text-link" to={'/applications' + query({ programmeId: programme.id })}>View all {programme.applicationCount} applications</Link></div>
        {programme.intakes.length ? <div className="table-wrap flush"><Table>
          <TableHeader><TableRow><TableHead scope="col">Intake</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col">Applications</TableHead><TableHead scope="col">Capacity</TableHead></TableRow></TableHeader>
          <TableBody>{programme.intakes.map(intake => <TableRow key={intake.id} className="clickable-row">
            <TableHead scope="row"><Link className="row-link" to={'/intakes/' + intake.id}>{intake.name}</Link></TableHead>
            <TableCell><Badge>{intake.status}</Badge></TableCell><TableCell>{intake.applications}</TableCell>
            <TableCell><CapacityBar capacity={intake.capacity} enrolled={intake.enrolled} accepted={intake.accepted} compact /></TableCell>
          </TableRow>)}</TableBody>
        </Table></div> : <p className="reading-empty">No intakes yet.</p>}
      </Card>
      <Card className="panel"><h2>Activity history</h2><ActivityHistory entityType="PROGRAMME" entityId={programme.id} /></Card>
      {confirmation.dialog}
    </>;
  }}</Resource>;
}

export function ProgrammeForm({ session }: { session: Session }) {
  const { programmeId } = useParams();
  const navigate = useNavigate();
  const path = programmeId ? '/programmes/' + programmeId : '';
  const state = useResource(() => Promise.all([programmeId ? get<Programme>(path) : Promise.resolve(null), get<string[]>('/programmes/faculties')]), path || 'new-programme');
  const action = useAction();
  if (!isAdmin(session)) return <Empty>Only administrators can create or edit programmes.</Empty>;
  return <Resource state={state}>{([programme, faculties]) => <>
    <Heading title={programme ? 'Edit ' + programme.code : 'New programme'} parent={programme ? { to: path, label: programme.name } : { to: '/programmes', label: 'Programmes' }} />
    <form className="form-sections" onSubmit={submit(form => void action.run(async () => {
      const gpa = field(form, 'minimumGpa');
      const body = {
        code: field(form, 'code'), name: field(form, 'name'), faculty: field(form, 'faculty'), qualificationType: field(form, 'qualificationType'),
        description: field(form, 'description'), durationMonths: Number(field(form, 'durationMonths')), admissionRequirements: field(form, 'admissionRequirements'),
        minimumQualification: field(form, 'minimumQualification'), minimumGpa: gpa === '' ? null : Number(gpa),
      };
      const saved = programme
        ? await mutate<Programme>(path, 'PATCH', { ...body, version: programme.version }, session.csrfToken)
        : await mutate<Programme>('/programmes', 'POST', body, session.csrfToken);
      toast(programme ? 'Programme updated' : 'Programme ' + saved.code + ' created');
      navigate('/programmes/' + saved.id);
    }))}>
      <Card className="panel form-section"><div><h2>Programme</h2><p>The code must be unique, e.g. BCS or DCE-PT.</p></div>
        <div className="form-grid">
          <label>Programme code<Input name="code" required pattern="[A-Za-z0-9\-]{2,16}" title="2–16 letters, digits or hyphens" defaultValue={programme?.code} className="upper" /></label>
          <label>Programme name<Input name="name" required maxLength={160} defaultValue={programme?.name} /></label>
          <label>Faculty or department<Input name="faculty" required maxLength={120} list="faculty-options" defaultValue={programme?.faculty} /></label>
          <label>Qualification type<NativeSelect name="qualificationType" defaultValue={programme?.qualificationType ?? 'BACHELOR'}>
            {Object.entries(qualificationTypeNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect></label>
          <label>Duration (months)<Input name="durationMonths" type="number" min={1} max={120} required defaultValue={programme?.durationMonths ?? 36} /></label>
          <label className="span-2">Description<Textarea name="description" rows={3} maxLength={4000} defaultValue={programme?.description} /></label>
        </div></Card>
      <Card className="panel form-section"><div><h2>Admission requirements</h2><p>Minimums are checked automatically on each application’s review page.</p></div>
        <div className="form-grid">
          <label>Minimum qualification<NativeSelect name="minimumQualification" defaultValue={programme?.minimumQualification ?? 'PRE_UNIVERSITY'}>
            {qualificationOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect></label>
          <label>Minimum GPA (optional)<Input name="minimumGpa" type="number" min="0" max="4" step="0.01" defaultValue={programme?.minimumGpa ?? ''} /></label>
          <label className="span-2">Requirements shown to reviewers<Textarea name="admissionRequirements" rows={4} maxLength={4000} defaultValue={programme?.admissionRequirements} /></label>
        </div></Card>
      <ErrorMessage message={action.error} />
      <div className="form-actions"><Button disabled={action.pending}>{programme ? 'Save changes' : 'Create programme'}</Button>
        <Button type="button" variant="outline" onClick={() => navigate(programme ? path : '/programmes')}>Cancel</Button></div>
      <datalist id="faculty-options">{faculties.map(value => <option key={value} value={value} />)}</datalist>
    </form>
  </>}</Resource>;
}
