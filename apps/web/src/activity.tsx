import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, list, query, type ActivityEntry } from './api.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { Empty, Heading, Pagination, Resource, SearchField, dateTime, relative, statusText, useResource } from './ui.js';

const entityLinks: Record<string, string> = { APPLICANT: '/applicants/', APPLICATION: '/applications/', PROGRAMME: '/programmes/', INTAKE: '/intakes/' };
const entityNames: Record<string, string> = { APPLICANT: 'Applicant', APPLICATION: 'Application', PROGRAMME: 'Programme', INTAKE: 'Intake', SETTING: 'Settings', USER: 'User account' };
const actionText = (action: string) => statusText(action);

function Changes({ metadata }: { metadata: Record<string, unknown> }) {
  const entries = Object.entries(metadata ?? {});
  if (!entries.length) return null;
  return <span className="change-meta">{entries.map(([key, value]) => <span key={key}><em>{key}</em> {String(value)}</span>)}</span>;
}

/** Read-only administrator view of every recorded action. */
export function ActivityLog() {
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [action, setAction] = useState('');
  const [entityType, setEntityType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest');
  const path = '/activity' + query({ q: search, action, entityType, page, sort,
    from: from ? from + 'T00:00:00+08:00' : '', to: to ? new Date(Date.parse(to + 'T00:00:00+08:00') + 86_400_000).toISOString() : '' });
  const state = useResource(() => list<ActivityEntry>(path), path);
  const actions = useResource(() => get<string[]>('/activity/actions'), 'activity-actions');
  const reset = (apply: () => void) => { apply(); setPage(1); };
  return <>
    <Heading title="Activity Logs" detail="Every administrative action, newest first. Records are append-only and cannot be edited." />
    <section className="directory" aria-label="Activity log">
      <div className="filters">
        <SearchField label="Search" placeholder="Description, action or person" value={search} onChange={value => reset(() => setSearch(value))} />
        <label>Action<NativeSelect value={action} onChange={event => reset(() => setAction(event.target.value))}>
          <NativeSelectOption value="">All actions</NativeSelectOption>
          {actions.value?.map(value => <NativeSelectOption key={value} value={value}>{actionText(value)}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Record type<NativeSelect value={entityType} onChange={event => reset(() => setEntityType(event.target.value))}>
          <NativeSelectOption value="">All records</NativeSelectOption>
          {Object.entries(entityNames).map(([value, label]) => <NativeSelectOption key={value} value={value}>{label}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>From<Input type="date" value={from} max={to || undefined} onChange={event => reset(() => setFrom(event.target.value))} /></label>
        <label>To<Input type="date" value={to} min={from || undefined} onChange={event => reset(() => setTo(event.target.value))} /></label>
        <label>Order<NativeSelect value={sort} onChange={event => reset(() => setSort(event.target.value as 'newest' | 'oldest'))}>
          <NativeSelectOption value="newest">Newest first</NativeSelectOption><NativeSelectOption value="oldest">Oldest first</NativeSelectOption>
        </NativeSelect></label>
      </div>
      <Resource state={state}>{result => <>
        {!result.data.length ? <Empty>No activity matches these filters.</Empty> : <div className="table-wrap"><Table>
          <TableHeader><TableRow><TableHead scope="col">When</TableHead><TableHead scope="col">Action</TableHead><TableHead scope="col">Description</TableHead><TableHead scope="col">Record</TableHead><TableHead scope="col">By</TableHead></TableRow></TableHeader>
          <TableBody>{result.data.map(entry => <TableRow key={entry.id}>
            <TableCell><span title={dateTime(entry.occurredAt)}>{dateTime(entry.occurredAt)}</span><small>{relative(entry.occurredAt)}</small></TableCell>
            <TableCell><span className="action-chip">{actionText(entry.action)}</span></TableCell>
            <TableCell className="wrap">{entry.description}<Changes metadata={entry.metadata} /></TableCell>
            <TableCell>{entry.entityId && entityLinks[entry.entityType] ? <Link className="text-link" to={entityLinks[entry.entityType] + entry.entityId}>{entityNames[entry.entityType]}</Link> : entityNames[entry.entityType] ?? entry.entityType}</TableCell>
            <TableCell>{entry.actorName ?? 'System'}</TableCell>
          </TableRow>)}</TableBody>
        </Table></div>}
        <div className="directory-foot"><span /><Pagination page={result} onPage={setPage} /></div>
      </>}</Resource>
    </section>
  </>;
}

/** Compact timeline of activity for one record (applicant, programme or intake). */
export function ActivityHistory({ entityType, entityId }: { entityType: string; entityId: string }) {
  const path = '/activity/' + entityType + '/' + entityId;
  const state = useResource(() => get<ActivityEntry[]>(path), path);
  return <Resource state={state}>{entries => entries.length ? <ol className="activity-feed">
    {entries.slice(0, 12).map(entry => <li key={entry.id}>
      <span className="feed-dot" aria-hidden="true" />
      <div><p>{entry.description}</p><small>{entry.actorName ?? 'System'} · {dateTime(entry.occurredAt)}</small></div>
    </li>)}
  </ol> : <p className="reading-empty">No recorded activity.</p>}</Resource>;
}
