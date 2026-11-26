# CFS Admissions

A university **Student Admissions and Applicant Management System** for admissions officers and administrators. Staff manage prospective students, take applications through a validated review workflow, run programmes and admission intakes with enforced capacity, and monitor admissions analytics. It is built to run on a highly available AWS deployment (Application Load Balancer, EC2 Auto Scaling across two Availability Zones, shared PostgreSQL).

All data shipped with the project is fictional. Demo email addresses use the reserved `example.test` domain.

## Features

| Area | What staff can do |
| --- | --- |
| Overview | Live summary cards, submissions over time, applications by programme and intake, status distribution, admission rates, capacity utilisation, items needing attention, upcoming deadlines, recent decisions and activity, quick actions |
| Applicants | Create, view, edit, archive/restore and (when unused) delete applicants. Search, filter by status/nationality/qualification, sort any column, paginate, bulk-select and export CSV. Profile shows personal, contact and academic details, applications, internal notes and activity history |
| Applications | Create (draft or submitted), assign programme/intake/reviewer, review with context-sensitive actions, review notes, status timeline, requirement check against the programme, offer response deadlines |
| Workflow | Draft → Submitted → Under review → Offer issued → Offer accepted → Enrolled, with Additional information required, Waitlisted, Rejected, Offer declined and Withdrawn. Every transition is validated on the server and recorded with previous/new status, time, user and reason |
| Programmes | Create, edit, deactivate, archive and (when unused) delete. Intakes, applications and admission statistics per programme |
| Admission intakes | Create and edit windows and capacity, open/close/complete/cancel admissions, monitor remaining places, per-intake statistics. Enrolment is blocked at capacity, including under concurrent requests |
| Analytics | Filters for date range, academic year, faculty, programme, intake and status. Applications over time, by nationality, programme, faculty and intake; status distribution; offer, acceptance, rejection and enrolment rates; programme demand; intake utilisation; average processing time |
| Activity Logs | Append-only record of every administrative action with search, filters, sorting and pagination (administrators) |
| Infrastructure Status | Serving EC2 instance, Availability Zone, Region, version, environment, health, database latency, server start time, last load-balancer health check, and a 10-request sampler that shows ALB distribution across instances |
| Settings | Institution name and logo, default academic year, offer response window, review target, rejection-reason rule, reference number format, date format, student admin number, users and roles, personal table density, password |

### Roles

| Role | Access |
| --- | --- |
| Administrator | Everything, including programmes, intakes, users and roles, settings and the Activity Logs |
| Admissions officer | Applicants and applications: create, edit, review and record decisions. Read-only on programmes and intakes |
| Read-only viewer | View records, dashboards and analytics; no changes |

Permissions are enforced by the API (`403 FORBIDDEN`); the interface hides actions a role cannot use.

## Architecture

- **Single Node.js 22 service** (Express 5, TypeScript) serving the JSON API under `/api` and the compiled React 19 interface.
- **PostgreSQL** is the only state: business data, sessions, CSRF tokens, login rate limits, settings (including the logo) and the activity log. Any instance can serve any request, so instances are interchangeable and replaceable.
- **Authentication:** server-side sessions in PostgreSQL with HttpOnly cookies, CSRF tokens, Argon2id password hashing, idle and absolute timeouts, and database-backed login rate limiting that works across instances.
- **Concurrency:** optimistic `version` checks on every edit (`409 VERSION_CONFLICT`); enrolment locks the intake row so confirmed enrolments never exceed capacity.
- **Times** are stored in UTC and shown in Singapore time.

```
apps/api/app/   API: domain.ts (workflow rules), applicants, applications, programmes, intakes, analytics, stats,
                activity, settings, users, infrastructure, auth, http, db, cli, demo-data
apps/web/src/   React pages: overview, applicants, applications, programmes, intakes, analytics, activity,
                infrastructure, settings; shared ui.tsx, charts.tsx and shadcn components
migrations/     SQL migrations (006-admissions.sql defines the admissions schema)
infra/aws/      CloudFormation template and deployment guide
tests/          unit (domain rules), integration (API against PostgreSQL), e2e (Playwright)
SPECIFICATION.md   data model, workflow, statistics and API
```

See [SPECIFICATION.md](SPECIFICATION.md) for the data model, workflow, analytics definitions and API, and [infra/aws/ARCHITECTURE.md](infra/aws/ARCHITECTURE.md) for the high-availability design.

## Run locally with Docker

Requires Docker Desktop.

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Paste the generated value into `SESSION_PEPPER` and set `DEMO_PASSWORD` to at least 12 characters. Optionally set `STUDENT_ADMIN_NUMBER`.

