import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, list, type Enrolment, type Module, type Session } from './api.js';
import { ProgressSummary } from './learning.js';
import { Badge, Empty, Heading, Pagination, Resource, useResource } from './ui.js';

export function ModuleList({ session }: { session: Session }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const query = '/modules?' + new URLSearchParams({ page: String(page), ...(status ? { status } : {}) });
  const state = useResource(() => list<Module>(query), query);
  return <>
    <Heading title="My modules" detail={session.user.role === 'LECTURER' ? 'Manage the modules assigned to you.' : 'Open an enrolled module to continue learning.'}
      action={<label className="filter-label">Status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option>{session.user.role === 'LECTURER' && <option value="DRAFT">Draft</option>}<option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></select></label>} />
    <Resource state={state}>{result => <>
      {result.data.length === 0 ? <Empty>No modules match this view.</Empty> : <div className="module-grid">{result.data.map(module => <Link className="module-card" to={'/modules/' + module.id} key={module.id}>
        <div className="module-card-head"><span className="module-code">{module.code}</span><Badge>{module.status}</Badge></div>
        <h2>{module.name}</h2><p>{module.description || module.term}</p><div className="module-card-foot"><span>{module.term}</span><span aria-hidden="true">↗</span></div>
      </Link>)}</div>}
      <Pagination page={result} onPage={setPage} />
    </>}</Resource>
  </>;
}

export function ModuleDetail({ session }: { session: Session }) {
  const { moduleId } = useParams();
  const path = '/modules/' + moduleId;
  const state = useResource(() => get<Module>(path), path);
  return <Resource state={state}>{module => <>
    <Heading title={module.name} detail={module.code + ' · ' + module.term} parent={{ to: '/modules', label: 'My modules' }} action={<Badge>{module.status}</Badge>} />
    {module.status === 'ARCHIVED' && <Empty>This archived module is read-only.</Empty>}
    <section className="panel"><h2>Module overview</h2><p>{module.description || 'No description has been added.'}</p>
      <div className="actions"><Link className="button" to={path + '/content'}>Learning content</Link>
        {session.user.role === 'LECTURER' && <Link className="button secondary" to={path + '/roster'}>View roster</Link>}
      </div>
    </section>
    {session.user.role === 'STUDENT' && <ProgressSummary modulePath={path} />}
  </>}</Resource>;
}

export function ModuleRoster() {
  const { moduleId } = useParams();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('ACTIVE');
  const path = '/modules/' + moduleId + '/roster?' + new URLSearchParams({ page: String(page), status });
  const state = useResource(() => list<Enrolment>(path), path);
  return <>
    <Heading title="Module roster" parent={{ to: '/modules/' + moduleId, label: 'Module overview' }}
      action={<label className="filter-label">Status<select value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><option value="ACTIVE">Active</option><option value="WITHDRAWN">Withdrawn</option></select></label>} />
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><table><thead><tr><th scope="col">Student</th><th scope="col">Status</th></tr></thead><tbody>
        {result.data.map(row => <tr key={row.studentId}><th scope="row">{row.displayName}</th><td><Badge>{row.status}</Badge></td></tr>)}
      </tbody></table></div> : <Empty>No students have this enrolment status.</Empty>}
      <Pagination page={result} onPage={setPage}/>
    </>}</Resource>
  </>;
}
