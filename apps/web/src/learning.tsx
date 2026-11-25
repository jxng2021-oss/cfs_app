import { Button } from './components/ui/button.js';
import { Input } from './components/ui/input.js';
import { Textarea } from './components/ui/textarea.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, Download, ExternalLink, LockKeyhole } from 'lucide-react';
import { Card } from './components/ui/card.js';
import { get, mutate, stageFile, type FileMetadata, type Module, type Session } from './api.js';
import { type Assessment } from './assessments.js';
import { Upcoming } from './academic.js';
import { Badge, Empty, ErrorMessage, Heading, Resource, dateTime, field, submit, useAction, useConfirmation, useResource } from './ui.js';

type Progress = { completed: number; total: number; percent: number | null };
type ModuleProgress={overall:Progress;upcomingDeadlines:Assessment[];gradeSummary:{currentReleasedAverage:string|null;releasedWeight:string}};
type Material = { id: string; title: string; summary: string; type: 'TEXT' | 'LINK' | 'FILE'; status: 'DRAFT' | 'PUBLISHED';
  required: boolean; completedAt?: string | null; version?: number; textBody?: string | null; externalUrl?: string | null; file?: FileMetadata };
type Requirement = { type: 'TOPIC_COMPLETE'|'QUIZ_SCORE_AT_LEAST'; satisfied:boolean; sourceTitle:string; sourceTopicId?:string;
  sourceAssessmentId?:string; thresholdPct?:string; publishedScorePct?:string|null };
type Topic = { id: string; title: string; description: string; status: 'DRAFT' | 'PUBLISHED';
  version?: number; progress?: Progress; materials?: Material[]; learningState?:string; requirements?:Requirement[]; assessments?:Assessment[] };
type RecordItem = { id: string };

function orderFor<T extends RecordItem>(items: T[], index: number, direction: -1 | 1) {
  const order = items.map(item => item.id);
  const next = index + direction;
  [order[index], order[next]] = [order[next], order[index]];
  return order;
}

function OrderControls({ title, index, length, disabled, onMove }: { title: string; index: number; length: number; disabled: boolean; onMove: (move: -1 | 1) => void }) {
  return <div className="actions">
    <Button variant="outline" size="icon" disabled={disabled || index === 0} aria-label={'Move ' + title + ' up'} onClick={() => onMove(-1)}><ChevronUp aria-hidden="true"/></Button>
    <Button variant="outline" size="icon" disabled={disabled || index === length - 1} aria-label={'Move ' + title + ' down'} onClick={() => onMove(1)}><ChevronDown aria-hidden="true"/></Button>
  </div>;
}

export function ProgressSummary({ modulePath }: { modulePath: string }) {
  const endpoint = modulePath + '/progress/me';
  const progress = useResource(() => get<ModuleProgress>(endpoint), endpoint);
  return <Resource state={progress}>{item => <div>
    <Card className="panel"><h2>Learning progress</h2><ProgressValue progress={item.overall}/>
      {item.gradeSummary.currentReleasedAverage&&<p>Released average {item.gradeSummary.currentReleasedAverage}% · {item.gradeSummary.releasedWeight}% graded</p>}
      <Button asChild variant="outline" size="sm"><Link to={modulePath+'/gradebook'}>View gradebook</Link></Button>
    </Card>
    <Upcoming path={modulePath} items={item.upcomingDeadlines}/>
  </div>}</Resource>;
}

export function ModuleCardProgress({path}:{path:string}){
  const endpoint=path+'/progress/me';
  const state=useResource(()=>get<ModuleProgress>(endpoint),endpoint);
  if(!state.value)return null;
  const {overall,upcomingDeadlines,gradeSummary}=state.value;
  const next=upcomingDeadlines[0];
  return <div className="module-card-progress">
    <ProgressValue progress={overall}/>
    {next&&<small>Next deadline · {next.title} · {dateTime(next.dueAt)}</small>}
    {gradeSummary.currentReleasedAverage&&<small>Released average · {gradeSummary.currentReleasedAverage}%</small>}
  </div>;
}

function ProgressValue({ progress }: { progress: Progress }) {
  return progress.percent === null ? <p>No learning materials yet.</p> : <div className="progress">
    <span>{progress.completed} of {progress.total} required materials complete <strong>{progress.percent}%</strong></span>
    <progress aria-label="Required materials complete" value={progress.completed} max={progress.total} />
  </div>;
}

function TopicFields({ topic }: { topic?: Topic }) {
  return <>
    <label>Topic title<Input name="title" required maxLength={120} defaultValue={topic?.title} /></label>
    <label>Description<Textarea name="description" maxLength={2000} defaultValue={topic?.description} /></label>
  </>;
}

