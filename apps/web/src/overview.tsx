import { Link } from 'react-router-dom';
import {
  AlertTriangle, BadgeCheck, CalendarClock, CalendarRange, CheckCircle2, ClipboardList, FilePlus2, GraduationCap, Hourglass, Inbox, ScanSearch, UserPlus,
  UsersRound, XCircle,
} from 'lucide-react';
import { get, query, type ApplicationStatus, type Breakdown, type Session, type StatusCount, type Utilisation } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { BarList, CapacityBar, ColumnSeries, RateMeter, StatusStack } from './charts.js';
import { Badge, Heading, Metric, Resource, calendarDate, dateOnly, relative, statusText, useResource } from './ui.js';

type Dashboard = {
  cards: { totalApplicants: number; totalApplications: number; pendingReview: number; underReview: number; offersIssued: number; offersAccepted: number; rejected: number; enrolled: number };
  rates: { submitted: number; offerRate: number | null; acceptanceRate: number | null; rejectionRate: number | null; enrolmentRate: number | null };
  statuses: StatusCount[]; overTime: { period: string; count: number }[]; byProgramme: Breakdown[]; byIntake: Breakdown[]; utilisation: Utilisation[]; academicYear: string;
  recentApplications: { id: string; reference: string; status: ApplicationStatus; createdAt: string; applicantName: string; programmeCode: string }[];
  attention: { id: string; reference: string; status: ApplicationStatus; applicantName: string; reason: string }[];
  deadlines: { kind: 'INTAKE_CLOSING' | 'OFFER_RESPONSE'; id: string; title: string; date: string }[];
  recentDecisions: { id: string; applicationId: string; reference: string; status: ApplicationStatus; occurredAt: string; applicantName: string; actorName: string | null }[];
  recentActivity: { id: string; action: string; description: string; occurredAt: string; actorName: string | null }[] | null;
};

