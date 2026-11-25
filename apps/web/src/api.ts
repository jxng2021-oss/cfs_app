export type User = { id: string; email: string; displayName: string; role: 'ADMIN' | 'LECTURER' | 'STUDENT' };
export type AdminUser = User & { isActive: boolean; mustChangePassword: boolean };
export type Session = { user: User; csrfToken: string; mustChangePassword: boolean; expiresAt: string };
export type Module = { id: string; code: string; name: string; term: string; description: string; status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED'; version: number };
export type AdminModule = Module & { lecturer: { id: string; displayName: string }; activeEnrolmentCount: number };
export type Enrolment = { studentId: string; displayName: string; status: 'ACTIVE' | 'WITHDRAWN' };
export type AuditEvent = { id: string; eventType: string; occurredAt: string; entityType: string; moduleId: string | null };
export type Page<T> = { data: T[]; pagination: { page: number; totalPages: number; total: number } };
export type FileMetadata = { id: string; originalFilename: string; sizeBytes: number; downloadUrl: string };

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Record<string,string>) { super(message); }
}

async function request<T>(path: string, method = 'GET', body?: unknown, csrf?: string, extra?: HeadersInit): Promise<T> {
  const headers = new Headers(extra);
  headers.set('Accept','application/json');
  const multipart = body instanceof FormData;
  if (body !== undefined && !multipart) headers.set('Content-Type', 'application/json');
  if (csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch('/api/v1' + path, { method, headers, body: body === undefined ? undefined : multipart ? body : JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('lms-session-expired'));
    const message = payload.error?.fields?.request ?? payload.error?.message ?? 'The request could not be completed.';
    throw new ApiError(response.status, payload.error?.code ?? 'REQUEST_FAILED', message, payload.error?.fields);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const get = async <T,>(path: string) => (await request<{ data: T }>(path)).data;
export const list = <T,>(path: string) => request<Page<T>>(path);
export const mutate = async <T,>(path: string, method: string, body?: unknown, csrf?: string, headers?: HeadersInit) =>
  (await request<{ data: T } | undefined>(path, method, body, csrf, headers))?.data as T;

export function stageFile(file: File, purpose: 'MATERIAL' | 'SUBMISSION', csrf: string) {
  const body = new FormData();
  body.set('purpose',purpose);
  body.set('file',file);
  return mutate<FileMetadata>('/files/stage','POST',body,csrf);
}
