import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './components/ui/table.js';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, CircleCheck, FileText, Grid2X2, Plus, UsersRound } from 'lucide-react';
import { Card } from './components/ui/card.js';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './components/ui/dialog.js';
import { get, list, mutate, type AdminModule, type AdminUser, type AuditEvent, type Enrolment } from './api.js';
import { Badge, Empty, ErrorMessage, Heading, Pagination, Resource, SearchField, dateTime, field, submit, useAction, useConfirmation, useResource } from './ui.js';

function AccountPicker({ role, label, initial }: { role: 'STUDENT' | 'LECTURER'; label: string; initial?: { id: string; displayName: string } }) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(initial?.id ?? '');
  const path = '/admin/users?' + new URLSearchParams({ role, isActive: 'true', q: query, pageSize: '25' });
  const state = useResource(() => list<AdminUser>(path), path);
  return <fieldset className="picker"><legend>{label}</legend>
    <label>Search {role.toLowerCase()} accounts<Input value={query} onChange={event => { setQuery(event.target.value); setSelection(initial?.id ?? ''); }} /></label>
    <label>{label}<NativeSelect name={role === 'STUDENT' ? 'studentId' : 'lecturerId'} value={selection} onChange={event => setSelection(event.target.value)} required>
      <NativeSelectOption value="">Choose an account</NativeSelectOption>
      {initial && !state.value?.data.some(user => user.id === initial.id) && <NativeSelectOption value={initial.id}>{initial.displayName}</NativeSelectOption>}
      {state.value?.data.map(user => <NativeSelectOption key={user.id} value={user.id}>{user.displayName} · {user.email}</NativeSelectOption>)}
    </NativeSelect></label>
    {state.pending && <small role="status">Loading accounts…</small>}
    {state.error && <><ErrorMessage message={state.error} /><Button type="button" variant="outline" onClick={state.reload}>Retry</Button></>}
  </fieldset>;
}

function TemporaryPassword({ password, close }: { password: string; close: () => void }) {
  return <Dialog open onOpenChange={open => { if (!open) close(); }}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Temporary password</DialogTitle>
        <DialogDescription>Share this password privately with the account holder. It is shown once.</DialogDescription>
      </DialogHeader>
      <code className="temporary-password">{password}</code>
      <DialogFooter><DialogClose asChild><Button>Done</Button></DialogClose></DialogFooter>
    </DialogContent>
  </Dialog>;
}