function MaterialFields({ material }: { material?: Material }) {
  const [type, setType] = useState(material?.type ?? 'TEXT');
  return <>
    <label>Material title<Input name="title" required maxLength={120} defaultValue={material?.title} /></label>
    <label>Summary<Input name="summary" maxLength={500} defaultValue={material?.summary} /></label>
    <label>Type<NativeSelect name="type" value={type} onChange={event => setType(event.target.value as Material['type'])}><NativeSelectOption value="TEXT">Text</NativeSelectOption><NativeSelectOption value="LINK">Link</NativeSelectOption><NativeSelectOption value="FILE">File</NativeSelectOption></NativeSelect></label>
    {type === 'TEXT' ? <label>Text<Textarea name="textBody" required maxLength={20000} defaultValue={material?.textBody ?? ''} /></label> :
      type === 'LINK' ? <label>HTTPS link<Input name="externalUrl" type="url" required maxLength={2048} defaultValue={material?.externalUrl ?? ''} /></label> :
      <label>Material file<Input name="file" type="file" accept=".pdf,.txt,.md,.png,.jpg,.jpeg,.pptx,.docx,.xlsx,.zip" required={!material?.file}/>{material?.file&&<small>Attached: {material.file.originalFilename}. Select a file to replace it.</small>}</label>}
    <label className="checkbox"><input type="checkbox" name="required" defaultChecked={material?.required ?? true} /> Required material</label>
  </>;
}
async function materialPayload(form: FormData,csrf:string) {
  const type = field(form, 'type');
  const file=form.get('file');
  return {
    title: field(form, 'title'), summary: field(form, 'summary'), type, required: form.has('required'),
    ...(type === 'TEXT' ? { textBody: field(form, 'textBody') }
      : type === 'LINK' ? { externalUrl: field(form, 'externalUrl') }
      : file instanceof File&&file.size ? {fileId:(await stageFile(file,'MATERIAL',csrf)).id} : {}),
  };
}

type RuleConfiguration={topicVersion:number;rules:{type:Requirement['type'];sourceTopicId?:string;sourceAssessmentId?:string;thresholdPct?:string}[];
  topics:{id:string;title:string}[];quizzes:{id:string;title:string;closed:boolean;resultRelease:string;maxAttempts:number}[]};

function Conditions({path,requirements}:{path:string;requirements:Requirement[]}){
  return <ul className="material-rule-list">{requirements.map(rule=><li key={rule.type}>
    <strong>{rule.satisfied?'Met':'Required'} · </strong>
    {rule.type==='TOPIC_COMPLETE'?<>Complete <Link className="learning-title" to={path+'/content/'+rule.sourceTopicId}>{rule.sourceTitle}</Link>.</>:
      <>Earn at least {rule.thresholdPct}% on <Link className="learning-title" to={path+'/assessments/'+rule.sourceAssessmentId}>{rule.sourceTitle}</Link>.
        {rule.publishedScorePct==null?' A published quiz result is required.':' Your released score is '+rule.publishedScorePct+'%.'}</>}
  </li>)}</ul>;
}

