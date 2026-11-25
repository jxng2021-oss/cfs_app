import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, mutate, type Module, type Session } from './api.js';
import { Badge, Empty, ErrorMessage, Heading, Resource, field, submit, useAction, useResource } from './ui.js';

type Progress = { completed: number; total: number; percent: number | null };
type Material = { id: string; title: string; summary: string; type: 'TEXT' | 'LINK'; status: 'DRAFT' | 'PUBLISHED';
  required: boolean; completedAt?: string | null; version?: number; textBody?: string | null; externalUrl?: string | null };
type Topic = { id: string; title: string; description: string; status: 'DRAFT' | 'PUBLISHED';
  version?: number; progress?: Progress; materials?: Material[] };
type RecordItem = { id: string };

function orderFor<T extends RecordItem>(items: T[], index: number, direction: -1 | 1) {
  const order = items.map(item => item.id);
  const next = index + direction;
  [order[index], order[next]] = [order[next], order[index]];
  return order;
}

function OrderControls({ title, index, length, disabled, onMove }: { title: string; index: number; length: number; disabled: boolean; onMove: (move: -1 | 1) => void }) {
  return <div className="actions">
    <button className="secondary" disabled={disabled || index === 0} aria-label={'Move ' + title + ' up'} onClick={() => onMove(-1)}>↑</button>
    <button className="secondary" disabled={disabled || index === length - 1} aria-label={'Move ' + title + ' down'} onClick={() => onMove(1)}>↓</button>
  </div>;
}

export function ProgressSummary({ modulePath }: { modulePath: string }) {
  const endpoint = modulePath + '/progress/me';
  const progress = useResource(() => get<{ overall: Progress }>(endpoint), endpoint);
  return <section className="panel">
    <h2>Learning progress</h2>
    <Resource state={progress}>{item => <ProgressValue progress={item.overall} />}</Resource>
  </section>;
}

function ProgressValue({ progress }: { progress: Progress }) {
  return progress.percent === null ? <p>No learning materials yet.</p> : <div className="progress">
    <span>{progress.completed} of {progress.total} required materials complete <strong>{progress.percent}%</strong></span>
    <progress aria-label="Required materials complete" value={progress.completed} max={progress.total} />
  </div>;
}

function TopicFields({ topic }: { topic?: Topic }) {
  return <>
    <label>Topic title<input name="title" required maxLength={120} defaultValue={topic?.title} /></label>
    <label>Description<textarea name="description" maxLength={2000} defaultValue={topic?.description} /></label>
  </>;
}

function MaterialFields({ material }: { material?: Material }) {
  const [type, setType] = useState(material?.type ?? 'TEXT');
  return <>
    <label>Material title<input name="title" required maxLength={120} defaultValue={material?.title} /></label>
    <label>Summary<input name="summary" maxLength={500} defaultValue={material?.summary} /></label>
    <label>Type<select name="type" value={type} onChange={event => setType(event.target.value as Material['type'])}><option value="TEXT">Text</option><option value="LINK">Link</option></select></label>
    {type === 'TEXT' ? <label>Text<textarea name="textBody" required maxLength={20000} defaultValue={material?.textBody ?? ''} /></label> :
      <label>HTTPS link<input name="externalUrl" type="url" required maxLength={2048} defaultValue={material?.externalUrl ?? ''} /></label>}
    <label className="checkbox"><input type="checkbox" name="required" defaultChecked={material?.required ?? true} /> Required material</label>
  </>;
}
function materialPayload(form: FormData) {
  const type = field(form, 'type');
  return {
    title: field(form, 'title'), summary: field(form, 'summary'), type, required: form.has('required'),
    ...(type === 'TEXT' ? { textBody: field(form, 'textBody') } : { externalUrl: field(form, 'externalUrl') }),
  };
}

