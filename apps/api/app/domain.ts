/** Admissions domain rules shared by the API, seed data and tests. Pure functions only. */

export const qualifications = ['SECONDARY', 'PRE_UNIVERSITY', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE'] as const;
export type Qualification = typeof qualifications[number];
export const qualificationLabels: Record<Qualification, string> = {
  SECONDARY: 'Secondary (GCE O-Level or equivalent)',
  PRE_UNIVERSITY: 'Pre-university (GCE A-Level, IB or equivalent)',
  DIPLOMA: 'Diploma',
  BACHELOR: "Bachelor's degree",
  MASTER: "Master's degree",
  DOCTORATE: 'Doctorate',
};
export const qualificationTypes = ['CERTIFICATE', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE'] as const;
export const programmeStatuses = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export const intakeStatuses = ['UPCOMING', 'OPEN', 'CLOSED', 'COMPLETED', 'CANCELLED'] as const;
export const applicantStatuses = ['ACTIVE', 'ON_HOLD', 'ARCHIVED'] as const;
export type IntakeStatus = typeof intakeStatuses[number];

export const applicationStatuses = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED', 'OFFER_ISSUED',
  'OFFER_ACCEPTED', 'OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED',
] as const;
export type ApplicationStatus = typeof applicationStatuses[number];

/** Statuses that end an application's lifecycle. */
export const terminalStatuses: readonly ApplicationStatus[] = ['OFFER_DECLINED', 'REJECTED', 'WITHDRAWN', 'ENROLLED'];
/** Statuses still awaiting admissions staff action. */
export const pendingStatuses: readonly ApplicationStatus[] = ['SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED'];

/** Workflow actions, the statuses they may start from, and the status they lead to. */
export const workflow = {
  submit: { from: ['DRAFT'], to: 'SUBMITTED', label: 'Submit application' },
  'start-review': { from: ['SUBMITTED'], to: 'UNDER_REVIEW', label: 'Begin review' },
  'request-information': { from: ['UNDER_REVIEW'], to: 'INFO_REQUIRED', label: 'Request additional information', reason: true },
  'resume-review': { from: ['INFO_REQUIRED'], to: 'UNDER_REVIEW', label: 'Resume review' },
  waitlist: { from: ['UNDER_REVIEW'], to: 'WAITLISTED', label: 'Waitlist' },
  'issue-offer': { from: ['UNDER_REVIEW', 'WAITLISTED'], to: 'OFFER_ISSUED', label: 'Issue offer' },
  reject: { from: ['UNDER_REVIEW', 'WAITLISTED', 'INFO_REQUIRED'], to: 'REJECTED', label: 'Reject' },
  'accept-offer': { from: ['OFFER_ISSUED'], to: 'OFFER_ACCEPTED', label: 'Record offer acceptance' },
  'decline-offer': { from: ['OFFER_ISSUED'], to: 'OFFER_DECLINED', label: 'Record offer decline' },
  enrol: { from: ['OFFER_ACCEPTED'], to: 'ENROLLED', label: 'Confirm enrolment' },
  withdraw: {
    from: ['DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'INFO_REQUIRED', 'WAITLISTED', 'OFFER_ISSUED', 'OFFER_ACCEPTED'],
    to: 'WITHDRAWN', label: 'Withdraw application', reason: true,
  },
} as const satisfies Record<string, { from: readonly ApplicationStatus[]; to: ApplicationStatus; label: string; reason?: boolean }>;
export type WorkflowAction = keyof typeof workflow;
export const workflowActions = Object.keys(workflow) as WorkflowAction[];

export class TransitionError extends Error {}

/** The status an action leads to, or a TransitionError if the action is not valid from the current status. */
export function transition(current: ApplicationStatus, action: WorkflowAction): ApplicationStatus {
  const rule = workflow[action];
  if (!(rule.from as readonly ApplicationStatus[]).includes(current)) {
    throw new TransitionError(`An application that is ${statusLabel(current).toLowerCase()} cannot move to ${statusLabel(rule.to).toLowerCase()}.`);
  }
  return rule.to;
}

/** Actions available from a status, in the order they should be offered. */
export function availableActions(current: ApplicationStatus): WorkflowAction[] {
  return workflowActions.filter(action => (workflow[action].from as readonly ApplicationStatus[]).includes(current));
}

/** The admission decision recorded when an application reaches a status. */
export function decisionFor(status: ApplicationStatus): 'OFFERED' | 'WAITLISTED' | 'REJECTED' | null {
  if (status === 'OFFER_ISSUED') return 'OFFERED';
  if (status === 'WAITLISTED') return 'WAITLISTED';
  if (status === 'REJECTED') return 'REJECTED';
  return null;
}

export function statusLabel(status: ApplicationStatus) {
  return ({
    DRAFT: 'Draft', SUBMITTED: 'Submitted', UNDER_REVIEW: 'Under review', INFO_REQUIRED: 'Additional information required',
    WAITLISTED: 'Waitlisted', OFFER_ISSUED: 'Offer issued', OFFER_ACCEPTED: 'Offer accepted', OFFER_DECLINED: 'Offer declined',
    REJECTED: 'Rejected', WITHDRAWN: 'Withdrawn', ENROLLED: 'Enrolled',
  } as const)[status];
}

/** Manual intake status changes. Dates do not change status by themselves; staff open and close admissions explicitly. */
export const intakeTransitions: Record<IntakeStatus, readonly IntakeStatus[]> = {
  UPCOMING: ['OPEN', 'CANCELLED'],
  OPEN: ['CLOSED', 'CANCELLED'],
  CLOSED: ['OPEN', 'COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
};

export function qualificationRank(value: Qualification) {
  return qualifications.indexOf(value);
}

/** Whether an applicant meets a programme's minimum qualification and GPA. A missing GPA cannot satisfy a GPA minimum. */
export function requirementCheck(
  applicant: { highestQualification: Qualification; gpa: string | null },
  programme: { minimumQualification: Qualification; minimumGpa: string | null },
) {
  const qualification = qualificationRank(applicant.highestQualification) >= qualificationRank(programme.minimumQualification);
  const gpa = programme.minimumGpa === null ? null : applicant.gpa !== null && Number(applicant.gpa) >= Number(programme.minimumGpa);
  return { qualification, gpa, met: qualification && gpa !== false };
}

/** Percentage with two decimals, or null when the denominator is zero. */
export function rate(numerator: number, denominator: number) {
  if (!denominator) return null;
  return Math.round((numerator / denominator) * 10_000) / 100;
}

/** e.g. ADM-2026-000042 or ADM-000042. */
export function formatReference(prefix: string, includeYear: boolean, year: number, sequence: number) {
  return prefix + '-' + (includeYear ? year + '-' : '') + String(sequence).padStart(6, '0');
}