export function Overview({ session }: { session: Session }) {
  const state = useResource(() => get<Dashboard>('/dashboard'), 'dashboard');
  const role = session.user.role;
  const editor = role !== 'VIEWER';
  return <>
    <Heading title="Admissions overview" detail={'Welcome back, ' + session.user.displayName.split(' ')[0] + '. Figures update from live application data.'} />
    <div className="quick-actions" role="group" aria-label="Quick actions">
      {editor && <Button asChild><Link to="/applicants/new"><UserPlus aria-hidden="true" />Create applicant</Link></Button>}
      {editor && <Button variant="outline" asChild><Link to="/applications/new"><FilePlus2 aria-hidden="true" />Create application</Link></Button>}
      {role === 'ADMIN' && <Button variant="outline" asChild><Link to="/programmes/new"><GraduationCap aria-hidden="true" />Create programme</Link></Button>}
      {role === 'ADMIN' && <Button variant="outline" asChild><Link to="/intakes/new"><CalendarRange aria-hidden="true" />Create admission intake</Link></Button>}
      <Button variant="outline" asChild><Link to="/applications?status=SUBMITTED"><Inbox aria-hidden="true" />View pending applications</Link></Button>
    </div>
    <Resource state={state}>{data => <>
      <div className="metrics metrics-4">
        <Metric label="Total applicants" value={data.cards.totalApplicants} icon={UsersRound} to="/applicants" hint="Excluding archived" />
        <Metric label="Total applications" value={data.cards.totalApplications} icon={ClipboardList} to="/applications" hint="Including drafts" />
        <Metric label="Pending review" value={data.cards.pendingReview} icon={Inbox} tone="info" to="/applications?status=SUBMITTED" hint="Submitted, not yet reviewed" />
        <Metric label="Under review" value={data.cards.underReview} icon={ScanSearch} tone="warning" to="/applications?status=UNDER_REVIEW" hint="Including info requested" />
        <Metric label="Offers issued" value={data.cards.offersIssued} icon={BadgeCheck} tone="success" to="/applications?status=OFFER_ISSUED" hint="All offers ever issued" />
        <Metric label="Accepted offers" value={data.cards.offersAccepted} icon={CheckCircle2} tone="success" to="/applications?status=OFFER_ACCEPTED" hint="All acceptances recorded" />
        <Metric label="Rejected" value={data.cards.rejected} icon={XCircle} tone="danger" to="/applications?status=REJECTED" />
        <Metric label="Enrolled students" value={data.cards.enrolled} icon={GraduationCap} tone="success" to="/applications?status=ENROLLED" />
      </div>
      <div className="dashboard-grid">
        <Card className="panel span-2"><div className="panel-head"><h2>Application submissions</h2><small>Last 12 weeks · Singapore time</small></div>
          <ColumnSeries points={data.overTime} period="week" label="Applications submitted per week" /></Card>
        <Card className="panel"><h2>Admission rates</h2>
          <div className="rates">
            <RateMeter label="Offer rate" value={data.rates.offerRate} numerator={data.cards.offersIssued} denominator={data.rates.submitted} definition="offers ÷ submitted" />
            <RateMeter label="Offer acceptance rate" value={data.rates.acceptanceRate} numerator={data.cards.offersAccepted} denominator={data.cards.offersIssued} definition="accepted ÷ offers" />
            <RateMeter label="Rejection rate" value={data.rates.rejectionRate} numerator={data.cards.rejected} denominator={data.rates.submitted} definition="rejected ÷ submitted" />
          </div></Card>
        <Card className="panel span-2"><h2>Application status distribution</h2><StatusStack statuses={data.statuses} href={status => '/applications' + query({ status })} /></Card>
        <Card className="panel"><h2>Applications by programme</h2>
          <BarList items={data.byProgramme} total={data.cards.totalApplications} href={id => '/applications' + query({ programmeId: id })} emptyText="No applications yet." /></Card>
        <Card className="panel"><h2>Applications by intake</h2>
          <BarList items={data.byIntake} href={id => '/intakes/' + id} emptyText="No applications yet." /></Card>
        <Card className="panel span-2"><div className="panel-head"><h2>Programme capacity utilisation</h2><small>Academic year {data.academicYear} · enrolled ÷ capacity</small></div>
          {data.utilisation.length ? <ul className="capacity-list">{data.utilisation.map(item => <li key={item.id}>
            <Link className="text-link" to={'/intakes/' + item.id}><span className="mono">{item.programme}</span> {item.name}</Link>
            <CapacityBar capacity={item.capacity} enrolled={item.enrolled} accepted={item.accepted} />
          </li>)}</ul> : <p className="reading-empty">No intakes in {data.academicYear}.</p>}</Card>
      </div>
      <div className="dashboard-grid">
        <Card className="panel"><div className="panel-head"><h2><AlertTriangle size={17} aria-hidden="true" /> Requires attention</h2><Link className="text-link" to="/applications?attention=true">View all</Link></div>
          {data.attention.length ? <ul className="feed">{data.attention.map(item => <li key={item.id}><Link to={'/applications/' + item.id}>
            <span><strong>{item.applicantName}</strong><small><span className="mono">{item.reference}</span> · {item.reason}</small></span><Badge>{item.status}</Badge></Link></li>)}</ul>
            : <p className="reading-empty">Nothing needs attention right now.</p>}</Card>
        <Card className="panel"><h2><CalendarClock size={17} aria-hidden="true" /> Upcoming deadlines</h2>
          {data.deadlines.length ? <ul className="feed">{data.deadlines.map(item => <li key={item.kind + item.id}><Link to={(item.kind === 'INTAKE_CLOSING' ? '/intakes/' : '/applications/') + item.id}>
            <span><strong>{item.title}</strong><small>{item.kind === 'INTAKE_CLOSING' ? 'Applications close' : 'Offer response due'} · {item.kind === 'INTAKE_CLOSING' ? dateOnly(item.date) : calendarDate(String(item.date).slice(0, 10))}</small></span>
            <span className="deadline-chip" data-overdue={Date.parse(item.date) < Date.now() || undefined}>{relative(item.kind === 'INTAKE_CLOSING' ? item.date : String(item.date).slice(0, 10) + 'T23:59:59+08:00')}</span></Link></li>)}</ul>
            : <p className="reading-empty">No deadlines in the next few weeks.</p>}</Card>
        <Card className="panel"><div className="panel-head"><h2><Hourglass size={17} aria-hidden="true" /> Recent applications</h2><Link className="text-link" to="/applications?sort=updatedAt">View all</Link></div>
          {data.recentApplications.length ? <ul className="feed">{data.recentApplications.map(item => <li key={item.id}><Link to={'/applications/' + item.id}>
            <span><strong>{item.applicantName}</strong><small><span className="mono">{item.reference}</span> · {item.programmeCode} · {relative(item.createdAt)}</small></span><Badge>{item.status}</Badge></Link></li>)}</ul>
            : <p className="reading-empty">No applications yet.</p>}</Card>
        <Card className="panel"><h2><BadgeCheck size={17} aria-hidden="true" /> Recent admission decisions</h2>
          {data.recentDecisions.length ? <ul className="feed">{data.recentDecisions.map(item => <li key={item.id}><Link to={'/applications/' + item.applicationId}>
            <span><strong>{item.applicantName}</strong><small>{statusText(item.status)} by {item.actorName ?? 'System'} · {relative(item.occurredAt)}</small></span><Badge>{item.status}</Badge></Link></li>)}</ul>
            : <p className="reading-empty">No decisions recorded yet.</p>}</Card>
        {data.recentActivity && <Card className="panel span-2"><div className="panel-head"><h2>Recent administrative activity</h2><Link className="text-link" to="/activity">Activity Logs</Link></div>
          <ul className="feed">{data.recentActivity.map(item => <li key={item.id}><div className="feed-static">
            <span><strong>{item.description}</strong><small>{item.actorName ?? 'System'} · {relative(item.occurredAt)}</small></span></div></li>)}</ul></Card>}
      </div>
    </>}</Resource>
  </>;
}