export function AdminUsers({ csrf }: { csrf: string }) {
  const [mode, setMode] = useState<'new' | AdminUser | null>(null);
  const [password, setPassword] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [isActive, setIsActive] = useState('');
  const action = useAction();
  const confirmation = useConfirmation();
  const path = '/admin/users?' + new URLSearchParams({ page: String(page), q: search, ...(role ? { role } : {}), ...(isActive ? { isActive } : {}) });
  const state = useResource(() => list<AdminUser>(path), path);
  const selected = typeof mode === 'object' ? mode : null;
  return <>
    <Heading title="User accounts" detail="Manage lecturer and student access." action={<Button onClick={() => { action.clear(); setMode('new'); }}><Plus size={17} aria-hidden="true"/>New user</Button>} />
    {mode && <section className="panel">
      <h2>{selected ? 'Edit user' : 'New user'}</h2>
      <form className="stack" key={selected?.id ?? 'new'} onSubmit={submit(form => void action.run(async () => {
        const displayName = field(form, 'displayName');
        if (selected) {
          await mutate('/admin/users/' + selected.id, 'PATCH', { displayName }, csrf);
        } else {
          const created = await mutate<{ temporaryPassword: string }>('/admin/users', 'POST', { displayName, email: field(form, 'email'), role: field(form, 'role') }, csrf);
          setPassword(created.temporaryPassword);
        }
        setMode(null);
        state.reload();
      }))}>
        <label>Display name<Input required name="displayName" maxLength={120} defaultValue={selected?.displayName} /></label>
        {!selected && <>
          <label>Email<Input name="email" type="email" required maxLength={254} /></label>
          <label>Account role<NativeSelect name="role"><NativeSelectOption value="STUDENT">Student</NativeSelectOption><NativeSelectOption value="LECTURER">Lecturer</NativeSelectOption></NativeSelect></label>
        </>}
        <div className="actions"><Button disabled={action.pending}>{selected ? 'Save user' : 'Create user'}</Button><Button type="button" variant="outline" onClick={() => setMode(null)}>Cancel</Button></div>
      </form>
    </section>}
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="User directory">
    <div className="filters">
      <SearchField label="Search users" placeholder="Name or email address" value={search} onChange={value => { setSearch(value); setPage(1); }} />
      <label>Role<NativeSelect value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><NativeSelectOption value="">All roles</NativeSelectOption><NativeSelectOption value="ADMIN">Administrator</NativeSelectOption><NativeSelectOption value="LECTURER">Lecturer</NativeSelectOption><NativeSelectOption value="STUDENT">Student</NativeSelectOption></NativeSelect></label>
      <label>Account status<NativeSelect value={isActive} onChange={event => { setIsActive(event.target.value); setPage(1); }}><NativeSelectOption value="">All statuses</NativeSelectOption><NativeSelectOption value="true">Active</NativeSelectOption><NativeSelectOption value="false">Disabled</NativeSelectOption></NativeSelect></label>
    </div>
    <Resource state={state}>{result => <>
      {!result.data.length ? <Empty>No users match this search.</Empty> : <div className="table-wrap"><Table>
        <TableHeader><TableRow><TableHead scope="col">Name</TableHead><TableHead scope="col">Role</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{result.data.map(user => <TableRow key={user.id}><TableHead scope="row"><div className="table-item"><span className="item-icon"><UsersRound size={16} aria-hidden="true"/></span><span>{user.displayName}<small>{user.email}</small></span></div></TableHead><TableCell><Badge>{user.role}</Badge></TableCell><TableCell><Badge>{user.isActive ? 'ACTIVE' : 'DISABLED'}</Badge></TableCell><TableCell><div className="actions">
          <Button variant="outline" onClick={() => { action.clear(); setMode(user); }}>Edit</Button>
          {user.role !== 'ADMIN' && <>
            <Button variant="outline" size="sm" disabled={action.pending} onClick={() => confirmation.ask({
              title: (user.isActive ? 'Disable ' : 'Reactivate ') + user.displayName + '?', label: user.isActive ? 'Disable account' : 'Reactivate account',
              detail: user.isActive ? 'This person will be signed out and lose access to the LMS.' : 'This person will be able to sign in again.',
              destructive: user.isActive,
              run: () => void action.run(async () => { await mutate('/admin/users/' + user.id, 'PATCH', { isActive: !user.isActive }, csrf); state.reload(); }),
            })}>{user.isActive ? 'Disable' : 'Reactivate'}</Button>
            <Button variant="outline" size="sm" disabled={action.pending} onClick={() => confirmation.ask({
              title: 'Reset password for ' + user.displayName + '?', label: 'Reset password',
              detail: 'This ends existing sessions and generates a temporary password for their next sign-in.',
              run: () => void action.run(async () => {
                const reset = await mutate<{ temporaryPassword: string }>('/admin/users/' + user.id + '/reset-password', 'POST', {}, csrf);
                setPassword(reset.temporaryPassword); state.reload();
              }),
            })}>Reset password</Button>
          </>}
        </div></TableCell></TableRow>)}</TableBody>
      </Table></div>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
    </section>
    {password && <TemporaryPassword password={password} close={() => setPassword('')} />}
    {confirmation.dialog}
  </>;
}

export function AdminModules({ csrf }: { csrf: string }) {
  const [mode, setMode] = useState<'new' | AdminModule | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const action = useAction();
  const confirmation = useConfirmation();
  const query = '/admin/modules?' + new URLSearchParams({ page: String(page), q: search, ...(status ? { status } : {}) });
  const state = useResource(() => list<AdminModule>(query), query);
  const stats = useResource(async () => {
    const results = await Promise.all(['', 'ACTIVE', 'DRAFT'].map(status => list<AdminModule>('/admin/modules?pageSize=1' + (status ? '&status=' + status : ''))));
    return results.map(result => result.pagination.total);
  }, 'module-metrics');
  function reload() { state.reload(); stats.reload(); }
  const selected = typeof mode === 'object' ? mode : null;
  return <>
    <Heading title="Modules" detail="Manage teaching modules, lecturer assignments and enrolments." action={<Button onClick={() => { action.clear(); setMode('new'); }}><Plus size={17} aria-hidden="true"/>New module</Button>} />
    {!stats.error && <section className="metrics" aria-label="Module overview">
      {[
        { label: 'Total modules', Icon: Grid2X2, tone: '' },
        { label: 'Active modules', Icon: CircleCheck, tone: 'active' },
        { label: 'Draft modules', Icon: FileText, tone: 'draft' },
      ].map(({ label, Icon, tone }, index) => <Card className="metric" key={label}>
        <span className={'metric-icon ' + tone}><Icon size={19} aria-hidden="true" /></span>
        <span><span className="metric-label">{label}</span><strong className="metric-value">{stats.value?.[index] ?? '—'}</strong></span>
      </Card>)}
    </section>}
    {mode && <section className="panel">
      <h2>{selected ? 'Edit module' : 'New module'}</h2>
      <form className="stack" key={selected?.id ?? 'new'} onSubmit={submit(form => void action.run(async () => {
        const edit = selected ? { version: selected.version } : {};
        const fields = selected?.status === 'ACTIVE' ? {} : { code: field(form, 'code'), term: field(form, 'term') };
        await mutate(selected ? '/admin/modules/' + selected.id : '/admin/modules', selected ? 'PATCH' : 'POST', {
          ...fields, ...edit, name: field(form, 'name'), description: field(form, 'description'), lecturerId: field(form, 'lecturerId'),
        }, csrf);
        setMode(null);
        reload();
      }))}>
        <div className="form-row">
          <label>Module code<Input name="code" required pattern="[A-Za-z0-9\\-]{2,24}" defaultValue={selected?.code} disabled={selected?.status === 'ACTIVE'} /></label>
          <label>Term<Input name="term" required maxLength={40} defaultValue={selected?.term} disabled={selected?.status === 'ACTIVE'} /></label>
        </div>
        <label>Module name<Input name="name" required maxLength={120} defaultValue={selected?.name} /></label>
        <label>Description<Textarea name="description" maxLength={2000} defaultValue={selected?.description} /></label>
        <AccountPicker role="LECTURER" label="Assigned lecturer" initial={selected?.lecturer} />
        <div className="actions"><Button disabled={action.pending}>{selected ? 'Save module' : 'Create module'}</Button><Button type="button" variant="outline" onClick={() => setMode(null)}>Cancel</Button></div>
      </form>
    </section>}
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="Module directory">
    <div className="filters">
      <SearchField label="Search modules" placeholder="Module code, name or term" value={search} onChange={value => { setSearch(value); setPage(1); }} />
      <label>Status<NativeSelect value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><NativeSelectOption value="">All statuses</NativeSelectOption><NativeSelectOption value="DRAFT">Draft</NativeSelectOption><NativeSelectOption value="ACTIVE">Active</NativeSelectOption><NativeSelectOption value="ARCHIVED">Archived</NativeSelectOption></NativeSelect></label>
    </div>
    <Resource state={state}>{result => <>
      {!result.data.length ? <Empty>No modules match this search.</Empty> : <div className="table-wrap"><Table>
        <TableHeader><TableRow><TableHead scope="col">Module</TableHead><TableHead scope="col">Lecturer</TableHead><TableHead scope="col">Status</TableHead><TableHead scope="col">Actions</TableHead></TableRow></TableHeader>
        <TableBody>{result.data.map(module => <TableRow key={module.id}><TableHead scope="row"><div className="table-item"><span className="item-icon"><BookOpen size={17} aria-hidden="true"/></span><span>{module.name}<small>{module.code} · {module.term}</small></span></div></TableHead><TableCell>{module.lecturer.displayName}</TableCell><TableCell><Badge>{module.status}</Badge></TableCell><TableCell><div className="actions">
          <Button asChild variant="outline" size="sm"><Link to={'/admin/modules/' + module.id + '/enrolments'}>Enrolments ({module.activeEnrolmentCount})</Link></Button>
          {module.status !== 'ARCHIVED' && <Button variant="outline" onClick={() => { action.clear(); setMode(module); }}>Edit</Button>}
          {module.status === 'DRAFT' && <Button disabled={action.pending} onClick={() => void action.run(async () => {
            await mutate('/admin/modules/' + module.id + '/activate', 'POST', { version: module.version }, csrf); reload();
          })}>Activate</Button>}
          {module.status === 'ACTIVE' && <Button variant="outline" size="sm" disabled={action.pending} onClick={() => confirmation.ask({
            title: 'Archive ' + module.name + '?', label: 'Archive module', detail: 'The module will permanently become read-only.', destructive: true,
            run: () => void action.run(async () => { await mutate('/admin/modules/' + module.id + '/archive', 'POST', { version: module.version, confirmUnpublishedGrades: false }, csrf); reload(); }),
          })}>Archive</Button>}
        </div></TableCell></TableRow>)}</TableBody>
      </Table></div>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
    </section>
    {confirmation.dialog}
  </>;
}

export function AdminEnrolments({ csrf }: { csrf: string }) {
  const { moduleId } = useParams();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [pickerKey, setPickerKey] = useState(0);
  const action = useAction();
  const confirmation = useConfirmation();
  const modulePath = '/admin/modules/' + moduleId;
  const path = modulePath + '/enrolments';
  const query = path + '?' + new URLSearchParams({ page: String(page), ...(status ? { status } : {}) });
  const module = useResource(() => get<AdminModule>(modulePath), modulePath);
  const state = useResource(() => list<Enrolment>(query), query);
  return <Resource state={module}>{item => <>
    <Heading title="Enrolments" detail={item.code + ' · ' + item.name} parent={{ to: '/admin/modules', label: 'Modules' }} action={<Badge>{item.status}</Badge>} />
    {item.status === 'ARCHIVED' ? <Empty>This archived module is read-only.</Empty> : <section className="panel">
      <h2>Add a student</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(path, 'POST', { studentId: field(form, 'studentId') }, csrf);
        setPickerKey(key => key + 1); state.reload();
      }))}><AccountPicker key={pickerKey} role="STUDENT" label="Student" /><div><Button disabled={action.pending}>Enrol student</Button></div></form>
    </section>}
    <ErrorMessage message={action.error} />
    <div className="filters"><label>Enrolment status<NativeSelect value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><NativeSelectOption value="">All statuses</NativeSelectOption><NativeSelectOption value="ACTIVE">Active</NativeSelectOption><NativeSelectOption value="WITHDRAWN">Withdrawn</NativeSelectOption></NativeSelect></label></div>
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><Table><TableHeader><TableRow><TableHead scope="col">Student</TableHead><TableHead scope="col">Status</TableHead>{item.status !== 'ARCHIVED' && <TableHead scope="col">Actions</TableHead>}</TableRow></TableHeader><TableBody>
        {result.data.map(row => <TableRow key={row.studentId}><TableHead scope="row">{row.displayName}</TableHead><TableCell><Badge>{row.status}</Badge></TableCell>
          {item.status !== 'ARCHIVED' && <TableCell><Button variant="outline" size="sm" disabled={action.pending} onClick={() => {
            const method = row.status === 'ACTIVE' ? 'withdraw' : 'reactivate';
            confirmation.ask({
              title: (method === 'withdraw' ? 'Withdraw ' : 'Reactivate ') + row.displayName + '?', label: method === 'withdraw' ? 'Withdraw student' : 'Reactivate enrolment',
              detail: method === 'withdraw' ? 'The student will lose access to this module. Their learning records will be kept.' : 'This restores access to the module and its existing learning records.',
              destructive: method === 'withdraw',
              run: () => void action.run(async () => { await mutate(path + '/' + row.studentId + '/' + method, 'POST', {}, csrf); state.reload(); }),
            });
          }}>{row.status === 'ACTIVE' ? 'Withdraw' : 'Reactivate'}</Button></TableCell>}
        </TableRow>)}
      </TableBody></Table></div> : <Empty>No enrolments match this view.</Empty>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
    {confirmation.dialog}
  </>}</Resource>;
}

export function AdminAudit() {
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState('');
  const path = '/admin/audit-events?' + new URLSearchParams({ page: String(page), ...(eventType.trim() ? { eventType } : {}) });
  const state = useResource(() => list<AuditEvent>(path), path);
  return <>
    <Heading title="Audit log" detail="Account and module administration events." />
    <div className="filters"><label>Event type<Input value={eventType} placeholder="e.g. MODULE_CREATED" onChange={event => { setEventType(event.target.value); setPage(1); }} /></label></div>
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><Table><TableHeader><TableRow><TableHead scope="col">Event</TableHead><TableHead scope="col">Entity type</TableHead><TableHead scope="col">Time</TableHead></TableRow></TableHeader><TableBody>
        {result.data.map(row => <TableRow key={row.id}><TableHead scope="row">{row.eventType.replaceAll('_', ' ')}</TableHead><TableCell>{row.entityType}</TableCell><TableCell>{dateTime(row.occurredAt)}</TableCell></TableRow>)}
      </TableBody></Table></div> : <Empty>No audit events match this view.</Empty>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
  </>;
}
