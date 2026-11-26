import { useState } from 'react';
import { Link } from 'react-router-dom';
import { BadgeCheck, CheckCircle2, ClipboardList, GraduationCap, Timer, XCircle } from 'lucide-react';
import { get, query, type Breakdown, type Funnel, type StatusCount, type Utilisation } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Input } from './components/ui/input.js';
import { NativeSelect, NativeSelectOption } from './components/ui/native-select.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { BarList, CapacityBar, ColumnSeries, RateMeter, StatusStack } from './charts.js';
import { useBranding } from './branding.js';
import { Heading, Metric, Resource, applicationStatusOrder, calendarDate, percent, statusText, useResource } from './ui.js';

type AnalyticsData = {
  filters: { from: string; to: string }; period: 'week' | 'month'; summary: Funnel; statuses: StatusCount[]; overTime: { period: string; count: number }[];
  byNationality: Breakdown[]; byProgramme: Breakdown[]; byFaculty: Breakdown[]; byIntake: Breakdown[]; utilisation: Utilisation[];
  demand: { id: string; code: string; name: string; applications: number; capacity: number; ratio: number | null }[];
};
type Options = { years: string[]; faculties: string[]; programmes: { id: string; code: string; name: string; faculty: string }[]; intakes: { id: string; name: string; programmeId: string; academicYear: string; programmeCode: string }[] };