function ReleaseEditor({endpoint,session,done}:{endpoint:string;session:Session;done:()=>void}){
  const path=endpoint+'/release-rules';
  const state=useResource(()=>get<RuleConfiguration>(path),path);
  const action=useAction();
  return <Resource state={state}>{item=><Card className="panel"><h2>Release conditions</h2>
    <p>Students must meet every condition selected for this topic.</p>
    <form className="stack" onSubmit={submit(form=>void action.run(async()=>{
      const topic=field(form,'topic');
      const quiz=field(form,'quiz');
      const rules=[
        ...(topic?[{type:'TOPIC_COMPLETE',sourceTopicId:topic}]:[]),
        ...(quiz?[{type:'QUIZ_SCORE_AT_LEAST',sourceAssessmentId:quiz,thresholdPct:field(form,'threshold')||'70.00'}]:[]),
      ];
      await mutate(path,'PUT',{topicVersion:item.topicVersion,rules},session.csrfToken);done();
    }))}>
      <label>Complete earlier topic<NativeSelect name="topic" defaultValue={item.rules.find(rule=>rule.type==='TOPIC_COMPLETE')?.sourceTopicId??''}>
        <NativeSelectOption value="">No topic prerequisite</NativeSelectOption>{item.topics.map(topic=><NativeSelectOption key={topic.id} value={topic.id}>{topic.title}</NativeSelectOption>)}
      </NativeSelect></label>
      <label>Quiz result<NativeSelect name="quiz" defaultValue={item.rules.find(rule=>rule.type==='QUIZ_SCORE_AT_LEAST')?.sourceAssessmentId??''}>
        <NativeSelectOption value="">No quiz prerequisite</NativeSelectOption>{item.quizzes.map(quiz=><NativeSelectOption key={quiz.id} value={quiz.id}>{quiz.title} · {quiz.resultRelease==='MANUAL'?'Manual release':'Immediate release'} · {quiz.maxAttempts} attempts{quiz.closed?' · Closed':''}</NativeSelectOption>)}
      </NativeSelect></label>
      <label>Minimum quiz score (%)<Input name="threshold" type="number" min=".01" max="100" step=".01" defaultValue={item.rules.find(rule=>rule.type==='QUIZ_SCORE_AT_LEAST')?.thresholdPct??'70.00'}/></label>
      <ErrorMessage message={action.error}/>
      <div className="actions"><Button disabled={action.pending}>Save conditions</Button><Button type="button" variant="outline" onClick={done}>Cancel</Button></div>
    </form>
  </Card>}</Resource>;
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
        action={manage && <Button onClick={() => setShowNew(true)}>New topic</Button>} />
      {module.status === 'ARCHIVED' && <Empty>This archived module is read-only.</Empty>}
      {showNew && manage && <section className="panel"><h2>New topic</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'POST', { title: field(form, 'title'), description: field(form, 'description') }, session.csrfToken);
        setShowNew(false); state.reload();
      }))}><TopicFields /><div className="actions"><Button disabled={action.pending}>Create topic</Button><Button type="button" variant="outline" onClick={() => setShowNew(false)}>Cancel</Button></div></form></section>}
      <ErrorMessage message={action.error} />
      {topics.length === 0 ? <Empty>No topics are available.</Empty> : <ol className="learning-list">{topics.map((topic, index) => <li key={topic.id} className="panel">
        <div className="learning-row"><div><Link className="learning-title" to={path + '/content/' + topic.id}>{topic.title}</Link><p>{topic.description}</p></div>
          <Badge>{session.user.role === 'LECTURER' ? topic.status : topic.learningState==='LOCKED'?'LOCKED':topic.learningState==='COMPLETE'?'COMPLETE':topic.progress?.completed?'IN_PROGRESS':'NOT_STARTED'}</Badge>
        </div>
        {topic.learningState==='LOCKED'?<Conditions path={path} requirements={topic.requirements??[]}/>:topic.progress&&<ProgressValue progress={topic.progress}/>}
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
  const [mode, setMode] = useState<'topic' | 'material' | 'rules' | null>(null);
  const action = useAction();
  const confirmation = useConfirmation();
  const navigate = useNavigate();
  return <Resource state={state}>{([module, topic]) => {
    const manage = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED';
    const draft = topic.status === 'DRAFT';
    const materials = topic.materials ?? [];
    const locked=topic.learningState==='LOCKED';
    return <>
      <Heading title={topic.title} detail={topic.description} parent={{ to: path + '/content', label: 'Learning content' }} action={session.user.role === 'LECTURER' && <Badge>{topic.status}</Badge>} />
      {locked?<Card className="panel"><h2><LockKeyhole size={16} aria-hidden="true"/> Topic locked</h2><Conditions path={path} requirements={topic.requirements??[]}/></Card>:
        topic.progress&&<section className="panel"><ProgressValue progress={topic.progress}/></section>}
      {manage && <div className="actions topic-actions">
        <Button variant="outline" onClick={() => setMode('topic')}>Edit topic</Button>
        {draft && <>
          <Button variant="outline" onClick={() => setMode('material')}>New material</Button>
          <Button variant="outline" onClick={() => setMode('rules')}>Release conditions</Button>
          <Button disabled={action.pending} onClick={() => confirmation.ask({
            title: 'Publish this topic?', detail: 'Publishing fixes the topic’s material list and makes published materials available to eligible students.',
            label: 'Publish topic', run: () => void action.run(async () => {
              await mutate(endpoint + '/publish', 'POST', { version: topic.version }, session.csrfToken); setMode(null); state.reload();
            }),
          })}>Publish topic</Button>
          <Button variant="outline" disabled={action.pending} onClick={() => confirmation.ask({
            title: 'Delete this draft topic?', detail: 'All materials in this draft topic will also be deleted.', label: 'Delete topic', destructive: true,
            run: () => void action.run(async () => { await mutate(endpoint, 'DELETE', undefined, session.csrfToken); navigate(path + '/content'); }),
          })}>Delete topic</Button>
        </>}
      </div>}
      {mode==='rules'&&manage&&draft&&<ReleaseEditor endpoint={endpoint} session={session} done={()=>{setMode(null);state.reload();}}/>}
      {mode === 'topic' && manage && <section className="panel"><h2>Edit topic</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'PATCH', { version: topic.version, title: field(form, 'title'), description: field(form, 'description') }, session.csrfToken);
        setMode(null); state.reload();
      }))}><TopicFields topic={topic} /><div className="actions"><Button disabled={action.pending}>Save topic</Button><Button variant="outline" type="button" onClick={() => setMode(null)}>Cancel</Button></div></form></section>}
      {mode === 'material' && manage && draft && <section className="panel"><h2>New material</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint + '/materials', 'POST', await materialPayload(form,session.csrfToken), session.csrfToken);
        setMode(null); state.reload();
      }))}><MaterialFields /><div className="actions"><Button disabled={action.pending}>Create material</Button><Button variant="outline" type="button" onClick={() => setMode(null)}>Cancel</Button></div></form></section>}
      <ErrorMessage message={action.error} />
      {!locked&&(materials.length === 0 ? <Empty>No materials are available.</Empty> : <ol className="learning-list">{materials.map((item, index) => <li key={item.id} className="panel">
        <div className="learning-row"><div>
          <Link className="learning-title" to={path + '/content/' + topicId + '/materials/' + item.id}>{item.title}</Link><p>{item.summary}</p>
        </div><div className="actions"><Badge>{item.type}</Badge><Badge>{session.user.role === 'LECTURER' ? item.status : item.completedAt ? 'COMPLETE' : item.required ? 'REQUIRED' : 'OPTIONAL'}</Badge></div></div>
        {manage && draft && <OrderControls title={item.title} index={index} length={materials.length} disabled={action.pending} onMove={direction => {
          void action.run(async () => { await mutate(endpoint + '/material-order', 'PUT', { materialIds: orderFor(materials, index, direction), topicVersion: topic.version }, session.csrfToken); state.reload(); });
        }} />}
      </li>)}</ol>)}
      {!locked&&!!topic.assessments?.length&&<Card className="panel"><h2>Linked assessments</h2>
        <ul className="receipt-list">{topic.assessments.map(assessment=><li key={assessment.id}><Link className="learning-title" to={path+'/assessments/'+assessment.id+(session.user.role==='LECTURER'?'/edit':'')}>{assessment.title}</Link><Badge>{assessment.type}</Badge></li>)}</ul>
      </Card>}
      {confirmation.dialog}
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
  const confirmation = useConfirmation();
  const navigate = useNavigate();
  return <Resource state={state}>{([module, topic, material]) => {
    const manage = session.user.role === 'LECTURER' && module.status !== 'ARCHIVED' && topic.status === 'DRAFT';
    return <>
      <Heading title={material.title} detail={material.summary} parent={{ to: back, label: topic.title }} action={<Badge>{material.required ? 'REQUIRED' : 'OPTIONAL'}</Badge>} />
      <section className="panel">
        {material.type === 'FILE'&&material.file ? <Button asChild variant="outline"><a href={material.file.downloadUrl}><Download aria-hidden="true"/>{material.file.originalFilename}</a></Button> :
          material.type === 'TEXT' ? <p className="plain-text">{material.textBody}</p> :
          <Button asChild variant="outline"><a href={material.externalUrl ?? undefined} target="_blank" rel="noopener noreferrer">Open external link<ExternalLink aria-hidden="true"/></a></Button>}
      </section>
      <ErrorMessage message={action.error} />
      {session.user.role === 'STUDENT' && material.required && (material.completedAt ? <p role="status">Completed</p> : module.status !== 'ARCHIVED' && <Button disabled={action.pending} onClick={() => void action.run(async () => {
        await mutate(endpoint + '/completion', 'PUT', {}, session.csrfToken); state.reload();
      })}>Mark complete</Button>)}
      {manage && <div className="actions topic-actions">
        {material.status === 'DRAFT' && <Button variant="outline" onClick={() => setEditing(true)}>Edit material</Button>}
        <Button disabled={action.pending} onClick={() => void action.run(async () => {
          await mutate(endpoint + (material.status === 'DRAFT' ? '/publish' : '/unpublish'), 'POST', { version: material.version }, session.csrfToken); setEditing(false); state.reload();
        })}>{material.status === 'DRAFT' ? 'Publish material' : 'Revert to draft'}</Button>
        <Button variant="outline" disabled={action.pending} onClick={() => confirmation.ask({
          title: 'Delete this material?', detail: 'The material will be removed from this draft topic.', label: 'Delete material', destructive: true,
          run: () => void action.run(async () => { await mutate(endpoint, 'DELETE', undefined, session.csrfToken); navigate(back); }),
        })}>Delete material</Button>
      </div>}
      {manage && editing && <section className="panel"><h2>Edit material</h2><form className="stack" onSubmit={submit(form => void action.run(async () => {
        await mutate(endpoint, 'PATCH', { ...await materialPayload(form,session.csrfToken), version: material.version }, session.csrfToken);
        setEditing(false); state.reload();
      }))}><MaterialFields material={material} /><div className="actions"><Button disabled={action.pending}>Save material</Button><Button variant="outline" type="button" onClick={() => setEditing(false)}>Cancel</Button></div></form></section>}
      {confirmation.dialog}
    </>;
  }}</Resource>;
}
