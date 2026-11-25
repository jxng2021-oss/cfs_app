import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import argon2 from 'argon2';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { type Clock, type Db, transaction } from './db.js';
import { ApiError, data, email, empty, read } from './http.js';

export const roles = ['ADMIN', 'LECTURER', 'STUDENT'] as const;
export type Role = typeof roles[number];
export type UserRow = {
  id: string; email_normalized: string; display_name: string; role: Role; is_active: boolean;
  must_change_password: boolean; password_hash: string;
};
type SessionRow = UserRow & { last_seen_at: Date; expires_at: Date; csrf_token_hash: string };
type Viewer = { user: SessionRow; tokenHash: string; csrfToken: string };
export type Services = { pool: pg.Pool; config: Config; clock: Clock };

const cookieName = 'lms_session';
const tokenFormat = /^[A-Za-z0-9_-]{43}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const sign = (pepper: string, value: string) => createHmac('sha256', pepper).update(value).digest('base64url');
const token = () => randomBytes(32).toString('base64url');
const argonOptions = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;
export const hashPassword = (password: string) => argon2.hash(password, argonOptions);
export const temporaryPassword = () => randomBytes(18).toString('base64url');
const dummyHash = hashPassword(token());

const countCodePoints = (value: string) => [...value].length;
export const chosenPassword = z.string().max(256).refine(value => countCodePoints(value) >= 12 && countCodePoints(value) <= 128, 'Use 12–128 characters');
const suppliedPassword = z.string().min(1).max(256);
const loginFields = z.strictObject({ email, password: suppliedPassword });
const changeFields = z.strictObject({ currentPassword: suppliedPassword, newPassword: chosenPassword });

export function userDto(row: UserRow) {
  return { id: row.id, email: row.email_normalized, displayName: row.display_name, role: row.role };
}

export function adminUserDto(row: UserRow) {
  return { ...userDto(row), isActive: row.is_active, mustChangePassword: row.must_change_password };
}

function cookieOptions(config: Config) {
  return { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: config.COOKIE_SECURE };
}

function requestToken(req: Request) {
  const found = req.headers.cookie?.split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '='));
  const value = found?.length === 1 ? found[0].slice(cookieName.length + 1) : '';
  return tokenFormat.test(value) ? value : undefined;
}

function checkOrigin(req: Request, origin: string) {
  if (req.get('origin') !== origin) throw new ApiError(403, 'CSRF_INVALID', 'The request origin could not be verified.');
}

function responseSession(row: UserRow, csrfToken: string, expiresAt: Date) {
  return { user: userDto(row), mustChangePassword: row.must_change_password, csrfToken, expiresAt };
}

async function issueSession(db: Db, config: Config, user: UserRow, now: Date) {
  const raw = token();
  const csrf = sign(config.SESSION_PEPPER, 'csrf:' + raw);
  const expires = new Date(now.getTime() + config.SESSION_ABSOLUTE_HOURS * 3_600_000);
  await db.query(
    'INSERT INTO sessions (token_hash, csrf_token_hash, user_id, last_seen_at, expires_at) VALUES ($1, $2, $3, $4, $5)',
    [hash(raw), hash(csrf), user.id, now, expires],
  );
  return { raw, data: responseSession(user, csrf, expires) };
}

export function viewer(res: Response): Viewer {
  return res.locals.viewer as Viewer;
}

function authentication({ pool, config, clock }: Services): RequestHandler {
  return async (req, res, next) => {
    const raw = requestToken(req);
    if (!raw) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in.');
    const tokenHash = hash(raw);
    const now = await clock(pool);
    const result = await pool.query<SessionRow>(
      `SELECT u.*, s.last_seen_at, s.expires_at, s.csrf_token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND u.is_active
         AND s.expires_at > $2 AND s.last_seen_at > $3`,
      [tokenHash, now, new Date(now.getTime() - config.SESSION_IDLE_MINUTES * 60_000)],
    );
    const user = result.rows[0];
    if (!user) throw new ApiError(401, 'UNAUTHENTICATED', 'Your session has expired. Please sign in.');
    const csrfToken = sign(config.SESSION_PEPPER, 'csrf:' + raw);
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      checkOrigin(req, config.APP_ORIGIN);
      const requestCsrf = req.get('x-csrf-token');
      if (!requestCsrf || !tokenFormat.test(requestCsrf) ||
          !timingSafeEqual(Buffer.from(hash(requestCsrf), 'hex'), Buffer.from(user.csrf_token_hash, 'hex'))) {
        throw new ApiError(403, 'CSRF_INVALID', 'The security token is missing or invalid.');
      }
    }
    if (now.getTime() - user.last_seen_at.getTime() >= 1000) {
      await pool.query('UPDATE sessions SET last_seen_at = $2 WHERE token_hash = $1 AND last_seen_at < $2 AND revoked_at IS NULL', [tokenHash, now]);
    }
    res.locals.viewer = { user, tokenHash, csrfToken } satisfies Viewer;
    res.set('Cache-Control', 'no-store');
    next();
  };
}

export const requireRole = (...permitted: Role[]): RequestHandler => (_req, res, next) => {
  if (!permitted.includes(viewer(res).user.role)) throw new ApiError(403, 'FORBIDDEN', 'Your role cannot perform this action.');
  next();
};

