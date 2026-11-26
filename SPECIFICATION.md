# CFS Admissions — Specification

What the system stores, the rules it enforces, how statistics are calculated, and the API that implements them.

## 1. Data model

Defined in [`migrations/006-admissions.sql`](migrations/006-admissions.sql). All primary keys are UUIDs; timestamps are `timestamptz`.

| Table | Purpose | Key rules |
| --- | --- | --- |
| `users` | Staff accounts | `role` ∈ ADMIN, OFFICER, VIEWER; unique normalised email; Argon2id hash |
| `sessions`, `login_limits` | Server-side sessions and rate limits | Shared by every instance |
| `programmes` | Degree, diploma or certificate offered | Unique `code`; status ACTIVE, INACTIVE, ARCHIVED; minimum qualification and optional minimum GPA (0–4) |
| `admission_intakes` | An admission window for one programme | `closes_at > opens_at`; `capacity` 1–100,000; status UPCOMING, OPEN, CLOSED, COMPLETED, CANCELLED; unique name per programme |
| `applicants` | Prospective student | Human ID `APL-001001`; unique email; status ACTIVE, ON_HOLD, ARCHIVED; GPA 0–4 |
| `applications` | One application by an applicant to a programme intake | Unique reference; composite foreign key guarantees the intake belongs to the programme; one live application per applicant per intake (withdrawn ones excepted) |
| `application_status_history` | Every status change | From, to, user, reason, time |
| `application_notes` | Internal review notes | Author and time |
| `audit_events` | Activity log | Append-only: a trigger rejects UPDATE and DELETE |
| `system_settings` | Institution and workflow settings | Key/value JSON, validated by the API |

Relationships: an applicant has many applications; a programme has many intakes and applications; an intake has many applications; an application has many history entries and notes; a user performs many activities. Records with history are archived, not deleted: applicants, programmes and intakes can only be deleted while nothing references them, and only draft applications can be deleted.

## 2. Application workflow

| Action (API path) | From | To | Notes |
| --- | --- | --- | --- |
| `submit` | Draft | Submitted | Intake must be OPEN; applicant not archived |
| `start-review` | Submitted | Under review | Assigns the acting user as reviewer if none |
| `request-information` | Under review | Additional information required | Reason required |
| `resume-review` | Additional information required | Under review | |
| `waitlist` | Under review | Waitlisted | Records decision WAITLISTED |
| `issue-offer` | Under review, Waitlisted | Offer issued | Sets the offer response deadline (default from settings); records decision OFFERED |
| `reject` | Under review, Waitlisted, Additional information required | Rejected | Reason required unless disabled in settings; records decision REJECTED |
| `accept-offer` | Offer issued | Offer accepted | Refused after the response deadline (officers can extend it) |
| `decline-offer` | Offer issued | Offer declined | |
| `enrol` | Offer accepted | Enrolled | Locks the intake; refused when confirmed enrolments have reached capacity |
| `withdraw` | Any non-final status | Withdrawn | Reason required |

Offer declined, Rejected, Withdrawn and Enrolled are final. The rules live in [`apps/api/app/domain.ts`](apps/api/app/domain.ts); the API rejects any other transition with `409 INVALID_TRANSITION`, so an application can never jump from Draft to Enrolled. Each transition writes a status history row and an activity log entry.

The programme and intake of an application can change only while it is Draft or Submitted. The reviewer can change until the application is final.

**Needs attention** flags: Submitted longer than the review target; awaiting additional information; offer response overdue or due within 3 days; offer accepted but enrolment not yet confirmed; under review with no reviewer.

## 3. Intakes and capacity

Intake status changes are manual and controlled: Upcoming → Open or Cancelled; Open → Closed or Cancelled; Closed → Open, Completed or Cancelled. Completed and cancelled intakes are read-only. Opening requires an active programme.

Capacity counts **confirmed enrolments**. Accepted offers are shown separately as likely enrolments. Enrolment runs in a transaction that locks the intake row (`SELECT … FOR UPDATE`) before counting, so two officers enrolling the last place at the same moment cannot both succeed. Capacity cannot be reduced below current enrolments.

## 4. Statistics

All figures are computed from application data on each request ([`apps/api/app/stats.ts`](apps/api/app/stats.ts)).

