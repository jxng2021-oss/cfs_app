import { useCallback, useEffect, useState } from 'react';
import { Activity, Cloud, Database, Gauge, HeartPulse, MapPin, RefreshCw, Server, Tag } from 'lucide-react';
import { get } from './api.js';
import { Button } from './components/ui/button.js';
import { Card } from './components/ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './components/ui/table.js';
import { useBranding } from './branding.js';
import { Details, ErrorMessage, Heading, dateTime, relative } from './ui.js';

type Status = {
  instanceId: string | null; availabilityZone: string | null; region: string | null; identitySource: 'environment' | 'imds' | 'none';
  deployment: string; environment: string; version: string | null; host: string; startedAt: string; uptimeSeconds: number; serverTime: string;
  health: 'healthy' | 'degraded'; database: { status: 'available' | 'unavailable'; latencyMs: number | null }; lastHealthCheckAt: string | null;
};
type Sample = { at: string; instanceId: string | null; zone: string | null; ms: number };

const unavailable = (local: boolean) => local ? 'Local development' : 'Unavailable';
const uptime = (seconds: number) => {
  const days = Math.floor(seconds / 86400), hours = Math.floor((seconds % 86400) / 3600), minutes = Math.floor((seconds % 3600) / 60);
  return [days && days + 'd', (days || hours) && hours + 'h', minutes + 'm'].filter(Boolean).join(' ');
};

