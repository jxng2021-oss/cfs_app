import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { activityRoutes } from './activity.js';
import { analyticsRoutes } from './analytics.js';
import { applicantRoutes } from './applicants.js';
import { applicationRoutes } from './applications.js';
import { authRoutes, type Services } from './auth.js';
import { ApiError, notFound } from './http.js';
import { currentIdentity, infrastructureRoutes, markHealthCheck, publicInfrastructureRoutes } from './infrastructure.js';
import { intakeRoutes } from './intakes.js';
import { programmeRoutes } from './programmes.js';
import { publicSettingsRoute, settingsRoutes } from './settings.js';
import { userRoutes } from './users.js';

export function createApp(services: Services, webRoot = resolve('dist/web')) {
  const app = express();
  app.disable('x-powered-by');
  if (services.config.TRUST_PROXY) app.set('trust proxy', 1);
  app.use(helmet({
    strictTransportSecurity: services.config.COOKIE_SECURE ? undefined : false,
    contentSecurityPolicy: { directives: { upgradeInsecureRequests: services.config.COOKIE_SECURE ? [] : null } },
  }));
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const start = performance.now();
    res.locals.requestId = requestId;
    res.set('X-Request-Id', requestId);
    const { instanceId, availabilityZone } = currentIdentity();
    // Shows which instance behind the load balancer answered, e.g. `curl -I <alb>/health`.
    if (instanceId) res.set('X-Served-By', instanceId + (availabilityZone ? ' ' + availabilityZone : ''));
    res.once('finish', () => {
      if (services.config.NODE_ENV === 'test') return;
      console.info(JSON.stringify({
        requestId, method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode,
        durationMs: Math.round(performance.now() - start), actorId: res.locals.viewer?.user.id,
        instanceId: currentIdentity().instanceId, availabilityZone: currentIdentity().availabilityZone,
      }));
    });
    next();
  });
  // Liveness for the load balancer: cheap, no database call, so a slow database never takes every instance out of service.
  app.get('/health', (_req, res) => {
    markHealthCheck();
    res.set('Cache-Control', 'no-store').json({ status: 'ok', instanceId: currentIdentity().instanceId });
  });
  // Readiness: the instance can reach the shared database.
  app.get('/health/ready', async (_req, res) => {
    markHealthCheck();
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        services.pool.query('SELECT 1'),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Readiness timeout')), 1000); }),
      ]);
      res.set('Cache-Control', 'no-store').json({ status: 'ready' });
    } catch {
      res.status(503).set('Cache-Control', 'no-store').json({ status: 'unavailable' });
    } finally {
      clearTimeout(timeout);
    }
  });

  const api = Router();
  api.use(express.json({ limit: '1mb' }));
  api.use(
    publicSettingsRoute(services), publicInfrastructureRoutes(),
    authRoutes(services),
    applicantRoutes(services), applicationRoutes(services), programmeRoutes(services), intakeRoutes(services),
    analyticsRoutes(services), activityRoutes(services), settingsRoutes(services), userRoutes(services), infrastructureRoutes(services),
  );
  app.use('/api', api, notFound);
  app.use('/health', notFound);

  if (existsSync(resolve(webRoot, 'index.html'))) {
    app.use('/assets', express.static(resolve(webRoot, 'assets'), { immutable: true, maxAge: '1y', fallthrough: false }));
    app.get('/{*path}', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile('index.html', { root: webRoot }));
  }
  app.use(notFound);
  const errorHandler: ErrorRequestHandler = (error: unknown, _req, res, next) => {
    if (res.headersSent) { next(error); return; }
    const known = error instanceof ApiError ? error : null;
    const upstreamStatus = error && typeof error === 'object' && 'status' in error ? error.status : undefined;
    const status = known?.status ?? (upstreamStatus === 400 || upstreamStatus === 404 || upstreamStatus === 413 ? upstreamStatus : 500);
    const code = known?.code ?? ({ 400: 'BAD_REQUEST', 404: 'NOT_FOUND', 413: 'PAYLOAD_TOO_LARGE', 500: 'INTERNAL_ERROR' } as const)[status as 400 | 404 | 413 | 500];
    const message = known?.message ?? (status === 400 ? 'Malformed request.' : status === 413 ? 'The request is too large.' : status === 404 ? 'This resource could not be found.' : 'The request could not be completed.');
    if (status === 500) {
      console.error(JSON.stringify({ requestId: res.locals.requestId, event: 'request_error', errorType: error instanceof Error ? error.name : typeof error,
        databaseCode: error && typeof error === 'object' && 'code' in error ? error.code : undefined }));
    }
    res.status(status).set('Cache-Control', 'no-store').json({ error: { code, message, fields: known?.fields, requestId: res.locals.requestId } });
  };
  app.use(errorHandler);
  return app;
}