| Measure | Definition |
| --- | --- |
| Submitted | Applications that have left Draft |
| Offers issued | Applications that ever reached Offer issued (including those later accepted, declined, withdrawn or enrolled) |
| Offer rate | Offers issued ÷ submitted × 100 |
| Offer acceptance rate | Applications that ever reached Offer accepted ÷ offers issued × 100 |
| Rejection rate | Rejected ÷ submitted × 100 |
| Enrolment rate | Enrolled ÷ submitted × 100 |
| Intake utilisation | Confirmed enrolments ÷ intake capacity × 100 |
| Programme demand | Submitted applications ÷ total capacity of the programme's non-cancelled intakes in scope |
| Average processing time | Mean days from submission to the most recent admission decision (offer, waitlist or rejection) |

Rates are rounded to two decimals. A rate with a zero denominator is `null` and displayed as "—", never as 0%. Date filters apply to the submission date in Singapore time, so drafts drop out of date-filtered views.

## 5. API

All endpoints are under `/api`, return `{ data }` or `{ data, pagination }`, and report errors as `{ error: { code, message, fields?, requestId } }`. Changes require the session cookie, an `Origin` matching `APP_ORIGIN` and an `X-CSRF-Token` header. List endpoints accept `page`, `pageSize` (≤ 100), `sort` and `dir`.

| Resource | Endpoints |
| --- | --- |
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout`, `POST /auth/change-password` |
| Applicants | `GET /applicants` (`q`, `status`, `nationality`, `qualification`), `GET /applicants/nationalities`, `GET /applicants/export` (CSV; `ids` or filters), `GET/PATCH/DELETE /applicants/:id`, `POST /applicants`, `POST /applicants/:id/archive`, `POST /applicants/:id/restore` |
| Applications | `GET /applications` (`q`, `status`, `programmeId`, `intakeId`, `applicantId`, `reviewerId`, `attention`), `GET /applications/reviewers`, `POST /applications`, `GET/PATCH/DELETE /applications/:id`, `POST /applications/:id/{submit,start-review,request-information,resume-review,waitlist,issue-offer,reject,accept-offer,decline-offer,enrol,withdraw}`, `POST /applications/:id/notes` |
| Programmes | `GET /programmes` (`q`, `status`, `faculty`, `qualificationType`), `GET /programmes/faculties`, `POST /programmes`, `GET/PATCH/DELETE /programmes/:id` |
| Intakes | `GET /intakes` (`q`, `status`, `programmeId`, `academicYear`), `GET /intakes/years`, `POST /intakes`, `GET/PATCH/DELETE /intakes/:id`, `POST /intakes/:id/status` |
| Analytics | `GET /dashboard`, `GET /analytics` (`from`, `to`, `academicYear`, `faculty`, `programmeId`, `intakeId`, `status`), `GET /analytics/options` |
| Activity | `GET /activity` (`q`, `action`, `entityType`, `actorId`, `from`, `to`, `sort=newest|oldest`), `GET /activity/actions`, `GET /activity/:entityType/:entityId` |
| Settings | `GET /settings/public` (no sign-in), `GET /settings`, `PATCH /settings` |
| Users | `GET /users`, `POST /users`, `PATCH /users/:id`, `POST /users/:id/reset-password` |
| Infrastructure | `GET /infrastructure/instance` (public), `GET /infrastructure/status` |

Edits and workflow actions carry the record's `version`; a stale version returns `409 VERSION_CONFLICT`.

## 6. Activity log

Recorded actions include applicant created, updated, archived, restored and deleted; application created, updated, every status change (offer issued, rejected, offer acceptance and decline recorded, enrolment confirmed, withdrawn and so on) and review notes; programme and intake created, updated, archived, status changed and deleted; settings changed; user accounts created, role changed, deactivated, reactivated and password reset. Applicant updates record which fields changed, not personal values. Logo changes are recorded as "updated" without storing the image. Passwords, tokens and secrets are never logged.

## 7. Settings

| Setting | Effect |
| --- | --- |
| Institution name and logo | Sidebar, sign-in page, browser tab titles. The logo (PNG, JPEG or WebP ≤ 200 KB) is stored in the shared database |
| Default academic year | Pre-selected on Analytics and Admission Intakes; pre-fills new intakes |
| Offer response window (days) | Default offer response deadline |
| Review target (days) | When a submitted application is flagged as needing attention |
| Require rejection reason | Whether rejecting needs a reason |
| Reference prefix and year | Format of new application references (`ADM-2026-000123` or `ADM-000123`) |
| Date format | Day month year or ISO, for everyone |
| Student admin number | Sidebar footer and Infrastructure Status |
| Table density | Per browser: comfortable or compact tables |
