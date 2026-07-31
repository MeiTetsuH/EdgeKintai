import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeEach } from 'vitest';

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  await env.DB.prepare('DROP TRIGGER IF EXISTS users_preserve_last_admin_delete').run();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions'),
    env.DB.prepare('DELETE FROM attendance'),
    env.DB.prepare('DELETE FROM users'),
    env.DB.prepare('DELETE FROM audit_logs'),
    env.DB.prepare('DELETE FROM holidays_cache'),
    env.DB.prepare('DELETE FROM holiday_sync_state'),
    env.DB.prepare('DELETE FROM holiday_sync_failures'),
    env.DB.prepare("DELETE FROM sqlite_sequence WHERE name IN ('users', 'attendance', 'holidays_cache', 'audit_logs')"),
  ]);
  await env.DB.prepare(
    `CREATE TRIGGER users_preserve_last_admin_delete
     BEFORE DELETE ON users
     WHEN OLD.is_admin = 1
       AND (SELECT count(*) FROM users WHERE is_admin = 1) <= 1
     BEGIN
       SELECT RAISE(ABORT, 'cannot delete last administrator');
     END`,
  ).run();
});
