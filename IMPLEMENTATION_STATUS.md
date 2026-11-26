# Implementation status

| Area | Status | Evidence |
| --- | --- | --- |
| P0 Admissions dashboard | Done | `apps/web/src/overview.tsx`, `GET /api/dashboard`; figures computed from application data |
| P0 Applicant CRUD, search, filters, sorting, bulk export | Done | `applicants.ts`, `applicants.tsx`; integration tests for search, sort, CSV, archive and delete rules |
| P0 Application CRUD and validated workflow | Done | `domain.ts`, `applications.ts`; unit tests for every transition; integration test for the full path and invalid transitions |
| P0 Programme management | Done | `programmes.ts`, `programmes.tsx` |
| P0 Admission intakes and capacity | Done | `intakes.ts`; integration test for concurrent enrolment at capacity |
| P0 Health checks and instance identification | Done | `/health`, `/health/ready`, `/api/infrastructure/instance`, `X-Served-By`; Infrastructure Status page |
| P0 AWS compatibility | Done | Stateless instances, shared PostgreSQL sessions and rate limits, `infra/aws/stack.yaml` (cfn-lint clean) |
| P1 Application review experience | Done | Requirement check, context-sensitive actions, notes, status timeline, decisions |
| P1 Admissions analytics | Done | `stats.ts`, `analytics.ts`; definitions in `SPECIFICATION.md`; integration test for rates and zero denominators |
| P1 Activity logs | Done | Append-only `audit_events` (database trigger), searchable Activity Logs page |
| P1 Roles | Done | ADMIN, OFFICER, VIEWER enforced by the API; integration test for permissions |
| P1 Settings | Done | Every setting has a documented effect; integration test for reference format and rejection reason |

## Known limitations

- Dark mode is not implemented; the interface has a single light theme.
- Intake status changes are manual (staff open and close admissions); the published dates do not change status automatically.
- There is no applicant-facing portal, email delivery, document upload or payment processing (out of scope).
- RDS is single-AZ in the lab template to control cost; Multi-AZ is the production upgrade.
