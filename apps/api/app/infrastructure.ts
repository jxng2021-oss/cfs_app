import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { Router } from 'express';
import type { Services } from './auth.js';
import { data } from './http.js';

/** Identity of the instance serving this process. Values are null when genuinely unknown, never invented. */
type Identity = { instanceId: string | null; availabilityZone: string | null; region: string | null; source: 'environment' | 'imds' | 'none' };

const startedAt = new Date();
let lastHealthCheckAt: Date | null = null;
let identity: Identity = fromEnvironment();

function fromEnvironment(): Identity {
  const instanceId = /^i-[a-f0-9]{8,17}$/.test(process.env.INSTANCE_ID ?? '') ? process.env.INSTANCE_ID! : null;
  const availabilityZone = /^[a-z]{2}-[a-z]+-\d[a-z]$/.test(process.env.AVAILABILITY_ZONE ?? '') ? process.env.AVAILABILITY_ZONE! : null;
  const region = /^[a-z]{2}-[a-z]+-\d$/.test(process.env.AWS_REGION ?? '') ? process.env.AWS_REGION! : availabilityZone?.slice(0, -1) ?? null;
  return { instanceId, availabilityZone, region, source: instanceId ? 'environment' : 'none' };
}

/**
 * Optional IMDSv2 lookup at startup (INSTANCE_METADATA=imds) for hosts whose bootstrap did not pass the identity in.
 * The token and metadata stay on the server; only the instance ID, zone and region are kept.
 */
export async function resolveIdentity(env = process.env) {
  if (identity.instanceId || env.INSTANCE_METADATA !== 'imds') return identity;
  const base = 'http://169.254.169.254/latest';
  try {
    const signal = AbortSignal.timeout(1500);
    const token = await (await fetch(base + '/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal })).text();
    const read = async (path: string) => {
      const response = await fetch(base + '/meta-data/' + path, { headers: { 'X-aws-ec2-metadata-token': token }, signal: AbortSignal.timeout(1500) });
      return response.ok ? (await response.text()).trim() : null;
    };
    const [instanceId, availabilityZone] = await Promise.all([read('instance-id'), read('placement/availability-zone')]);
    if (instanceId && /^i-[a-f0-9]{8,17}$/.test(instanceId)) {
      identity = { instanceId, availabilityZone, region: availabilityZone?.slice(0, -1) ?? null, source: 'imds' };
    }
  } catch {
    console.warn(JSON.stringify({ event: 'instance_metadata_unavailable' }));
  }
  return identity;
}

export const currentIdentity = () => identity;
export const markHealthCheck = () => { lastHealthCheckAt = new Date(); };

function packageVersion() {
  try {
    return (JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}
const version = (process.env.APP_VERSION ?? '').trim().slice(0, 40) || packageVersion();

function instance() {
  return {
    instanceId: identity.instanceId,
    availabilityZone: identity.availabilityZone,
    region: identity.region,
    identitySource: identity.source,
    deployment: identity.instanceId ? 'AWS EC2' : 'Local development',
    environment: (process.env.APP_ENVIRONMENT ?? '').trim().slice(0, 40) || process.env.NODE_ENV || 'development',
    version,
    host: hostname().slice(0, 64),
    startedAt,
    uptimeSeconds: Math.round(process.uptime()),
    serverTime: new Date(),
  };
}

/** Public: lets anyone (or curl through the load balancer) see which instance answered. Contains no credentials. */
export function publicInfrastructureRoutes() {
  const router = Router();
  router.get('/infrastructure/instance', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    data(res, instance());
  });
  return router;
}

export function infrastructureRoutes({ pool }: Services) {
  const router = Router();
  router.get('/infrastructure/status', async (_req, res) => {
    const start = performance.now();
    let database: { status: 'available' | 'unavailable'; latencyMs: number | null };
    try {
      await pool.query('SELECT 1');
      database = { status: 'available', latencyMs: Math.round((performance.now() - start) * 10) / 10 };
    } catch {
      database = { status: 'unavailable', latencyMs: null };
    }
    res.set('Cache-Control', 'no-store');
    data(res, {
      ...instance(),
      health: database.status === 'available' ? 'healthy' : 'degraded',
      database,
      lastHealthCheckAt,
      healthEndpoint: '/health',
      readinessEndpoint: '/health/ready',
    });
  });
  return router;
}