export function TopicList({ session }: { session: Session }) {
  const { moduleId } = useParams();
  const path = '/modules/' + moduleId;
  const endpoint = path + '/topics';
  const state = useResource(() => Promise.all([get<Module>(path), get<Topic[]>(endpoint)]), endpoint);
  const [showNew, setShowNew] = useState(false);
  const action = useAction();
  return <Resource state={state}>{([module, topics]) => {
    const manage = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED';
    return <>
      <Heading title="Learning content" detail={module.name} parent={{ to: path, label: 'Module overview' }}
        action={manage && <button onClick={() => setShowNew(true)}>New topic</button>} />
      {module.status === 'ARCHIVED' && <Empty>This archived module is read-only.</Empty>}
      {showNew && manage && <section className="panel"><h2>New topic</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'POST', { title: field(form, 'title'), description: field(form, 'description') }, session.csrfToken);
        setShowNew(false); state.reload();
      }))}><TopicFields /><div className="actions"><button disabled={action.pending}>Create topic</button><button type="button" className="secondary" onClick={() => setShowNew(false)}>Cancel</button></div></form></section>}
      <ErrorMessage message={action.error} />
      {topics.length === 0 ? <Empty>No topics are available.</Empty> : <ol className="learning-list">{topics.map((topic, index) => <li key={topic.id} className="panel">
        <div className="learning-row"><div><Link className="learning-title" to={path + '/content/' + topic.id}>{topic.title}</Link><p>{topic.description}</p></div>
          {session.user.role === 'LECTURER' && <Badge>{topic.status}</Badge>}
        </div>
        {topic.progress && <ProgressValue progress={topic.progress} />}
        {manage && <OrderControls title={topic.title} index={index} length={topics.length} disabled={action.pending} onMove={direction => {
          void action.run(async () => { await mutate(path + '/topic-order', 'PUT', { topicIds: orderFor(topics, index, direction), moduleVersion: module.version }, session.csrfToken); state.reload(); });
        }} />}
      </li>)}</ol>}
    </>;
  }}</Resource>;
}

export function TopicDetail({ session }: { session: Session }) {
  const { moduleId, topicId } = useParams();
  const path = '/modules/' + moduleId;
  const endpoint = path + '/topics/' + topicId;
  const state = useResource(() => Promise.all([get<Module>(path), get<Topic>(endpoint)]), endpoint);
  const [mode, setMode] = useState<'topic' | 'material' | null>(null);
  const action = useAction();
  const navigate = useNavigate();
  return <Resource state={state}>{([module, topic]) => {
    const manage = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED';
    const draft = topic.status === 'DRAFT';
    const materials = topic.materials ?? [];
    return <>
      <Heading title={topic.title} detail={topic.description} parent={{ to: path + '/content', label: 'Learning content' }} action={session.user.role === 'LECTURER' && <Badge>{topic.status}</Badge>} />
      {topic.progress && <section className="panel"><ProgressValue progress={topic.progress} /></section>}
      {manage && <div className="actions topic-actions">
        <button className="secondary" onClick={() => setMode('topic')}>Edit topic</button>
        {draft && <>
          <button className="secondary" onClick={() => setMode('material')}>New material</button>
          <button disabled={action.pending} onClick={() => {
            if (!window.confirm('Publish this topic? Its material list and publication status will become fixed.')) return;
            void action.run(async () => { await mutate(endpoint + '/publish', 'POST', { version: topic.version }, session.csrfToken); setMode(null); state.reload(); });
          }}>Publish topic</button>
          <button className="secondary" disabled={action.pending} onClick={() => {
            if (!window.confirm('Delete this draft topic and its materials?')) return;
            void action.run(async () => { await mutate(endpoint, 'DELETE', undefined, session.csrfToken); navigate(path + '/content'); });
          }}>Delete topic</button>
        </>}
      </div>}
      {mode === 'topic' && manage && <section className="panel"><h2>Edit topic</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'PATCH', { version: topic.version, title: field(form, 'title'), description: field(form, 'description') }, session.csrfToken);
        setMode(null); state.reload();
      }))}><TopicFields topic={topic} /><div className="actions"><button disabled={action.pending}>Save topic</button><button className="secondary" type="button" onClick={() => setMode(null)}>Cancel</button></div></form></section>}
      {mode === 'material' && manage && draft && <section className="panel"><h2>New material</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint + '/materials', 'POST', materialPayload(form), session.csrfToken);
        setMode(null); state.reload();
      }))}><MaterialFields /><div className="actions"><button disabled={action.pending}>Create material</button><button className="secondary" type="button" onClick={() => setMode(null)}>Cancel</button></div></form></section>}
      <ErrorMessage message={action.error} />
      {materials.length === 0 ? <Empty>No materials are available.</Empty> : <ol className="learning-list">{materials.map((item, index) => <li key={item.id} className="panel">
        <div className="learning-row"><div>
          <Link className="learning-title" to={path + '/content/' + topicId + '/materials/' + item.id}>{item.title}</Link><p>{item.summary}</p>
        </div><div className="actions"><Badge>{item.type}</Badge><Badge>{session.user.role === 'LECTURER' ? item.status : item.completedAt ? 'COMPLETE' : item.required ? 'REQUIRED' : 'OPTIONAL'}</Badge></div></div>
        {manage && draft && <OrderControls title={item.title} index={index} length={materials.length} disabled={action.pending} onMove={direction => {
          void action.run(async () => { await mutate(endpoint + '/material-order', 'PUT', { materialIds: orderFor(materials, index, direction), topicVersion: topic.version }, session.csrfToken); state.reload(); });
        }} />}
      </li>)}</ol>}
    </>;
  }}</Resource>;
}

