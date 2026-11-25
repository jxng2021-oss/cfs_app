import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';

export type Db = pg.Pool | pg.PoolClient;
export type Clock = (db: Db) => Promise<Date>;

export const databaseClock: Clock = async db => {
  const result = await db.query<{ time: Date }>('SELECT clock_timestamp() AS time');
  return result.rows[0].time;
};

export function createPool(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000 });
  pool.on('error', () => console.error(JSON.stringify({ event: 'idle_database_connection_error' })));
  return pool;
}

export async function transaction<T>(pool: pg.Pool, run: (db: pg.PoolClient) => Promise<T>) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const value = await run(db);
    await db.query('COMMIT');
    return value;
  } catch (error) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

export async function migrate(pool: pg.Pool, path = resolve('migrations')) {
  await transaction(pool, async db => {
    await db.query('SELECT pg_advisory_xact_lock(81290101)');
    await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())');
    const applied = new Map((await db.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(row => [row.name, row.checksum]));
    const files = (await readdir(path)).filter(name => /^\d+-.*\.sql$/.test(name)).sort();
    for (const name of files) {
      const sql = (await readFile(join(path, name), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = createHash('sha256').update(sql).digest('hex');
      if (applied.get(name) === checksum) continue;
      if (applied.has(name)) throw new Error('Previously applied migration changed: ' + name);
      await db.query(sql);
      await db.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
  });
}

export async function audit(db: Db, actorId: string | null, event: string, entity: string, entityId: string, moduleId: string | null = null, metadata: Record<string, string> = {}) {
  await db.query(
    'INSERT INTO audit_events (actor_id, event_type, entity_type, entity_id, module_id, metadata) VALUES ($1, $2, $3, $4, $5, $6)',
    [actorId, event, entity, entityId, moduleId, metadata],
  );
}