```bash
docker compose up -d --build
docker compose exec app node dist/api/cli.js migrate
docker compose exec app node dist/api/cli.js seed
```

Open <http://localhost:3000>. Every demo account uses your `DEMO_PASSWORD`:

| Account | Role |
| --- | --- |
| `admin@example.test` | Administrator |
| `officer-a@example.test`, `officer-b@example.test` | Admissions officers |
| `viewer@example.test` | Read-only viewer |

The seed creates 8 programmes across 4 faculties, 24 intakes (past, open and upcoming), 72 fictional applicants, about 95 applications in every status with consistent histories, review notes and activity logs. It runs only when no programmes exist and is disabled when `NODE_ENV=production`.

`docker compose down` stops the stack and keeps the database volume. To reset the local data, run `docker compose down -v` and repeat the migrate and seed steps.

### Upgrading a database from the former LMS

Migration `006-admissions.sql` converts an existing LMS database in place. It keeps user accounts, sessions and user-account history; maps `LECTURER` accounts to `OFFICER` and `STUDENT` accounts to `VIEWER`; and **removes all learning data** (modules, content, assessments, submissions, grades and file records), which has no admissions equivalent. Take a database snapshot first if that data matters. The local Compose file uses a new `admissions-database` volume, so an old LMS volume is left untouched.

## Run without Docker

With Node 22 and a PostgreSQL instance reachable from `DATABASE_URL`:

```bash
npm ci
npm run build
npm run migrate
npm run seed      # development only
npm start         # or: npm run dev
```

## Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Shared PostgreSQL connection string |
| `SESSION_PEPPER` | Yes | At least 32 random characters; identical on every instance |
| `APP_ORIGIN` | Yes | Exact public origin, e.g. `https://admissions.example.edu` or the ALB URL |
| `PORT` | No | Default `3000` |
| `TRUST_PROXY` | No | `true` behind the ALB so client IPs and HTTPS are read correctly |
| `COOKIE_SECURE` | No | Must match the `APP_ORIGIN` protocol; defaults from it |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | No | Session lifetimes (60 minutes, 12 hours) |
| `SECRET_ID` | No | Secrets Manager secret supplying `DATABASE_URL` and `SESSION_PEPPER` |
| `INSTANCE_ID`, `AVAILABILITY_ZONE`, `AWS_REGION` | No | Serving instance identity, written by the launch template from IMDSv2 |
| `INSTANCE_METADATA` | No | `imds` makes the server look up its instance ID and zone with IMDSv2 at startup when they are not supplied |
| `APP_ENVIRONMENT`, `APP_VERSION` | No | Labels on Infrastructure Status (version defaults to `package.json`) |
| `STUDENT_ADMIN_NUMBER` | No | Default for the admin number shown in the sidebar (editable in Settings) |
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | Bootstrap only | First administrator for a real deployment |
| `DEMO_PASSWORD`, `DEMO_CLOCK_ISO` | Seed only | Demo account password; optional fixed clock for demo dates |

Never commit `.env`. On AWS, secrets come from Secrets Manager.

## Tests

Integration and browser tests need a dedicated PostgreSQL database whose name ends in `_test`:

```bash
docker run --detach --name cfs-admissions-test --publish 127.0.0.1:55433:5432 \
  --env POSTGRES_USER=admissions --env POSTGRES_PASSWORD=local-test-db-only --env POSTGRES_DB=admissions_test postgres:18-alpine

npm run lint
npm run typecheck
npm test                    # domain rules: workflow, requirements, rates, references
npm run test:integration    # API against PostgreSQL in an isolated schema
npm run build && npm run test:e2e   # Playwright; seeds the test database
```

Set `TEST_DATABASE_URL` to use a different `_test` database. Integration tests create and drop their own schema. Browser tests migrate and seed the test database and can be re-run against it.

## Health and instance endpoints

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /health` | Public | Liveness for the ALB target group; no database call, returns `200 {"status":"ok"}` |
| `GET /health/ready` | Public | Readiness: `200` when the shared database answers within 1 s, else `503` |
| `GET /api/infrastructure/instance` | Public | Instance ID, zone, region, version, environment, start time. No credentials, tokens or configuration |
| `GET /api/infrastructure/status` | Signed in | Adds health, database latency and the last load-balancer health check |

Every response from an EC2 instance also carries `X-Served-By: <instance-id> <zone>`.

## AWS deployment

The [deployment guide](infra/aws/README.md) walks through the CloudFormation stack (VPC, two AZs, ALB, Auto Scaling group with target tracking, launch template, encrypted EBS, private RDS PostgreSQL, CloudWatch Logs), database roles, migrations, bootstrapping the first administrator, enabling the fleet and verifying load balancing and instance replacement.
