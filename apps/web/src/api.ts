export type Role = 'ADMIN' | 'OFFICER' | 'VIEWER';
export type User = { id: string; email: string; displayName: string; role: Role };
export type AdminUser = User & { isActive: boolean; mustChangePassword: boolean };
export type Session = { user: User; csrfToken: string; mustChangePassword: boolean; expiresAt: string };
export type Page<T> = { data: T[]; pagination: { page: number; pageSize: number; totalPages: number; total: number } };

export type Qualification = 'SECONDARY' | 'PRE_UNIVERSITY' | 'DIPLOMA' | 'BACHELOR' | 'MASTER' | 'DOCTORATE';
export type ApplicationStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_REVIEW' | 'INFO_REQUIRED' | 'WAITLISTED' | 'OFFER_ISSUED'
  | 'OFFER_ACCEPTED' | 'OFFER_DECLINED' | 'REJECTED' | 'WITHDRAWN' | 'ENROLLED';
export type IntakeStatus = 'UPCOMING' | 'OPEN' | 'CLOSED' | 'COMPLETED' | 'CANCELLED';

export type Applicant = {
  id: string; applicantNumber: string; firstName: string; lastName: string; fullName: string; email: string; phone: string;
  dateOfBirth: string; nationality: string; address: string; previousInstitution: string; highestQualification: Qualification;
  gpa: string | null; status: 'ACTIVE' | 'ON_HOLD' | 'ARCHIVED'; remarks: string; version: number; createdAt: string; updatedAt: string;
  archivedAt: string | null; applicationCount?: number;
};
export type Programme = {
  id: string; code: string; name: string; faculty: string; qualificationType: string; description: string; durationMonths: number;
  admissionRequirements: string; minimumQualification: Qualification; minimumGpa: string | null; status: 'ACTIVE' | 'INACTIVE' | 'ARCHIVED';
  version: number; createdAt: string; updatedAt: string; intakeCount?: number; applicationCount?: number;
};
export type Intake = {
  id: string; programmeId: string; programmeCode?: string; programmeName?: string; name: string; academicYear: string; opensAt: string;
  closesAt: string; commencesOn: string; capacity: number; status: IntakeStatus; version: number; createdAt: string; updatedAt: string;
  enrolled: number; acceptedOffers: number; applications: number; remainingCapacity: number; utilisation: number | null;
};
export type ApplicationSummary = {
  id: string; reference: string; status: ApplicationStatus; decision: string | null; submittedAt: string | null; decidedAt: string | null;
  offerResponseDeadline: string | null; updatedAt: string; createdAt: string; version: number;
  applicant: { id: string; name: string; applicantNumber: string };
  programme: { id: string; code: string; name: string };
  intake: { id: string; name: string };
  reviewer: { id: string; name: string } | null;
  attention: string | null;
};
export type Funnel = {
  totalApplications: number; submitted: number; pending: number; offersIssued: number; offersAccepted: number; offersDeclined: number;
  rejected: number; enrolled: number; withdrawn: number; offerRate: number | null; acceptanceRate: number | null;
  rejectionRate: number | null; enrolmentRate: number | null; averageProcessingDays: number | null;
};
export type StatusCount = { status: ApplicationStatus; count: number };
export type Breakdown = { key: string; label: string; count: number };
export type Utilisation = { id: string; name: string; programme: string; capacity: number; enrolled: number; accepted: number; applications: number; status: string; utilisation: number | null; remaining: number };
export type ActivityEntry = { id: string; action: string; entityType: string; entityId: string | null; description: string; occurredAt: string; metadata: Record<string, unknown>; actorId: string | null; actorName: string | null };
export type PublicSettings = { institutionName: string; institutionLogo: string | null; dateFormat: 'DAY_MONTH_YEAR' | 'ISO'; adminNumber: string; defaultAcademicYear: string };
export type Settings = PublicSettings & {
  offerResponseDays: number; requireRejectionReason: boolean; reviewTargetDays: number; referencePrefix: string; referenceIncludeYear: boolean;
};

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly fields?: Record<string, string>) { super(message); }
}

async function request<T>(path: string, method = 'GET', body?: unknown, csrf?: string): Promise<T> {
  const headers = new Headers({ Accept: 'application/json' });
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  if (csrf) headers.set('X-CSRF-Token', csrf);
  const response = await fetch('/api' + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && path !== '/auth/login' && path !== '/auth/me') window.dispatchEvent(new Event('session-expired'));
    const fields = payload.error?.fields as Record<string, string> | undefined;
    const detail = fields && !fields.request ? Object.entries(fields).map(([key, value]) => key + ': ' + value).join('; ') : '';
    const message = fields?.request ?? ((payload.error?.message ?? 'The request could not be completed.') + (detail && payload.error?.code === 'VALIDATION_ERROR' ? ' (' + detail + ')' : ''));
    throw new ApiError(response.status, payload.error?.code ?? 'REQUEST_FAILED', message, fields);
  }
  return response.status === 204 ? undefined as T : response.json();
}

export const get = async <T,>(path: string) => (await request<{ data: T }>(path)).data;
export const list = <T,>(path: string) => request<Page<T>>(path);
export const mutate = async <T,>(path: string, method: string, body?: unknown, csrf?: string) =>
  (await request<{ data: T } | undefined>(path, method, body, csrf))?.data as T;

/** Query string from an object, dropping empty values. */
export function query(values: Record<string, string | number | boolean | undefined | null>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  const text = params.toString();
  return text ? '?' + text : '';
}
