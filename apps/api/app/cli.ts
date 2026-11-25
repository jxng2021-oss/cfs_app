import { audit, createPool, databaseClock, migrate, transaction } from './db.js';
import { loadEnvironment, parseConfig } from './config.js';
import { chosenPassword, hashPassword } from './auth.js';
import { email } from './http.js';
import { cleanupUploads } from './files.js';
import { createStorage } from './storage.js';
import { seedAcademicDemo } from './demo-data.js';

const command = process.argv[2];
try {
  const env = await loadEnvironment();
  const config = parseConfig(env);
  const pool = createPool(config.DATABASE_URL);
  try {
    if (command === 'migrate') {
      await migrate(pool);
      console.info('Migrations applied.');
    } else if (command === 'cleanup-uploads') {
      const result = await cleanupUploads({pool,config,clock:databaseClock},createStorage(config));
      console.info(JSON.stringify(result));
      if(result.pending) process.exitCode=1;
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
        await audit(db, null, 'ADMIN_BOOTSTRAPPED', 'USER', result.rows[0].id);
        return true;
      });
      console.info(created ? 'Administrator created. Change the initial password at first login.' : 'An administrator already exists.');
    } else if (command === 'seed') {
      if (config.NODE_ENV === 'production') throw new Error('Demo seed is disabled in production.');
      const password = chosenPassword.safeParse(env.DEMO_PASSWORD);
      if (!password.success) throw new Error('Provide DEMO_PASSWORD with 12–128 characters.');
      const hash = await hashPassword(password.data);
      const storage=createStorage(config);
      const keys:string[]=[];
      try {
        await transaction(pool, async db => {
        await db.query('SELECT pg_advisory_xact_lock(81290102)');
        const now=env.DEMO_CLOCK_ISO?new Date(env.DEMO_CLOCK_ISO):await databaseClock(db);
        if(Number.isNaN(now.getTime()))throw new Error('Provide a valid ISO timestamp for DEMO_CLOCK_ISO.');
        const firstPublished=new Date(now.getTime()-6*86_400_000);
        const users = [
          ['admin', 'Demo Administrator', 'ADMIN'], ['lecturer-a', 'Casey Tan', 'LECTURER'],
          ['lecturer-b', 'Maya Chen', 'LECTURER'], ['student-a', 'Avery Lee', 'STUDENT'],
          ['student-b', 'Jordan Lim', 'STUDENT'], ['student-c', 'Morgan Rao', 'STUDENT'],
          ['student-d', 'Quinn Teo', 'STUDENT'], ['student-e', 'Riley Gupta', 'STUDENT'],
        ];
        const ids = new Map<string, string>();
        for (const [key, name, role] of users) {
          if (role === 'ADMIN' && (await db.query("SELECT 1 FROM users WHERE role = 'ADMIN' AND email_normalized <> 'admin@example.test'")).rowCount) {
            throw new Error('Use a separate empty demo database.');
          }
          const address = key + '@example.test';
          await db.query('INSERT INTO users (email_normalized,display_name,role,password_hash,must_change_password,created_at,updated_at) VALUES ($1,$2,$3,$4,false,$5,$5) ON CONFLICT DO NOTHING', [address,name,role,hash,firstPublished]);
          const existing = (await db.query<{ id: string; role: string }>('SELECT id, role FROM users WHERE email_normalized = $1', [address])).rows[0];
          if (existing.role !== role) throw new Error('A demo account conflicts with an existing account.');
          ids.set(key, existing.id);
        }
        const term = 'Demo term';
        const modules = [
          ['SE101', 'Software Engineering Fundamentals', 'Practise the fundamentals of building reliable software.', 'lecturer-a', 'ACTIVE'],
          ['UX102', 'Design Foundations', 'Explore accessible interfaces and clear information design.', 'lecturer-b', 'ACTIVE'],
          ['CS103', 'Data Fundamentals', 'A draft offering for next term.', 'lecturer-a', 'DRAFT'],
        ];
        for (const [code, name, description, lecturer, status] of modules) {
          await db.query(
            "INSERT INTO modules (code,name,description,term,lecturer_id,status,activated_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,CASE WHEN $6='ACTIVE' THEN $7::timestamptz END,$7,$7) ON CONFLICT DO NOTHING",
            [code,name,description,term,ids.get(lecturer),status,firstPublished],
          );
        }
        const demoModule = (await db.query<{ id: string }>(
          "SELECT id FROM modules WHERE code = 'SE101' AND term = $1 AND lecturer_id = $2 AND status = 'ACTIVE' FOR UPDATE",
          [term, ids.get('lecturer-a')],
        )).rows[0];
        if (demoModule) {
          await db.query(
            'INSERT INTO enrolments (module_id,student_id,enrolled_at) SELECT $1,id,greatest(created_at,$3::timestamptz) FROM users WHERE id=ANY($2) AND is_active ON CONFLICT DO NOTHING',
            [demoModule.id,['student-a','student-b','student-c'].map(key=>ids.get(key)),firstPublished],
          );
        }
        if (demoModule && !(await db.query('SELECT 1 FROM topics WHERE module_id = $1 LIMIT 1', [demoModule.id])).rowCount) {
          const topic = (await db.query<{ id: string }>(
            "INSERT INTO topics (module_id,title,description,position,created_at,updated_at) VALUES ($1,'Week 1: Getting started','Explore the foundations of a maintainable software project.',1,$2,$2) RETURNING id",
            [demoModule.id,firstPublished],
          )).rows[0];
          const materials = [
            ['From requirements to tests', 'Turn an observable behavior into a test that will fail if that behavior changes.'],
            ['Working in small changes', 'Keep each change focused so another developer can review and verify it.'],
            ['Reading a delivery pipeline', 'Follow a change from version control through tests to a deployable build.'],
            ['Reflection', 'Write down one example of a requirement that could have two readings.'],
          ];
          for (const [position, [title, body]] of materials.entries()) {
            await db.query(
              "INSERT INTO materials (topic_id,title,type,position,is_required,status,text_body,published_at,created_at,updated_at) VALUES ($1,$2,'TEXT',$3,$4,'PUBLISHED',$5,$6,$6,$6)",
              [topic.id, title, position + 1, position < 3, body,firstPublished],
            );
          }
          await db.query("UPDATE topics SET status='PUBLISHED',published_at=$2 WHERE id=$1",[topic.id,firstPublished]);
          await db.query('UPDATE modules SET version = version + 1 WHERE id = $1', [demoModule.id]);
        }
        if(demoModule)await seedAcademicDemo(db,storage,keys,demoModule.id,ids,now);
        });
      } catch(error){
        await Promise.allSettled(keys.map(key=>storage.remove(key)));
        throw error;
      }
      console.info('Demo users, modules, learning content and assessments seeded.');
    } else {
      throw new Error('Choose migrate, bootstrap-admin, seed or cleanup-uploads.');
    }
  } finally {
    await pool.end();
  }
} catch (error) {
  const message = error instanceof Error && /^(Provide |Demo |Choose |Use a separate |A demo account |Invalid configuration fields|COOKIE_SECURE|Idle timeout|S3_BUCKET|Previously applied)/.test(error.message)
    ? error.message : 'Command failed. Verify the database, migrations and configuration.';
  console.error(message);
  process.exitCode = 1;
}
