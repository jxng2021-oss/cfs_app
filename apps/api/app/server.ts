import { createApp } from './app.js';
import { loadEnvironment, parseConfig } from './config.js';
import { createPool, databaseClock } from './db.js';
import { resolveIdentity } from './infrastructure.js';

try {
  const config = parseConfig(await loadEnvironment());
  const pool = createPool(config.DATABASE_URL);
  const identity = await resolveIdentity();
  const server = createApp({ config, pool, clock: databaseClock }).listen(config.PORT, '0.0.0.0', () => {
    console.info(JSON.stringify({ event: 'server_listening', port: config.PORT, instanceId: identity.instanceId, availabilityZone: identity.availabilityZone }));
  });
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = 120_000;
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      server.closeAllConnections();
      process.exit(1);
    }, 25_000);
    deadline.unref();
    server.close(async () => {
      await pool.end();
      clearTimeout(deadline);
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
} catch (error) {
  console.error(JSON.stringify({ event: 'startup_failed', message: error instanceof Error && /^(Invalid configuration fields|COOKIE_SECURE|Idle timeout)/.test(error.message) ? error.message : 'Verify the application configuration and secret access.' }));
  process.exitCode = 1;
}