export function MaterialDetail({ session }: { session: Session }) {
  const { moduleId, topicId, materialId } = useParams();
  const path = '/modules/' + moduleId;
  const topicPath = path + '/topics/' + topicId;
  const back = path + '/content/' + topicId;
  const endpoint = topicPath + '/materials/' + materialId;
  const state = useResource(() => Promise.all([get<Module>(path), get<Topic>(topicPath), get<Material>(endpoint)]), endpoint);
  const [editing, setEditing] = useState(false);
  const action = useAction();
  const navigate = useNavigate();
  return <Resource state={state}>{([module, topic, material]) => {
    const manage = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED' && topic.status === 'DRAFT';
    return <>
      <Heading title={material.title} detail={material.summary} parent={{ to: back, label: topic.title }} action={<Badge>{material.required ? 'REQUIRED' : 'OPTIONAL'}</Badge>} />
      <section className="panel">
        {material.type === 'TEXT' ? <p className="plain-text">{material.textBody}</p> :
          <a className="button secondary" href={material.externalUrl ?? undefined} target="_blank" rel="noopener noreferrer">Open external link ↗</a>}
      </section>
      <ErrorMessage message={action.error} />
      {session.user.role === 'STUDENT' && material.required && (material.completedAt ? <p role="status">Completed</p> : module.status !== 'ARCHIVED' && <button disabled={action.pending} onClick={() => void action.run(async () => {
        await mutate(endpoint + '/completion', 'PUT', {}, session.csrfToken); state.reload();
      })}>Mark complete</button>)}
      {manage && <div className="actions topic-actions">
        {material.status === 'DRAFT' && <button className="secondary" onClick={() => setEditing(true)}>Edit material</button>}
        <button disabled={action.pending} onClick={() => void action.run(async () => {
          await mutate(endpoint + (material.status === 'DRAFT' ? '/publish' : '/unpublish'), 'POST', { version: material.version }, session.csrfToken); setEditing(false); state.reload();
        })}>{material.status === 'DRAFT' ? 'Publish material' : 'Revert to draft'}</button>
        <button className="secondary" disabled={action.pending} onClick={() => {
          if (!window.confirm('Delete this material from the draft topic?')) return;
          void action.run(async () => { await mutate(endpoint, 'DELETE', undefined, session.csrfToken); navigate(back); });
        }}>Delete material</button>
      </div>}
      {manage && editing && <section className="panel"><h2>Edit material</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'PATCH', { ...materialPayload(form), version: material.version }, session.csrfToken);
        setEditing(false); state.reload();
      }))}><MaterialFields material={material} /><div className="actions"><button disabled={action.pending}>Save material</button><button className="secondary" type="button" onClick={() => setEditing(false)}>Cancel</button></div></form></section>}
    </>;
  }}</Resource>;
}
