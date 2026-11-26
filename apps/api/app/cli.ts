import { record } from './activity.js';
import { chosenPassword, hashPassword } from './auth.js';
import { loadEnvironment, parseConfig } from './config.js';
import { createPool, databaseClock, migrate, transaction } from './db.js';
import { seedAdmissionsDemo } from './demo-data.js';
import { email } from './http.js';

const command = process.argv[2];
try {
  const env = await loadEnvironment();
  const config = parseConfig(env);
  const pool = createPool(config.DATABASE_URL);
  try {
    if (command === 'migrate') {
      await migrate(pool);
      console.info('Migrations applied.');
    } else if (command === 'bootstrap-admin') {
      const parsedEmail = email.safeParse(env.BOOTSTRAP_ADMIN_EMAIL);
      const password = chosenPassword.safeParse(env.BOOTSTRAP_ADMIN_PASSWORD);
      if (!parsedEmail.success || !password.success) throw new Error('Provide a valid bootstrap email and a 12–128 character password.');
      const hash = await hashPassword(password.data);
      const created = await transaction(pool, async db => {
        await db.query('SELECT pg_advisory_xact_lock(81290102)');
        if ((await db.query("SELECT 1 FROM users WHERE role = 'ADMIN' LIMIT 1")).rowCount) return false;
        const result = await db.query<{ id: string }>(
          "INSERT INTO users (email_normalized, display_name, role, password_hash) VALUES ($1, 'Administrator', 'ADMIN', $2) RETURNING id",
          [parsedEmail.data, hash],
        );
        await record(db, null, 'ADMIN_BOOTSTRAPPED', 'USER', result.rows[0].id, 'Created the initial administrator account');
        return true;
      });
      console.info(created ? 'Administrator created. Change the initial password at first login.' : 'An administrator already exists.');
    } else if (command === 'seed') {
      if (config.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production.');
      const password = chosenPassword.safeParse(env.DEMO_PASSWORD);
      if (!password.success) throw new Error('Provide DEMO_PASSWORD with 12–128 characters.');
      const hash = await hashPassword(password.data);
      const seeded = await transaction(pool, async db => {
        await db.query('SELECT pg_advisory_xact_lock(81290102)');
        const now = env.DEMO_CLOCK_ISO ? new Date(env.DEMO_CLOCK_ISO) : await databaseClock(db);
        if (Number.isNaN(now.getTime())) throw new Error('Provide a valid ISO timestamp for DEMO_CLOCK_ISO.');
        const since = new Date(now.getTime() - 500 * 86_400_000);
        const accounts = [
          ['admin', 'Demo Administrator', 'ADMIN'], ['officer-a', 'Casey Tan', 'OFFICER'],
          ['officer-b', 'Maya Chen', 'OFFICER'], ['viewer', 'Jordan Lim', 'VIEWER'],
        ] as const;
        const ids = new Map<string, string>();
        for (const [key, name, role] of accounts) {
          if (role === 'ADMIN' && (await db.query("SELECT 1 FROM users WHERE role = 'ADMIN' AND email_normalized <> 'admin@example.test'")).rowCount) {
            throw new Error('Use a separate demo database: this one already has a real administrator.');
          }
          const address = key + '@example.test';
          await db.query('INSERT INTO users (email_normalized, display_name, role, password_hash, must_change_password, created_at, updated_at) VALUES ($1, $2, $3, $4, false, $5, $5) ON CONFLICT DO NOTHING',
            [address, name, role, hash, since]);
          const existing = (await db.query<{ id: string; role: string }>('SELECT id, role FROM users WHERE email_normalized = $1', [address])).rows[0];
          if (existing.role !== role) throw new Error('A demo account conflicts with an existing account.');
          ids.set(key, existing.id);
        }
        return seedAdmissionsDemo(db, { admin: ids.get('admin')!, officers: [ids.get('officer-a')!, ids.get('officer-b')!] }, now);
      });
      console.info(seeded ? 'Demo accounts, programmes, intakes, applicants and applications seeded.' : 'Demo accounts ensured; admissions data already exists.');
    } else {
      throw new Error('Choose migrate, bootstrap-admin or seed.');
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  const message = error instanceof Error && /^(Provide |Demo |Choose |Use a separate |A demo account |Invalid configuration fields|COOKIE_SECURE|Idle timeout|Previously applied)/.test(error.message)
    ? error.message : 'Command failed. Verify the database, migrations and configuration.';
  console.error(message);
  process.exitCode = 1;
}
