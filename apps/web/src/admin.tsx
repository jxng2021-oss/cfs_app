import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { BookOpen, CircleCheck, FileText, Grid2X2, Plus, UsersRound } from 'lucide-react';
import { get, list, mutate, type AdminModule, type AdminUser, type AuditEvent, type Enrolment } from './api.js';
import { Badge, Empty, ErrorMessage, Heading, Pagination, Resource, SearchField, dateTime, field, submit, useAction, useResource } from './ui.js';

function AccountPicker({ role, label, initial }: { role: 'STUDENT' | 'LECTURER'; label: string; initial?: { id: string; displayName: string } }) {
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(initial?.id ?? '');
  const path = '/admin/users?' + new URLSearchParams({ role, isActive: 'true', q: query, pageSize: '25' });
  const state = useResource(() => list<AdminUser>(path), path);
  return <fieldset className="picker"><legend>{label}</legend>
    <label>Search {role.toLowerCase()} accounts<input value={query} onChange={event => { setQuery(event.target.value); setSelection(initial?.id ?? ''); }} /></label>
    <label>{label}<select name={role === 'STUDENT' ? 'studentId' : 'lecturerId'} value={selection} onChange={event => setSelection(event.target.value)} required>
      <option value="">Choose an account</option>
      {initial && !state.value?.data.some(user => user.id === initial.id) && <option value={initial.id}>{initial.displayName}</option>}
      {state.value?.data.map(user => <option key={user.id} value={user.id}>{user.displayName} · {user.email}</option>)}
    </select></label>
    {state.pending && <small role="status">Loading accounts…</small>}
    {state.error && <><ErrorMessage message={state.error} /><button type="button" className="secondary" onClick={state.reload}>Retry</button></>}
  </fieldset>;
}

