import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Download, Pencil, Plus, UserRound } from 'lucide-react';
import { get, list, mutate, query, type Applicant, type ApplicationSummary, type Session } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Textarea } from './components/ui/textarea.js';
import {
  Badge, Details, Empty, ErrorMessage, Heading, Pagination, Resource, RowMenu, SearchField, SortHeader, calendarDate, dateOnly, dateTime, field,
  qualificationNames, qualificationOptions, submit, toast, useAction, useConfirmation, useResource,
} from './ui.js';
import { ActivityHistory } from './activity.js';

type SortKey = 'applicantNumber' | 'name' | 'email' | 'nationality' | 'qualification' | 'gpa' | 'status' | 'createdAt' | 'applications';
export const canEdit = (session: Session) => session.user.role !== 'VIEWER';

function download(path: string) {
  const link = document.createElement('a');
  link.href = '/api' + path;
  link.download = 'applicants.csv';
  document.body.append(link);
  link.click();
  link.remove();
}

export function ApplicantList({ session }: { session: Session }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [nationality, setNationality] = useState('');
  const [qualification, setQualification] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'createdAt', dir: 'desc' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const action = useAction();
  const confirmation = useConfirmation();
  const filters = { q: search, status, nationality, qualification, includeArchived: status === '' ? 'false' : undefined };
  const path = '/applicants' + query({ ...filters, page, sort: sort.key, dir: sort.dir });
  const state = useResource(() => list<Applicant>(path), path);
  const nationalities = useResource(() => get<string[]>('/applicants/nationalities'), 'nationalities');
  const reset = (apply: () => void) => { apply(); setPage(1); setSelected(new Set()); };
  const editor = canEdit(session);
  const onSort = (key: SortKey, dir: 'asc' | 'desc') => reset(() => setSort({ key, dir }));
  const archive = (applicant: Applicant, archived: boolean) => confirmation.ask({
    title: (archived ? 'Archive ' : 'Restore ') + applicant.fullName + '?',
    detail: archived ? 'Archived applicants are hidden from the default list and cannot receive new applications. Their history is kept.' : 'The applicant becomes active again.',
    label: archived ? 'Archive applicant' : 'Restore applicant', destructive: archived,
    run: () => void action.run(async () => {
      await mutate('/applicants/' + applicant.id + (archived ? '/archive' : '/restore'), 'POST', { version: applicant.version }, session.csrfToken);
      toast((archived ? 'Archived ' : 'Restored ') + applicant.fullName); state.reload();
    }),
  });
  const remove = (applicant: Applicant) => confirmation.ask({
    title: 'Delete ' + applicant.fullName + '?', detail: 'This applicant has no applications. The record is removed permanently; the activity log keeps a note of the deletion.',
    label: 'Delete applicant', destructive: true,
    run: () => void action.run(async () => { await mutate('/applicants/' + applicant.id, 'DELETE', undefined, session.csrfToken); toast('Deleted ' + applicant.fullName); state.reload(); }),
  });
  return <>
    <Heading title="Applicants" detail="Prospective students and their academic background."
      action={editor && <Button asChild><Link to="/applicants/new"><Plus aria-hidden="true" />New applicant</Link></Button>} />
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="Applicant directory">
      <div className="filters">
        <SearchField label="Search" placeholder="Name, email, phone or applicant ID" value={search} onChange={value => reset(() => setSearch(value))} />
        <label>Status<NativeSelect value={status} onChange={event => reset(() => setStatus(event.target.value))}>
          <NativeSelectOption value="">Active and on hold</NativeSelectOption><NativeSelectOption value="ACTIVE">Active</NativeSelectOption>
          <NativeSelectOption value="ON_HOLD">On hold</NativeSelectOption><NativeSelectOption value="ARCHIVED">Archived</NativeSelectOption>
        </NativeSelect></label>
        <label>Nationality<NativeSelect value={nationality} onChange={event => reset(() => setNationality(event.target.value))}>
          <NativeSelectOption value="">All nationalities</NativeSelectOption>
          {nationalities.value?.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Qualification<NativeSelect value={qualification} onChange={event => reset(() => setQualification(event.target.value))}>
          <NativeSelectOption value="">All qualifications</NativeSelectOption>
          {qualificationOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect></label>
      </div>
      {selected.size > 0 && <div className="bulk-bar" role="region" aria-label="Bulk actions">
        <strong>{selected.size} selected</strong>
        <Button size="sm" variant="outline" onClick={() => download('/applicants/export' + query({ ids: [...selected].join(',') }))}><Download aria-hidden="true" />Export selected (CSV)</Button>
        <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
      </div>}
      <Resource state={state}>{result => {
        const pageIds = result.data.map(item => item.id);
        const allSelected = pageIds.length > 0 && pageIds.every(value => selected.has(value));
        return <>
          {!result.data.length ? <Empty>No applicants match these filters.</Empty> : <div className="table-wrap"><Table>
            <TableHeader><TableRow>
              <th scope="col" className="select-cell"><input type="checkbox" aria-label="Select all applicants on this page" checked={allSelected}
                onChange={event => setSelected(current => { const next = new Set(current); pageIds.forEach(value => event.target.checked ? next.add(value) : next.delete(value)); return next; })} /></th>
              <SortHeader label="Applicant" column="name" sort={sort} onSort={onSort} />
              <SortHeader label="ID" column="applicantNumber" sort={sort} onSort={onSort} />
              <SortHeader label="Nationality" column="nationality" sort={sort} onSort={onSort} />
              <SortHeader label="Qualification" column="qualification" sort={sort} onSort={onSort} />
              <SortHeader label="GPA" column="gpa" sort={sort} onSort={onSort} />
              <SortHeader label="Applications" column="applications" sort={sort} onSort={onSort} />
              <SortHeader label="Status" column="status" sort={sort} onSort={onSort} />
              <SortHeader label="Created" column="createdAt" sort={sort} onSort={onSort} />
              <TableHead scope="col"><span className="sr-only">Actions</span></TableHead>
            </TableRow></TableHeader>
            <TableBody>{result.data.map(applicant => <TableRow key={applicant.id} className="clickable-row" data-selected={selected.has(applicant.id) || undefined}>
              <TableCell className="select-cell"><input type="checkbox" aria-label={'Select ' + applicant.fullName} checked={selected.has(applicant.id)}
                onChange={event => setSelected(current => { const next = new Set(current); if (event.target.checked) next.add(applicant.id); else next.delete(applicant.id); return next; })} /></TableCell>
              <TableHead scope="row"><Link className="row-link table-item" to={'/applicants/' + applicant.id}>
                <span className="avatar person-avatar" aria-hidden="true">{applicant.firstName[0]}{applicant.lastName[0]}</span>
                <span><strong>{applicant.fullName}</strong><small>{applicant.email}</small></span></Link></TableHead>
              <TableCell className="mono">{applicant.applicantNumber}</TableCell>
              <TableCell>{applicant.nationality}</TableCell>
              <TableCell>{qualificationNames[applicant.highestQualification]}</TableCell>
              <TableCell>{applicant.gpa ?? '—'}</TableCell>
              <TableCell>{applicant.applicationCount}</TableCell>
              <TableCell><Badge>{applicant.status}</Badge></TableCell>
              <TableCell>{dateOnly(applicant.createdAt)}</TableCell>
              <TableCell className="menu-cell"><RowMenu label={'Actions for ' + applicant.fullName} items={[
                { label: 'View profile', onSelect: () => navigate('/applicants/' + applicant.id) },
                { label: 'Edit', onSelect: () => navigate('/applicants/' + applicant.id + '/edit'), hidden: !editor || applicant.status === 'ARCHIVED' },
                { label: 'New application', onSelect: () => navigate('/applications/new' + query({ applicantId: applicant.id })), hidden: !editor || applicant.status === 'ARCHIVED' },
                { label: 'Archive', onSelect: () => archive(applicant, true), hidden: !editor || applicant.status === 'ARCHIVED', danger: true },
                { label: 'Restore', onSelect: () => archive(applicant, false), hidden: !editor || applicant.status !== 'ARCHIVED' },
                { label: 'Delete', onSelect: () => remove(applicant), hidden: !editor || applicant.applicationCount !== 0, danger: true },
              ]} /></TableCell>
            </TableRow>)}</TableBody>
          </Table></div>}
          <div className="directory-foot">
            <Button size="sm" variant="ghost" disabled={!result.pagination.total} onClick={() => download('/applicants/export' + query(filters))}><Download aria-hidden="true" />Export all {result.pagination.total} matching</Button>
            <Pagination page={result} onPage={value => { setPage(value); }} />
          </div>
        </>;
      }}</Resource>
    </section>
    {confirmation.dialog}
  </>;
}

export function ApplicantDetail({ session }: { session: Session }) {
  const { applicantId } = useParams();
  const path = '/applicants/' + applicantId;
  const state = useResource(() => Promise.all([get<Applicant>(path), list<ApplicationSummary>('/applications' + query({ applicantId, pageSize: 100, sort: 'updatedAt' }))]), path);
  const action = useAction();
  const confirmation = useConfirmation();
  const [editingNotes, setEditingNotes] = useState(false);
  const editor = canEdit(session);
  return <Resource state={state}>{([applicant, applications]) => {
    const age = Math.floor((Date.now() - Date.parse(applicant.dateOfBirth)) / (365.25 * 86_400_000));
    const archived = applicant.status === 'ARCHIVED';
    return <>
      <Heading title={applicant.fullName} parent={{ to: '/applicants', label: 'Applicants' }}
        detail={<><span className="mono">{applicant.applicantNumber}</span> · Added {dateOnly(applicant.createdAt)} · Updated {dateTime(applicant.updatedAt)}</>}
        action={<>
          <Badge>{applicant.status}</Badge>
          {editor && !archived && <Button variant="outline" asChild><Link to={path + '/edit'}><Pencil aria-hidden="true" />Edit</Link></Button>}
          {editor && !archived && <Button asChild><Link to={'/applications/new' + query({ applicantId: applicant.id })}><Plus aria-hidden="true" />New application</Link></Button>}
          {editor && <Button variant="outline" disabled={action.pending} onClick={() => confirmation.ask({
            title: (archived ? 'Restore ' : 'Archive ') + applicant.fullName + '?',
            detail: archived ? 'The applicant becomes active again.' : 'Archived applicants are hidden from the default list and cannot receive new applications. Their history is kept.',
            label: archived ? 'Restore applicant' : 'Archive applicant', destructive: !archived,
            run: () => void action.run(async () => {
              await mutate(path + (archived ? '/restore' : '/archive'), 'POST', { version: applicant.version }, session.csrfToken);
              toast((archived ? 'Restored ' : 'Archived ') + applicant.fullName); state.reload();
            }),
          })}>{archived ? 'Restore' : 'Archive'}</Button>}
        </>} />
      <ErrorMessage message={action.error} />
      <div className="detail-grid">
        <Card className="panel"><h2>Personal information</h2><Details items={[
          ['First name', applicant.firstName], ['Last name', applicant.lastName], ['Date of birth', calendarDate(applicant.dateOfBirth) + ' (age ' + age + ')'],
          ['Nationality', applicant.nationality],
        ]} /></Card>
        <Card className="panel"><h2>Contact information</h2><Details items={[
          ['Email', <a href={'mailto:' + applicant.email}>{applicant.email}</a>], ['Phone', applicant.phone], ['Address', applicant.address],
        ]} /></Card>
        <Card className="panel"><h2>Academic qualifications</h2><Details items={[
          ['Highest qualification', qualificationNames[applicant.highestQualification]], ['Previous institution', applicant.previousInstitution],
          ['GPA', applicant.gpa ? applicant.gpa + ' / 4.00' : 'Not provided'],
        ]} /></Card>
      </div>
      <Card className="panel">
        <div className="panel-head"><h2>Applications <span className="count">{applications.data.length}</span></h2>
          {editor && !archived && <Button size="sm" variant="outline" asChild><Link to={'/applications/new' + query({ applicantId: applicant.id })}><Plus aria-hidden="true" />New application</Link></Button>}</div>
        {applications.data.length ? <div className="table-wrap flush"><Table>
          <TableHeader><TableRow><TableHead scope="col">Reference</TableHead><TableHead scope="col">Programme</TableHead><TableHead scope="col">Intake</TableHead><TableHead scope="col">Submitted</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader>
          <TableBody>{applications.data.map(item => <TableRow key={item.id} className="clickable-row">
            <TableHead scope="row"><Link className="row-link mono" to={'/applications/' + item.id}>{item.reference}</Link></TableHead>
            <TableCell>{item.programme.code} · {item.programme.name}</TableCell><TableCell>{item.intake.name}</TableCell>
            <TableCell>{item.submittedAt ? dateOnly(item.submittedAt) : 'Not submitted'}</TableCell><TableCell><Badge>{item.status}</Badge></TableCell>
          </TableRow>)}</TableBody>
        </Table></div> : <p className="reading-empty">No applications yet.</p>}
      </Card>
      <div className="detail-grid two">
        <Card className="panel">
          <div className="panel-head"><h2>Internal notes</h2>{editor && !archived && !editingNotes && <Button size="sm" variant="ghost" onClick={() => setEditingNotes(true)}><Pencil aria-hidden="true" />Edit</Button>}</div>
          {editingNotes ? <form className="stack" onSubmit={submit(form => void action.run(async () => {
            await mutate(path, 'PATCH', { remarks: field(form, 'remarks'), version: applicant.version }, session.csrfToken);
            setEditingNotes(false); toast('Notes saved'); state.reload();
          }))}>
            <label className="sr-label">Internal notes<Textarea name="remarks" rows={5} maxLength={4000} defaultValue={applicant.remarks} autoFocus /></label>
            <div className="actions"><Button disabled={action.pending}>Save notes</Button><Button type="button" variant="outline" onClick={() => setEditingNotes(false)}>Cancel</Button></div>
          </form> : applicant.remarks ? <p className="plain-text">{applicant.remarks}</p> : <p className="reading-empty">No internal notes.</p>}
        </Card>
        <Card className="panel"><h2>Activity history</h2><ActivityHistory entityType="APPLICANT" entityId={applicant.id} /></Card>
      </div>
      {confirmation.dialog}
    </>;
  }}</Resource>;
}

export function ApplicantForm({ session }: { session: Session }) {
  const { applicantId } = useParams();
  const navigate = useNavigate();
  const path = applicantId ? '/applicants/' + applicantId : '';
  const state = useResource(() => applicantId ? get<Applicant>(path) : Promise.resolve(null), path || 'new-applicant');
  const action = useAction();
  if (!canEdit(session)) return <Empty>Your role can view applicants but not change them.</Empty>;
  return <Resource state={state}>{applicant => <>
    <Heading title={applicant ? 'Edit ' + applicant.fullName : 'New applicant'} parent={applicant ? { to: path, label: applicant.fullName } : { to: '/applicants', label: 'Applicants' }}
      detail="Use fictional details in demonstrations. Fields marked optional can be left blank." />
    <form className="form-sections" onSubmit={submit(form => void action.run(async () => {
      const gpa = field(form, 'gpa');
      const body = {
        firstName: field(form, 'firstName'), lastName: field(form, 'lastName'), email: field(form, 'email'), phone: field(form, 'phone'),
        dateOfBirth: field(form, 'dateOfBirth'), nationality: field(form, 'nationality'), address: field(form, 'address'),
        previousInstitution: field(form, 'previousInstitution'), highestQualification: field(form, 'highestQualification'),
        gpa: gpa === '' ? null : Number(gpa), status: field(form, 'status'), remarks: field(form, 'remarks'),
      };
      const saved = applicant
        ? await mutate<Applicant>(path, 'PATCH', { ...body, version: applicant.version }, session.csrfToken)
        : await mutate<Applicant>('/applicants', 'POST', body, session.csrfToken);
      toast(applicant ? 'Applicant updated' : 'Applicant ' + saved.applicantNumber + ' created');
      navigate('/applicants/' + saved.id);
    }))}>
      <Card className="panel form-section"><div><h2><UserRound size={17} aria-hidden="true" /> Personal information</h2><p>Legal name and identity details.</p></div>
        <div className="form-grid">
          <label>First name<Input name="firstName" required maxLength={80} defaultValue={applicant?.firstName} autoComplete="off" /></label>
          <label>Last name<Input name="lastName" required maxLength={80} defaultValue={applicant?.lastName} autoComplete="off" /></label>
          <label>Date of birth<Input name="dateOfBirth" type="date" required defaultValue={applicant?.dateOfBirth} /></label>
          <label>Nationality<Input name="nationality" required maxLength={60} defaultValue={applicant?.nationality} list="nationality-options" /></label>
        </div></Card>
      <Card className="panel form-section"><div><h2>Contact information</h2><p>How the admissions office reaches the applicant.</p></div>
        <div className="form-grid">
          <label>Email address<Input name="email" type="email" required maxLength={254} defaultValue={applicant?.email} autoComplete="off" /></label>
          <label>Phone number<Input name="phone" type="tel" required pattern="\+?[0-9 ()\-]{7,20}" title="7–20 digits, spaces, brackets or hyphens" defaultValue={applicant?.phone} /></label>
          <label className="span-2">Address<Textarea name="address" required rows={2} maxLength={300} defaultValue={applicant?.address} /></label>
        </div></Card>
      <Card className="panel form-section"><div><h2>Academic qualifications</h2><p>Compared against each programme’s minimum requirements during review.</p></div>
        <div className="form-grid">
          <label>Previous institution<Input name="previousInstitution" required maxLength={160} defaultValue={applicant?.previousInstitution} /></label>
          <label>Highest qualification<NativeSelect name="highestQualification" required defaultValue={applicant?.highestQualification ?? 'PRE_UNIVERSITY'}>
            {qualificationOptions.map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
          </NativeSelect></label>
          <label>GPA (0.00–4.00, optional)<Input name="gpa" type="number" min="0" max="4" step="0.01" defaultValue={applicant?.gpa ?? ''} /></label>
        </div></Card>
      <Card className="panel form-section"><div><h2>Status and internal notes</h2><p>Notes are visible to admissions staff only.</p></div>
        <div className="form-grid">
          <label>Applicant status<NativeSelect name="status" defaultValue={applicant?.status === 'ON_HOLD' ? 'ON_HOLD' : 'ACTIVE'}>
            <NativeSelectOption value="ACTIVE">Active</NativeSelectOption><NativeSelectOption value="ON_HOLD">On hold</NativeSelectOption>
          </NativeSelect></label>
          <label className="span-2">Internal notes (optional)<Textarea name="remarks" rows={3} maxLength={4000} defaultValue={applicant?.remarks} /></label>
        </div></Card>
      <ErrorMessage message={action.error} />
      <div className="form-actions"><Button disabled={action.pending}>{action.pending ? 'Saving…' : applicant ? 'Save changes' : 'Create applicant'}</Button>
        <Button type="button" variant="outline" onClick={() => navigate(applicant ? path : '/applicants')}>Cancel</Button></div>
      <datalist id="nationality-options">{['Singaporean', 'Malaysian', 'Indonesian', 'Indian', 'Chinese', 'Vietnamese', 'Filipino', 'Thai', 'Myanmar', 'Korean', 'Japanese', 'Australian', 'British'].map(value => <option key={value} value={value} />)}</datalist>
    </form>
  </>}</Resource>;
}
