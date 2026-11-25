import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chosenPassword, hashPassword, temporaryPassword } from '../../apps/api/app/auth.js';
import { parseConfig } from '../../apps/api/app/config.js';
import { matchVersion } from '../../apps/api/app/modules.js';
import { createStorage } from '../../apps/api/app/storage.js';

const valid = { DATABASE_URL: 'postgres://lms:local@localhost/lms_test', APP_ORIGIN: 'http://localhost:3000', SESSION_PEPPER: 'synthetic-session-test-key-32-characters' };

test('configuration validates exact origins, secure cookies, timeouts and S3 settings', () => {
  assert.equal(parseConfig(valid).COOKIE_SECURE, false);
  assert.equal(parseConfig({ ...valid, APP_ORIGIN: 'https://example.test' }).COOKIE_SECURE, true);
  assert.throws(() => parseConfig({ ...valid, APP_ORIGIN: 'https://example.test/app' }), /APP_ORIGIN/);
  assert.throws(() => parseConfig({ ...valid, APP_ORIGIN: 'https://example.test', COOKIE_SECURE: 'false' }), /COOKIE_SECURE/);
  assert.throws(() => parseConfig({ ...valid, SESSION_IDLE_MINUTES: '721' }), /Idle timeout/);
  assert.throws(() => parseConfig({ ...valid, STORAGE_DRIVER: 's3' }), /S3_BUCKET/);
});

test('password policy accepts spaces and Unicode without truncation', async () => {
  assert.equal(chosenPassword.parse(' 😀 learning together  '), ' 😀 learning together  ');
  assert.equal(chosenPassword.safeParse('😀'.repeat(128)).success, true);
  assert.equal(chosenPassword.safeParse('😀'.repeat(129)).success, false);
  assert.equal(chosenPassword.safeParse('short').success, false);
  const temporary = temporaryPassword();
  assert.ok(temporary.length >= 16);
  assert.notEqual(temporary, temporaryPassword());
  assert.match(await hashPassword(temporary), /^\$argon2id\$/);
});

test('local storage separates files from their original names and rejects traversal', async () => {
  const path = await mkdtemp(join(tmpdir(), 'lms-storage-'));
  try {
    const store = createStorage(parseConfig({ ...valid, UPLOAD_DIR: path }));
    const key = await store.put(Buffer.from('private learning content'), 'text/plain');
    const stream = await store.open(key);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    assert.equal(Buffer.concat(chunks).toString(), 'private learning content');
    await assert.rejects(store.remove('../outside'), /Invalid storage key/);
    await store.remove(key);
    await store.remove(key);
  } finally {
    await rm(path, { force: true, recursive: true });
  }
});

test('stale edit versions return conflicts with the current version', () => {
  assert.doesNotThrow(() => matchVersion(3, 3));
  assert.throws(() => matchVersion(2, 3), { code: 'VERSION_CONFLICT', fields: { currentVersion: '3' } });
});
