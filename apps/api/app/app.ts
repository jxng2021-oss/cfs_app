import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import express, { Router, type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import { adminRoutes } from './admin.js';
import { authRoutes, type Services } from './auth.js';
import { contentRoutes } from './content.js';
import { ApiError, notFound } from './http.js';
import { moduleRoutes } from './modules.js';
import { createStorage } from './storage.js';
import { fileRoutes } from './files.js';
import { assessmentConfigRoutes } from './assessment-config.js';
import { assignmentRoutes } from './assignment-routes.js';
import { quizRoutes } from './quiz-routes.js';
import { gradeRoutes } from './grade-routes.js';
import { gradebookRoutes } from './gradebook.js';
import { releaseRoutes } from './release-routes.js';
import { analyticsRoutes } from './analytics.js';
import { announcementRoutes } from './announcements.js';

export function createApp(services: Services, webRoot = resolve('dist/web'), storage = createStorage(services.config)) {
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
    const { INSTANCE_ID, AVAILABILITY_ZONE } = process.env;
    if (INSTANCE_ID && AVAILABILITY_ZONE && /^i-[a-f0-9]+$/.test(INSTANCE_ID) && /^[a-z0-9-]+$/.test(AVAILABILITY_ZONE)) {
      res.set('X-Served-By', INSTANCE_ID + ' ' + AVAILABILITY_ZONE);
    }
    res.once('finish', () => {
      if (services.config.NODE_ENV === 'test') return;
      console.info(JSON.stringify({
        requestId, method: req.method, route: req.route?.path ?? 'unmatched', status: res.statusCode,
        durationMs: Math.round(performance.now() - start), actorId: res.locals.viewer?.user.id,
        instanceId: process.env.INSTANCE_ID, availabilityZone: process.env.AVAILABILITY_ZONE,
      }));
    });
    next();
  });
  app.get('/health', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.get('/health/ready', async (_req, res) => {
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
    authRoutes(services), adminRoutes(services), moduleRoutes(services), contentRoutes(services), fileRoutes(services,storage),
    assessmentConfigRoutes(services), assignmentRoutes(services), quizRoutes(services), gradeRoutes(services), gradebookRoutes(services),
    releaseRoutes(services), analyticsRoutes(services), announcementRoutes(services),
  );
  app.use('/api/v1', api);
  app.use('/api', notFound);
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
