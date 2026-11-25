import { defineConfig, devices } from '@playwright/test';

const origin = 'http://localhost:3001';
const database = new URL(process.env.TEST_DATABASE_URL ?? 'postgres://lms:local-test-db-only@localhost:55433/lms_test');
if (!/^\/[a-z0-9_]+_test$/i.test(database.pathname)) throw new Error('Use a dedicated database ending in _test for browser tests');
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: { baseURL: origin, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run migrate && npm run seed && npm start',
    url: origin + '/health/ready',
    timeout: 90_000,
    reuseExistingServer: false,
    env: {
      NODE_ENV: 'test', PORT: '3001', APP_ORIGIN: origin, DATABASE_URL: database.href,
      SESSION_PEPPER: 'synthetic-browser-test-session-pepper-32-characters', DEMO_PASSWORD: 'synthetic browser fixture',
      TRUST_PROXY: 'false', COOKIE_SECURE: 'false', STORAGE_DRIVER: 'local', SECRET_ID: '',
    },
  },
});