function TemporaryPassword({ password, close }: { password: string; close: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog ref={ref} onClose={close} aria-labelledby="temporary-title">
    <h2 id="temporary-title">Temporary password</h2>
    <p>Share this password privately with the account holder. It is shown once.</p>
    <code className="temporary-password">{password}</code>
    <form method="dialog"><button>Done</button></form>
  </dialog>;
}

export function AdminUsers({ csrf }: { csrf: string }) {
  const [mode, setMode] = useState<'new' | AdminUser | null>(null);
  const [password, setPassword] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [isActive, setIsActive] = useState('');
  const action = useAction();
  const path = '/admin/users?' + new URLSearchParams({ page: String(page), q: search, ...(role ? { role } : {}), ...(isActive ? { isActive } : {}) });
  const state = useResource(() => list<AdminUser>(path), path);
  const selected = typeof mode === 'object' ? mode : null;
  return <>
    <Heading title="User accounts" detail="Manage lecturer and student access." action={<button onClick={() => { action.clear(); setMode('new'); }}><Plus size={17} aria-hidden="true"/>New user</button>} />
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
        <label>Display name<input required name="displayName" maxLength={120} defaultValue={selected?.displayName} /></label>
        {!selected && <>
          <label>Email<input name="email" type="email" required maxLength={254} /></label>
          <label>Account role<select name="role"><option value="STUDENT">Student</option><option value="LECTURER">Lecturer</option></select></label>
        </>}
        <div className="actions"><button disabled={action.pending}>{selected ? 'Save user' : 'Create user'}</button><button type="button" className="secondary" onClick={() => setMode(null)}>Cancel</button></div>
      </form>
    </section>}
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="User directory">
    <div className="filters">
      <SearchField label="Search users" placeholder="Name or email address" value={search} onChange={value => { setSearch(value); setPage(1); }} />
      <label>Role<select value={role} onChange={event => { setRole(event.target.value); setPage(1); }}><option value="">All roles</option><option value="ADMIN">Administrator</option><option value="LECTURER">Lecturer</option><option value="STUDENT">Student</option></select></label>
      <label>Account status<select value={isActive} onChange={event => { setIsActive(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="true">Active</option><option value="false">Disabled</option></select></label>
    </div>
    <Resource state={state}>{result => <>
      {!result.data.length ? <Empty>No users match this search.</Empty> : <div className="table-wrap"><table>
        <thead><tr><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody>{result.data.map(user => <tr key={user.id}><th scope="row"><div className="table-item"><span className="item-icon"><UsersRound size={16} aria-hidden="true"/></span><span>{user.displayName}<small>{user.email}</small></span></div></th><td><Badge>{user.role}</Badge></td><td><Badge>{user.isActive ? 'ACTIVE' : 'DISABLED'}</Badge></td><td><div className="actions">
          <button className="secondary" onClick={() => { action.clear(); setMode(user); }}>Edit</button>
          {user.role !== 'ADMIN' && <>
            <button className="secondary" disabled={action.pending} onClick={() => {
              if (!window.confirm((user.isActive ? 'Disable ' : 'Reactivate ') + user.displayName + '?')) return;
              void action.run(async () => { await mutate('/admin/users/' + user.id, 'PATCH', { isActive: !user.isActive }, csrf); state.reload(); });
            }}>{user.isActive ? 'Disable' : 'Reactivate'}</button>
            <button className="secondary" disabled={action.pending} onClick={() => {
              if (!window.confirm('Reset the password for ' + user.displayName + '?')) return;
              void action.run(async () => {
                const reset = await mutate<{ temporaryPassword: string }>('/admin/users/' + user.id + '/reset-password', 'POST', {}, csrf);
                setPassword(reset.temporaryPassword); state.reload();
              });
            }}>Reset password</button>
          </>}
        </div></td></tr>)}</tbody>
      </table></div>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
    </section>
    {password && <TemporaryPassword password={password} close={() => setPassword('')} />}
  </>;
}

export function AdminModules({ csrf }: { csrf: string }) {
  const [mode, setMode] = useState<'new' | AdminModule | null>(null);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const action = useAction();
  const query = '/admin/modules?' + new URLSearchParams({ page: String(page), q: search, ...(status ? { status } : {}) });
  const state = useResource(() => list<AdminModule>(query), query);
  const stats = useResource(async () => {
    const results = await Promise.all(['', 'ACTIVE', 'DRAFT'].map(status => list<AdminModule>('/admin/modules?pageSize=1' + (status ? '&status=' + status : ''))));
    return results.map(result => result.pagination.total);
  }, 'module-metrics');
  function reload() { state.reload(); stats.reload(); }
  const selected = typeof mode === 'object' ? mode : null;
  return <>
    <Heading title="Modules" detail="Manage teaching modules, lecturer assignments and enrolments." action={<button onClick={() => { action.clear(); setMode('new'); }}><Plus size={17} aria-hidden="true"/>New module</button>} />
    {!stats.error && <section className="metrics" aria-label="Module overview">
      {[
        { label: 'Total modules', Icon: Grid2X2, tone: '' },
        { label: 'Active modules', Icon: CircleCheck, tone: 'active' },
        { label: 'Draft modules', Icon: FileText, tone: 'draft' },
      ].map(({ label, Icon, tone }, index) => <div className="metric" key={label}>
        <span className={'metric-icon ' + tone}><Icon size={19} aria-hidden="true" /></span>
        <span><span className="metric-label">{label}</span><strong className="metric-value">{stats.value?.[index] ?? '—'}</strong></span>
      </div>)}
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
          <label>Module code<input name="code" required pattern="[A-Za-z0-9\\-]{2,24}" defaultValue={selected?.code} disabled={selected?.status === 'ACTIVE'} /></label>
          <label>Term<input name="term" required maxLength={40} defaultValue={selected?.term} disabled={selected?.status === 'ACTIVE'} /></label>
        </div>
        <label>Module name<input name="name" required maxLength={120} defaultValue={selected?.name} /></label>
        <label>Description<textarea name="description" maxLength={2000} defaultValue={selected?.description} /></label>
        <AccountPicker role="LECTURER" label="Assigned lecturer" initial={selected?.lecturer} />
        <div className="actions"><button disabled={action.pending}>{selected ? 'Save module' : 'Create module'}</button><button type="button" className="secondary" onClick={() => setMode(null)}>Cancel</button></div>
      </form>
    </section>}
    <ErrorMessage message={action.error} />
    <section className="directory" aria-label="Module directory">
    <div className="filters">
      <SearchField label="Search modules" placeholder="Module code, name or term" value={search} onChange={value => { setSearch(value); setPage(1); }} />
      <label>Status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></select></label>
    </div>
    <Resource state={state}>{result => <>
      {!result.data.length ? <Empty>No modules match this search.</Empty> : <div className="table-wrap"><table>
        <thead><tr><th scope="col">Module</th><th scope="col">Lecturer</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead>
        <tbody>{result.data.map(module => <tr key={module.id}><th scope="row"><div className="table-item"><span className="item-icon"><BookOpen size={17} aria-hidden="true"/></span><span>{module.name}<small>{module.code} · {module.term}</small></span></div></th><td>{module.lecturer.displayName}</td><td><Badge>{module.status}</Badge></td><td><div className="actions">
          <Link className="button secondary" to={'/admin/modules/' + module.id + '/enrolments'}>Enrolments ({module.activeEnrolmentCount})</Link>
          {module.status !== 'ARCHIVED' && <button className="secondary" onClick={() => { action.clear(); setMode(module); }}>Edit</button>}
          {module.status === 'DRAFT' && <button disabled={action.pending} onClick={() => void action.run(async () => {
            await mutate('/admin/modules/' + module.id + '/activate', 'POST', { version: module.version }, csrf); reload();
          })}>Activate</button>}
          {module.status === 'ACTIVE' && <button className="secondary" disabled={action.pending} onClick={() => {
            if (!window.confirm('Archive ' + module.name + '? It will permanently become read-only.')) return;
            void action.run(async () => { await mutate('/admin/modules/' + module.id + '/archive', 'POST', { version: module.version, confirmUnpublishedGrades: false }, csrf); reload(); });
          }}>Archive</button>}
        </div></td></tr>)}</tbody>
      </table></div>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
    </section>
  </>;
}

export function AdminEnrolments({ csrf }: { csrf: string }) {
  const { moduleId } = useParams();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [pickerKey, setPickerKey] = useState(0);
  const action = useAction();
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
      }))}><AccountPicker key={pickerKey} role="STUDENT" label="Student" /><div><button disabled={action.pending}>Enrol student</button></div></form>
    </section>}
    <ErrorMessage message={action.error} />
    <div className="filters"><label>Enrolment status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="WITHDRAWN">Withdrawn</option></select></label></div>
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Student</th><th scope="col">Status</th>{item.status !== 'ARCHIVED' && <th scope="col">Actions</th>}</tr></thead><tbody>
        {result.data.map(row => <tr key={row.studentId}><th scope="row">{row.displayName}</th><td><Badge>{row.status}</Badge></td>
          {item.status !== 'ARCHIVED' && <td><button className="secondary" disabled={action.pending} onClick={() => {
            const method = row.status === 'ACTIVE' ? 'withdraw' : 'reactivate';
            if (!window.confirm((method === 'withdraw' ? 'Withdraw ' : 'Reactivate ') + row.displayName + '?')) return;
            void action.run(async () => { await mutate(path + '/' + row.studentId + '/' + method, 'POST', {}, csrf); state.reload(); });
          }}>{row.status === 'ACTIVE' ? 'Withdraw' : 'Reactivate'}</button></td>}
        </tr>)}
      </tbody></table></div> : <Empty>No enrolments match this view.</Empty>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
  </>}</Resource>;
}

export function AdminAudit() {
  const [page, setPage] = useState(1);
  const [eventType, setEventType] = useState('');
  const path = '/admin/audit-events?' + new URLSearchParams({ page: String(page), ...(eventType.trim() ? { eventType } : {}) });
  const state = useResource(() => list<AuditEvent>(path), path);
  return <>
    <Heading title="Audit log" detail="Account and module administration events." />
    <div className="filters"><label>Event type<input value={eventType} placeholder="e.g. MODULE_CREATED" onChange={event => { setEventType(event.target.value); setPage(1); }} /></label></div>
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Event</th><th scope="col">Entity type</th><th scope="col">Time</th></tr></thead><tbody>
        {result.data.map(row => <tr key={row.id}><th scope="row">{row.eventType.replaceAll('_', ' ')}</th><td>{row.entityType}</td><td>{dateTime(row.occurredAt)}</td></tr>)}
      </tbody></table></div> : <Empty>No audit events match this view.</Empty>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
  </>;
}