/** Live status of the instance that served this request. Nothing here is simulated: missing values say so. */
export function Infrastructure() {
  const { settings } = useBranding();
  const [status, setStatus] = useState<Status | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [samples, setSamples] = useState<Sample[]>([]);
  const [sampling, setSampling] = useState(false);
  const refresh = useCallback(async () => {
    setError('');
    const start = performance.now();
    try {
      const value = await get<Status>('/infrastructure/status');
      setLatency(Math.round(performance.now() - start));
      setStatus(value);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The status could not be loaded.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
  }, [refresh]);
  // Fresh requests through the load balancer: with two or more healthy instances, different instance IDs appear.
  async function sample() {
    setSampling(true);
    const results: Sample[] = [];
    for (let index = 0; index < 10; index += 1) {
      const start = performance.now();
      try {
        const response = await fetch('/api/infrastructure/instance', { cache: 'no-store', headers: { Accept: 'application/json' } });
        const { data } = await response.json() as { data: Status };
        results.push({ at: new Date().toISOString(), instanceId: data.instanceId, zone: data.availabilityZone, ms: Math.round(performance.now() - start) });
      } catch {
        results.push({ at: new Date().toISOString(), instanceId: null, zone: null, ms: Math.round(performance.now() - start) });
      }
      setSamples([...results]);
    }
    setSampling(false);
  }
  const local = status?.deployment === 'Local development';
  const distinct = new Set(samples.map(item => item.instanceId ?? 'unknown'));
  return <>
    <Heading title="Infrastructure status" detail="Which server answered this page, and whether it is healthy. Refreshes every 15 seconds."
      action={<Button variant="outline" onClick={() => void refresh()}><RefreshCw aria-hidden="true" />Refresh</Button>} />
    <ErrorMessage message={error} />
    <div className="metrics metrics-4">
      <div className="metric"><span className="metric-icon" data-tone={status ? (status.health === 'healthy' ? 'success' : 'danger') : undefined} aria-hidden="true"><HeartPulse size={18} /></span>
        <span><span className="metric-label">Application health</span><span className="metric-value">{status ? (status.health === 'healthy' ? 'Healthy' : 'Degraded') : '…'}</span><small>{status ? 'Database ' + status.database.status : 'Checking'}</small></span></div>
      <div className="metric"><span className="metric-icon" data-tone="info" aria-hidden="true"><Server size={18} /></span>
        <span><span className="metric-label">Serving instance</span><span className="metric-value mono small-value">{status ? status.instanceId ?? unavailable(local) : '…'}</span><small>{status?.deployment}</small></span></div>
      <div className="metric"><span className="metric-icon" aria-hidden="true"><MapPin size={18} /></span>
        <span><span className="metric-label">Availability Zone</span><span className="metric-value small-value">{status ? status.availabilityZone ?? unavailable(local) : '…'}</span><small>Region {status?.region ?? unavailable(local)}</small></span></div>
      <div className="metric"><span className="metric-icon" aria-hidden="true"><Gauge size={18} /></span>
        <span><span className="metric-label">Server response time</span><span className="metric-value">{latency === null ? '…' : latency + ' ms'}</span><small>Measured by your browser · DB {status?.database.latencyMs ?? '—'} ms</small></span></div>
    </div>
    <div className="detail-grid two">
      <Card className="panel"><h2><Cloud size={17} aria-hidden="true" /> Deployment</h2>
        {status && <Details items={[
          ['Environment', status.environment], ['Application version', status.version ?? 'Unavailable'], ['Deployment', status.deployment],
          ['EC2 instance ID', <span className="mono">{status.instanceId ?? unavailable(local)}</span>], ['Availability Zone', status.availabilityZone ?? unavailable(local)],
          ['AWS Region', status.region ?? unavailable(local)], ['Identity source', status.identitySource === 'none' ? 'Not configured' : status.identitySource === 'imds' ? 'EC2 instance metadata (IMDSv2, server-side)' : 'Launch configuration'],
          ['Host / container', <span className="mono">{status.host}</span>], ['Student admin number', settings.adminNumber || 'Not set (Settings → General)'],
        ]} />}
      </Card>
      <Card className="panel"><h2><Activity size={17} aria-hidden="true" /> Health</h2>
        {status && <Details items={[
          ['Health status', status.health === 'healthy' ? 'Healthy · ready to serve traffic' : 'Degraded · database unreachable'],
          ['Database', <span><Database size={14} aria-hidden="true" /> {status.database.status}{status.database.latencyMs !== null ? ' · ' + status.database.latencyMs + ' ms' : ''}</span>],
          ['Server started', dateTime(status.startedAt) + ' (' + relative(status.startedAt) + ')'], ['Uptime', uptime(status.uptimeSeconds)],
          ['Last load balancer health check', status.lastHealthCheckAt ? dateTime(status.lastHealthCheckAt) + ' (' + relative(status.lastHealthCheckAt) + ')' : local ? 'None yet (no load balancer locally)' : 'None received by this instance yet'],
          ['Health endpoints', <span className="mono">GET /health · GET /health/ready</span>],
        ]} />}
      </Card>
    </div>
    <Card className="panel">
      <div className="panel-head"><div><h2><Tag size={17} aria-hidden="true" /> Load balancer distribution</h2>
        <p className="muted">Sends 10 fresh requests to <span className="mono">/api/infrastructure/instance</span>. Behind an Application Load Balancer with two or more healthy instances, different instance IDs should appear.</p></div>
        <Button onClick={() => void sample()} disabled={sampling}>{sampling ? 'Sampling…' : 'Sample 10 requests'}</Button></div>
      {samples.length > 0 && <>
        <p className="sample-summary"><strong>{distinct.size}</strong> distinct instance{distinct.size === 1 ? '' : 's'} answered {samples.length} request{samples.length === 1 ? '' : 's'}.</p>
        <div className="table-wrap flush"><Table>
          <TableHeader><TableRow><TableHead scope="col">#</TableHead><TableHead scope="col">Instance</TableHead><TableHead scope="col">Availability Zone</TableHead><TableHead scope="col">Round trip</TableHead></TableRow></TableHeader>
          <TableBody>{samples.map((item, index) => <TableRow key={item.at + index}>
            <TableCell>{index + 1}</TableCell><TableCell className="mono">{item.instanceId ?? unavailable(local)}</TableCell><TableCell>{item.zone ?? unavailable(local)}</TableCell><TableCell>{item.ms} ms</TableCell>
          </TableRow>)}</TableBody>
        </Table></div>
      </>}
    </Card>
  </>;
}
