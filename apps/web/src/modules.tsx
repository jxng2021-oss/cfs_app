import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from './components/ui/table.js';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowUpRight, BookOpen } from 'lucide-react';
import { Card } from './components/ui/card.js';
import { get, list, type Enrolment, type Module, type Session } from './api.js';
import { ModuleCardProgress, ProgressSummary } from './learning.js';
import { Badge, Empty, Heading, Pagination, Resource, useResource } from './ui.js';

export function ModuleList({ session }: { session: Session }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const query = '/modules?' + new URLSearchParams({ page: String(page), ...(status ? { status } : {}) });
  const state = useResource(() => list<Module>(query), query);
  return <>
    <Heading title="My modules" detail={session.user.role === 'LECTURER' ? 'Manage the modules assigned to you.' : 'Open an enrolled module to continue learning.'}
      action={<label className="filter-label">Status<NativeSelect value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><NativeSelectOption value="">All statuses</NativeSelectOption>{session.user.role === 'LECTURER' && <NativeSelectOption value="DRAFT">Draft</NativeSelectOption>}<NativeSelectOption value="ACTIVE">Active</NativeSelectOption><NativeSelectOption value="ARCHIVED">Archived</NativeSelectOption></NativeSelect></label>} />
    <Resource state={state}>{result => <>
      {result.data.length === 0 ? <Empty>{!status && session.user.role === 'STUDENT' ? 'You are not enrolled in any modules. Contact your administrator if a module is missing.' : 'No modules match this view.'}</Empty> :
        ['CURRENT','ARCHIVED'].map(group=>{
          const modules=result.data.filter(module=>(group==='ARCHIVED')===(module.status==='ARCHIVED'));
          if(!modules.length)return null;
          return <section key={group} className="module-card-section">
            {group==='ARCHIVED'&&!status&&<h2>Archived modules</h2>}
            <div className="module-grid">{modules.map(module=>{
              const to='/modules/'+module.id;
              return <Link className="module-card" to={to} key={module.id}>
                <div className="module-card-head"><span className="module-card-id"><span className="item-icon"><BookOpen size={18} aria-hidden="true"/></span><span className="module-code">{module.code}</span></span><Badge>{module.status}</Badge></div>
                <div className="module-card-body"><h2>{module.name}</h2>{module.description&&<p>{module.description}</p>}
                  {session.user.role==='STUDENT'&&<ModuleCardProgress path={to}/>}
                </div>
                <div className="module-card-foot"><span>{module.term}</span><ArrowUpRight size={18} aria-hidden="true"/></div>
              </Link>;
            })}</div>
          </section>;
        })}
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
    <div className="module-detail">
    <Card className="panel"><h2>Module overview</h2><p>{module.description || 'No description has been added.'}</p>
      <div className="actions"><Link className="button" to={path + '/content'}><BookOpen size={16} aria-hidden="true"/>Learning content</Link>
        {session.user.role === 'LECTURER' && <Link className="button secondary" to={path + '/roster'}>View roster</Link>}
      </div>
    </Card>
    {session.user.role === 'STUDENT' && <ProgressSummary modulePath={path} />}
    </div>
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
      action={<label className="filter-label">Status<NativeSelect value={status} onChange={event => { setStatus(event.target.value); setPage(1); }}><NativeSelectOption value="ACTIVE">Active</NativeSelectOption><NativeSelectOption value="WITHDRAWN">Withdrawn</NativeSelectOption></NativeSelect></label>} />
    <Resource state={state}>{result => <>
      {result.data.length ? <div className="table-wrap"><Table><TableHeader><TableRow><TableHead scope="col">Student</TableHead><TableHead scope="col">Status</TableHead></TableRow></TableHeader><TableBody>
        {result.data.map(row => <TableRow key={row.studentId}><TableHead scope="row">{row.displayName}</TableHead><TableCell><Badge>{row.status}</Badge></TableCell></TableRow>)}
      </TableBody></Table></div> : <Empty>No students have this enrolment status.</Empty>}
      <Pagination page={result} onPage={setPage}/>
    </>}</Resource>
  </>;
}
