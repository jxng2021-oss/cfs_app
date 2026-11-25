# Implementation and verification

| Area | Implementation |
| --- | --- |
| F01 Authentication and authorisation | Administrator provisioning, Argon2id, PostgreSQL-backed sessions and rate limits, compulsory password change, reset, deactivation, CSRF, role and object-level access, and administrative audit. |
| F02 Modules and learning content | Module lifecycle, enrolment, lecturer reassignment, roster, ordered topics, text/link/file materials, published content and completion. |
| F03 Assignments | Private staged uploads, deadlines and late policies, submission limits, versioned receipts, idempotency, grading locks, marking and feedback. |
| F04 Quizzes | Draft question and option editing, timed or untimed attempts, persisted shuffle and selections, autosave revisions, exact expiry, automatic grading and controlled answer review. |
| F05 Gradebook | Weight budget, private drafts, individual and bulk release, append-only revisions, weighted totals, missing/pending separation and student/lecturer views. |
| F06 Conditional release | Topic completion and exact released quiz thresholds, combined prerequisites, frozen published settings and direct route/download enforcement. |
| F07 Dashboards and analytics | Student progress and upcoming deadlines, lecturer submission and score metrics, configurable review rules, denominators, distribution and drill-down links. |
| F08 Announcements | Scoped draft, publish, pin, edit and archive with read-only module history. |
| Delivery | Docker Compose, Linux/amd64 image builds, GitHub Actions verification and GHCR publication. AWS CloudFormation and a manual lab runbook. |

## Acceptance coverage

| Cases | Automated coverage |
| --- | --- |
| T01–T04 and T08 | PostgreSQL provisioning, generic login failures, compulsory password change, session rotation/revocation and CSRF. |
| T05–T07 | Peer submission/attempt/file denial, cross-lecturer and administrator isolation. |
| T09–T18 | Draft visibility, enrolment history, transfer, read-only archives, publication validation, progress and content access. These cases share the module/content, quiz and archive integration scenarios. |
| T19–T28 | Assignment window boundaries, wrong or oversized files, concurrency, idempotency, grading source, zero scores, private drafts and published revisions. |
| T29–T40 | Question validation, clipped and persisted timers/order, starts, revision conflicts, expiry reconciliation, best retakes, review eligibility and hidden manual releases. |
| T41–T45 and T68 | Concurrent weight budgets and unit checks for the exact example, released coverage, closed missing work, unresolved submissions and practice exclusion. |
| T46–T50 | Server-validated earlier-topic constraints, combined topic/quiz gates, exact threshold comparisons, protected materials, files and assessment writes. |
| T51–T58 | Empty metrics, 9 of 12 submission opportunities, distinct review flags, eligibility, locked and accessible progress, analytics settings changes and role isolation. |
| T59–T62 | Staged cleanup, safely rendered text and allowed URL schemes, live-attempt guards, archival confirmation and published-grade isolation. |
| T63–T67 | Optimistic edits, frozen archive time, no answer-key leakage, login and upload limits, and released-best-only review. |
| T69–T70 | Shared lifecycle locking and announcement visibility and mutability. |

The Chromium journeys cover provisioning and enrolment, responsive navigation and keyboard dialogs, lesson and quiz publishing, prerequisite unlocking, file submission, private marking and publication, and learner and lecturer results.

## Verification boundary

The application and migrations are exercised against real local and CI PostgreSQL databases. Local upload/download tests use private temporary storage. The AWS template is checked statically with cfn-lint. Live AWS instance replacement, scaling, RDS and native S3 evidence require deployment in the lab. The repository includes the steps for collecting that evidence. Institutional load certification, malware scanning, and deployment with actual academic records are outside this prototype.
