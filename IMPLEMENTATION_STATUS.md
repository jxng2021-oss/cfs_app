# Implementation status

| Requirement | Status |
| --- | --- |
| Foundation | Same-origin React/Express, PostgreSQL migrations, DB clock, local and S3 storage adapters, Secrets Manager configuration, health checks, development seed and container pipeline. |
| F01 Authentication and authorisation | Account provisioning, Argon2id, DB sessions and failed-login limits, password changes/reset, account status, CSRF, scoped access and administrative audit. Deactivation checks for active quiz attempts are pending the quiz engine. |
| F02 Modules and learning content | Module lifecycle, ownership transfer, enrolment, lecturer roster, text/HTTPS materials, publication, ordering and student completion. Private material upload/download, assessment links and deadline display are pending. Archive and withdrawal guards for future assessment records are pending. |
| F03 Assignments | Pending. |
| F04 Quizzes | Pending. |
| F05 Gradebook | Pending. |
| F06 Conditional release | Pending. Published topics are available to enrolled students. |
| F07 Analytics and dashboards | Student topic/module completion counts implemented. Lecturer analytics, grade summaries, and assessment deadlines are pending. |
| F08 Announcements | Optional and pending. |

## Acceptance coverage

| Cases | Current check |
| --- | --- |
| T01–T04, T08 | PostgreSQL integration checks for provisioning, sign-in failures, compulsory password change, session rotation/revocation and CSRF. |
| T06, T09–T11 | PostgreSQL checks for lecturer isolation, role restrictions, draft visibility, enrolment history and lecturer transfer. |
| T12, T14–T16, T18 | PostgreSQL checks for read-only content archive, required-material publication, draft text/link isolation, idempotent completion and denominator changes. T12/T15 also require future assessment, grading and file tests. |
| T17 | Optional-material denial verified. Gated-material denial awaits conditional release. |
| T50, T60 | Frozen published material edits, raw text rendering and rejection of unsafe URI schemes, with future assessment/rules coverage pending. |
| T63 | Stale module version conflict checked. |
| T66 | Failed-login limit and session timing checked. Upload quota remains pending. |
| T05, T07, T13, T19–T49, T51–T59, T61–T62, T64–T65, T67–T69 | Pending applicable assignment, quiz, grading, conditional release, analytics or upload implementation. |
| T70 | Optional announcement coverage pending. |

The first browser journey covers provision, enrol, activate, publish learning content, student password change, completion and wrong-module access. The assessment-to-grade-to-analytics browser journey awaits those features.
