# Mini LMS

A role-based learning management system for administrator-provisioned accounts, module enrolment and learning content. The first delivery runs a React client and Express API on one origin with PostgreSQL for application data and sessions. See [implementation status](IMPLEMENTATION_STATUS.md) for acceptance coverage and remaining work.

## Quick start with Docker

Use Docker Desktop or Docker Engine with Compose. Run these commands from the repository root in PowerShell.

```powershell
Copy-Item .env.example .env
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Paste the generated value into `SESSION_PEPPER` in `.env`. Set `DEMO_PASSWORD` to a local password of at least 12 characters, then run the stack.

```powershell
docker compose up -d db
docker compose build app
docker compose run --rm app node dist/api/cli.js migrate
docker compose run --rm app node dist/api/cli.js seed
docker compose up -d app
```

Open [Mini LMS](http://localhost:3000). Every seeded demo account uses your `DEMO_PASSWORD`. Try `admin@example.test`, `lecturer-a@example.test` and `student-a@example.test`. `lecturer-b@example.test` provides a separate ownership scope. `docker compose down` stops the stack and retains its PostgreSQL and upload volumes.

### Development with Node

Use Node.js 22.12+ in the 22.x series. Prepare `.env` as above and run:

```text
docker compose up -d db
npm ci
npm run build
npm run migrate
npm run seed
npm start
```

`npm run dev` rebuilds the client once and watches the API TypeScript files. Run `npm run build:web` again after changing the client. Compose publishes the development database on `127.0.0.1:55432`. If port 3000 is in use outside Compose, update `PORT` and `APP_ORIGIN` together.

Use a fresh database and `npm run bootstrap-admin` with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` when provisioning a real initial administrator. The bootstrap command is idempotent and the first login requires a password change. Provide bootstrap values only for that command. The demo seed is development/test-only and is intended for a dedicated synthetic database.

## Verification

Start a separate disposable PostgreSQL container for integration and browser tests.

```text
docker run --detach --name cfs-lms-test --publish 127.0.0.1:55433:5432 --env POSTGRES_USER=lms --env POSTGRES_PASSWORD=local-test-db-only --env POSTGRES_DB=lms_test postgres:18-alpine
docker exec cfs-lms-test pg_isready -U lms -d lms_test
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npx playwright install chromium
npm run test:e2e
docker rm -f -v cfs-lms-test
```

Wait for `pg_isready` to report that PostgreSQL is accepting connections. Set `TEST_DATABASE_URL` to use a different dedicated database with an `_test` suffix. Integration checks create and drop their own isolated PostgreSQL schema. Browser checks seed fixtures into the supplied database, so use disposable data. The browser runner serves the compiled application on port 3004 by default. Set `E2E_PORT` to override it.

## Docker delivery

On pull requests and pushes, [GitHub Actions](https://github.com/jxng2021-oss/cfs_app/actions) runs lint, type checking, dependency audit, unit tests, PostgreSQL integration tests and a Chromium journey. It builds a Linux/amd64 image, tests migrations, admin bootstrap, startup, SPA assets, sign-in and shutdown inside the container, then uploads the tested image as a downloadable artifact. A separate publish job loads that same artifact and pushes it to GitHub Container Registry on `main` and version tags such as `v0.1.0`. Each publish includes a `sha-<commit>` tag plus the branch or version tag.

```text
docker pull ghcr.io/jxng2021-oss/cfs_app:main
docker build --platform linux/amd64 -t cfs-mini-lms:dev .
bash scripts/smoke-image.sh cfs-mini-lms:dev
```

Private packages require a GHCR login with package read access. Release operators should deploy a specific commit tag or digest. Run migrations once as a release step with `node dist/api/cli.js migrate` before replacing instances. Use `/health` for the ALB liveness check and `/health/ready` to check the database. Use HTTPS and an exact `APP_ORIGIN` for deployment. Enable `TRUST_PROXY=true` only when the app is reachable through the trusted proxy hop. An optional `SECRET_ID` loads the supported database, session pepper and bootstrap configuration from AWS Secrets Manager via the instance role. The storage interface supports private local and S3 objects. The material upload, attachment and download workflows are tracked in the implementation status.

AWS resource provisioning and rollout are manual. This repository builds and publishes the application container. Keep passwords, session keys, infrastructure credentials, actual student data and the private design documents out of Git and image build contexts.