export function Analytics() {
  const { settings } = useBranding();
  const empty = { from: '', to: '', academicYear: '', faculty: '', programmeId: '', intakeId: '', status: '' };
  const [filters, setFilters] = useState({ ...empty, academicYear: settings.defaultAcademicYear });
  const set = (key: keyof typeof filters, value: string) => setFilters(current => ({
    ...current, [key]: value,
    ...(key === 'faculty' ? { programmeId: '', intakeId: '' } : {}), ...(key === 'programmeId' || key === 'academicYear' ? { intakeId: '' } : {}),
  }));
  const path = '/analytics' + query(filters);
  const state = useResource(() => get<AnalyticsData>(path), path);
  const options = useResource(() => get<Options>('/analytics/options'), 'analytics-options');
  const programmes = options.value?.programmes.filter(item => !filters.faculty || item.faculty === filters.faculty) ?? [];
  const intakes = options.value?.intakes.filter(item => (!filters.programmeId || item.programmeId === filters.programmeId) && (!filters.academicYear || item.academicYear === filters.academicYear)) ?? [];
  const active = Object.values(filters).some(Boolean);
  return <>
    <Heading title="Admissions analytics" detail="Filter to a period, faculty, programme or intake. Date filters use the submission date, so drafts are excluded when a date is set." />
    <Card className="panel filter-panel">
      <div className="filters">
        <label>From<Input type="date" value={filters.from} max={filters.to || undefined} onChange={event => set('from', event.target.value)} /></label>
        <label>To<Input type="date" value={filters.to} min={filters.from || undefined} onChange={event => set('to', event.target.value)} /></label>
        <label>Academic year<NativeSelect value={filters.academicYear} onChange={event => set('academicYear', event.target.value)}>
          <NativeSelectOption value="">All years</NativeSelectOption>{options.value?.years.map(year => <NativeSelectOption key={year} value={year}>{year}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Faculty<NativeSelect value={filters.faculty} onChange={event => set('faculty', event.target.value)}>
          <NativeSelectOption value="">All faculties</NativeSelectOption>{options.value?.faculties.map(value => <NativeSelectOption key={value} value={value}>{value}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Programme<NativeSelect value={filters.programmeId} onChange={event => set('programmeId', event.target.value)}>
          <NativeSelectOption value="">All programmes</NativeSelectOption>{programmes.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.code} · {item.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Intake<NativeSelect value={filters.intakeId} onChange={event => set('intakeId', event.target.value)}>
          <NativeSelectOption value="">All intakes</NativeSelectOption>{intakes.map(item => <NativeSelectOption key={item.id} value={item.id}>{item.programmeCode} · {item.name}</NativeSelectOption>)}
        </NativeSelect></label>
        <label>Status<NativeSelect value={filters.status} onChange={event => set('status', event.target.value)}>
          <NativeSelectOption value="">All statuses</NativeSelectOption>{applicationStatusOrder.map(status => <NativeSelectOption key={status} value={status}>{statusText(status)}</NativeSelectOption>)}
        </NativeSelect></label>
        {active && <Button variant="ghost" onClick={() => setFilters(empty)}>Clear filters</Button>}
      </div>
    </Card>
    <Resource state={state}>{data => {
      const s = data.summary;
      return <>
        <div className="metrics metrics-4">
          <Metric label="Applications" value={s.totalApplications} icon={ClipboardList} hint={s.submitted + ' submitted'} />
          <Metric label="Offers issued" value={s.offersIssued} icon={BadgeCheck} tone="success" hint={'Offer rate ' + percent(s.offerRate)} />
          <Metric label="Offers accepted" value={s.offersAccepted} icon={CheckCircle2} tone="success" hint={'Acceptance rate ' + percent(s.acceptanceRate)} />
          <Metric label="Enrolled" value={s.enrolled} icon={GraduationCap} tone="success" hint={'Enrolment rate ' + percent(s.enrolmentRate)} />
          <Metric label="Rejected" value={s.rejected} icon={XCircle} tone="danger" hint={'Rejection rate ' + percent(s.rejectionRate)} />
          <Metric label="Avg. processing time" value={s.averageProcessingDays === null ? '—' : s.averageProcessingDays + ' days'} icon={Timer} hint="Submission to latest decision" />
        </div>
        <div className="dashboard-grid">
          <Card className="panel span-2"><div className="panel-head"><h2>Applications over time</h2><small>Per {data.period} · {calendarDate(data.filters.from)} to {calendarDate(data.filters.to)}</small></div>
            <ColumnSeries points={data.overTime} period={data.period} label={'Applications submitted per ' + data.period} /></Card>
          <Card className="panel"><h2>Rates</h2><div className="rates">
            <RateMeter label="Offer rate" value={s.offerRate} numerator={s.offersIssued} denominator={s.submitted} definition="offers issued ÷ submitted applications" />
            <RateMeter label="Offer acceptance rate" value={s.acceptanceRate} numerator={s.offersAccepted} denominator={s.offersIssued} definition="accepted offers ÷ offers issued" />
            <RateMeter label="Rejection rate" value={s.rejectionRate} numerator={s.rejected} denominator={s.submitted} definition="rejected ÷ submitted applications" />
            <RateMeter label="Enrolment rate" value={s.enrolmentRate} numerator={s.enrolled} denominator={s.submitted} definition="enrolled ÷ submitted applications" />
          </div></Card>
          <Card className="panel span-3"><h2>Application status distribution</h2><StatusStack statuses={data.statuses} /></Card>
          <Card className="panel"><h2>By programme</h2><BarList items={data.byProgramme} total={s.totalApplications} href={id => '/programmes/' + id} /></Card>
          <Card className="panel"><h2>By faculty</h2><BarList items={data.byFaculty} total={s.totalApplications} /></Card>
          <Card className="panel"><h2>Applicants by nationality</h2><BarList items={data.byNationality} total={s.totalApplications} /></Card>
          <Card className="panel"><h2>By intake</h2><BarList items={data.byIntake} href={id => '/intakes/' + id} /></Card>
          <Card className="panel span-2"><div className="panel-head"><h2>Programme demand</h2><small>Submitted applications per available place</small></div>
            {data.demand.length ? <div className="table-wrap flush"><Table>
              <TableHeader><TableRow><TableHead scope="col">Programme</TableHead><TableHead scope="col">Applications</TableHead><TableHead scope="col">Places</TableHead><TableHead scope="col">Applications per place</TableHead></TableRow></TableHeader>
              <TableBody>{data.demand.map(row => <TableRow key={row.id}>
                <TableHead scope="row"><Link className="text-link" to={'/programmes/' + row.id}><span className="mono">{row.code}</span> {row.name}</Link></TableHead>
                <TableCell>{row.applications}</TableCell><TableCell>{row.capacity || '—'}</TableCell>
                <TableCell><span className="demand" data-high={(row.ratio ?? 0) >= 1 || undefined}>{row.ratio === null ? '—' : row.ratio.toFixed(2)}</span></TableCell>
              </TableRow>)}</TableBody>
            </Table></div> : <p className="chart-empty">No data for this selection.</p>}</Card>
          <Card className="panel span-3"><div className="panel-head"><h2>Intake capacity utilisation</h2><small>Confirmed enrolments ÷ capacity · lighter segment = accepted offers awaiting enrolment</small></div>
            {data.utilisation.length ? <ul className="capacity-list">{data.utilisation.map(item => <li key={item.id}>
              <Link className="text-link" to={'/intakes/' + item.id}><span className="mono">{item.programme}</span> {item.name}</Link>
              <CapacityBar capacity={item.capacity} enrolled={item.enrolled} accepted={item.accepted} />
              <span className="utilisation-value">{percent(item.utilisation)}</span>
            </li>)}</ul> : <p className="chart-empty">No intakes for this selection.</p>}</Card>
        </div>
      </>;
    }}</Resource>
  </>;
}
