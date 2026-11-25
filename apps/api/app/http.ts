import type { Request, Response } from 'express';
import { z } from 'zod';

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Record<string, string>) {
    super(message);
  }
}

export function invalid(message = 'One or more fields are invalid.', fields?: Record<string, string>): never {
  throw new ApiError(422, 'VALIDATION_ERROR', message, fields);
}

export function notFound(): never {
  throw new ApiError(404, 'NOT_FOUND', 'This resource could not be found.');
}

export function read<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  return invalid(undefined, Object.fromEntries(result.error.issues.map(issue => [issue.path.join('.') || 'request', issue.message])));
}

export function id(req: Request, name: string) {
  return read(z.uuid(), req.params[name]);
}

export function data(res: Response, value: unknown, status = 200) {
  res.status(status).json({ data: value });
}

export const pageFields = {
  page: z.coerce.number().int().min(1).max(1_000_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export function paged(res: Response, rows: unknown[], total: number, page: number, pageSize: number) {
  res.json({ data: rows, pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) } });
}

export function pgError(error: unknown, code: string, constraint?: string) {
  if (!error || typeof error !== 'object') return false;
  return 'code' in error && error.code === code && (!constraint || ('constraint' in error && error.constraint === constraint));
}

export const safeText = (max: number) => z.string().trim().min(1).max(max);
export const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
export const version = z.number().int().positive();
export const empty = z.strictObject({});
