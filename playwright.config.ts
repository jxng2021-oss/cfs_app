import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT ?? '3004');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Use a valid E2E_PORT');
const origin = 'http://localhost:' + port;
const database = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://admissions:local-test-db-only@localhost:55433/admissions_test');
if (!/^\/[a-z0-9_]+_test$/i.test(database.pathname)) throw new Error('Use a dedicated database ending in _test for browser tests');
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: origin, actionTimeout: 15_000, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run migrate && npm run seed && npm start',
    url: origin + '/health/ready',
    timeout: 90_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test', PORT: String(port), APP_ORIGIN: origin, DATABASE_URL: database.href,
      SESSION_PEPPER: 'synthetic-browser-test-session-pepper-32-characters', DEMO_PASSWORD: 'synthetic browser fixture',
      TRUST_PROXY: 'false', COOKIE_SECURE: 'false', SECRET_ID: '', STUDENT_ADMIN_NUMBER: 'E2E-0001',
    },
  },
});