const requireChangedPassword: RequestHandler = (_req, res, next) => {
  if (viewer(res).user.must_change_password) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Change your temporary password first.');
  next();
};

export async function revokeSessions(db: Db, userId: string, now: Date) {
  await db.query('UPDATE sessions SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL', [userId, now]);
}

type LimitRow = { key: string; failures: number; window_ends_at: Date };

export function authRoutes(services: Services) {
  const { pool, config, clock } = services;
  const router = Router();

  router.post('/auth/login', async (req, res) => {
    checkOrigin(req, config.APP_ORIGIN);
    if (!req.is('application/json')) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Submit JSON.');
    const input = read(loginFields, req.body);
    const emailKey = 'e:' + sign(config.SESSION_PEPPER, input.email);
    const ipKey = 'i:' + sign(config.SESSION_PEPPER, req.ip ?? req.socket.remoteAddress ?? 'unknown');
    const keys = [emailKey, ipKey];
    const result = await transaction(pool, async db => {
      await db.query(
        "INSERT INTO login_limits (key, failures, window_ends_at) SELECT key, 0, TIMESTAMPTZ 'epoch' FROM unnest($1::text[]) AS key ORDER BY key ON CONFLICT DO NOTHING",
        [keys],
      );
      const { rows } = await db.query<LimitRow>('SELECT * FROM login_limits WHERE key = ANY($1) ORDER BY key FOR UPDATE', [keys]);
      const now = await clock(db);
      const active = rows.filter(row => row.window_ends_at > now);
      const blocked = active.filter(row => row.failures >= (row.key === emailKey ? 10 : 60));
      if (blocked.length) {
        return { retryAfter: Math.max(1, Math.ceil((Math.max(...blocked.map(row => row.window_ends_at.getTime())) - now.getTime()) / 1000)) };
      }
      const user = (await db.query<UserRow>('SELECT * FROM users WHERE email_normalized = $1 FOR UPDATE', [input.email])).rows[0];
      const matches = await argon2.verify(user?.password_hash ?? await dummyHash, input.password);
      if (!user?.is_active || !matches) {
        await db.query(
          `UPDATE login_limits SET failures = CASE WHEN window_ends_at <= $2 THEN 1 ELSE failures + 1 END,
             window_ends_at = CASE WHEN window_ends_at <= $2 THEN $2::timestamptz + interval '15 minutes' ELSE window_ends_at END
           WHERE key = ANY($1)`, [keys, now],
        );
        return {};
      }
      await db.query('UPDATE login_limits SET failures = 0 WHERE key = $1', [emailKey]);
      return { session: await issueSession(db, config, user, now) };
    });
    res.set('Cache-Control', 'no-store');
    if (result.retryAfter) {
      res.set('Retry-After', String(result.retryAfter));
      throw new ApiError(429, 'RATE_LIMITED', 'Too many attempts. Please try again later.');
    }
    if (!result.session) throw new ApiError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
    res.cookie(cookieName, result.session.raw, cookieOptions(config));
    data(res, result.session.data);
  });

  router.use(authentication(services));
  router.get('/auth/me', (_req, res) => {
    const state = viewer(res);
    data(res, responseSession(state.user, state.csrfToken, state.user.expires_at));
  });
  router.post('/auth/logout', async (req, res) => {
    read(empty, req.body ?? {});
    await pool.query('UPDATE sessions SET revoked_at = clock_timestamp() WHERE token_hash = $1 AND revoked_at IS NULL', [viewer(res).tokenHash]);
    res.clearCookie(cookieName, cookieOptions(config)).status(204).end();
  });
  router.post('/auth/change-password', async (req, res) => {
    const input = read(changeFields, req.body);
    if (input.currentPassword === input.newPassword) throw new ApiError(422, 'VALIDATION_ERROR', 'Choose a different password.');
    const state = viewer(res);
    const passwordHash = await hashPassword(input.newPassword);
    const session = await transaction(pool, async db => {
      const current = (await db.query<UserRow>('SELECT * FROM users WHERE id = $1 FOR UPDATE', [state.user.id])).rows[0];
      const now = await clock(db);
      const valid = (await db.query('SELECT 1 FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2 AND last_seen_at > $3',
        [state.tokenHash, now, new Date(now.getTime() - config.SESSION_IDLE_MINUTES * 60_000)])).rowCount;
      if (!current?.is_active || !valid) throw new ApiError(401, 'UNAUTHENTICATED', 'Please sign in again.');
      if (!(await argon2.verify(current.password_hash, input.currentPassword))) throw new ApiError(422, 'VALIDATION_ERROR', 'The current password is incorrect.');
      const updated = (await db.query<UserRow>(
        'UPDATE users SET password_hash = $2, must_change_password = false, updated_at = $3 WHERE id = $1 RETURNING *',
        [current.id, passwordHash, now],
      )).rows[0];
      await revokeSessions(db, current.id, now);
      return issueSession(db, config, updated, now);
    });
    res.cookie(cookieName, session.raw, cookieOptions(config));
    data(res, session.data);
  });
  router.use(requireChangedPassword);
  return router;
}
