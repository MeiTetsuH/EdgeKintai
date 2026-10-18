import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

interface NameRow {
  name: string;
}

async function schemaNames(type: 'table' | 'index' | 'trigger'): Promise<string[]> {
  const result = await env.DB.prepare(
    `SELECT name FROM sqlite_schema
     WHERE type = ? AND name NOT LIKE 'sqlite_%'
     ORDER BY name`,
  ).bind(type).all<NameRow>();
  return result.results
    .map((row) => row.name)
    .filter((name) => name !== 'd1_migrations' && !name.startsWith('_'));
}

async function columnNames(table: 'users' | 'attendance' | 'sessions'): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<NameRow>();
  return result.results.map((row) => row.name);
}

async function indexColumns(index: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA index_info(${index})`).all<NameRow>();
  return result.results.map((row) => row.name);
}

describe('D1 final schema', () => {
  it('applies additive migrations and creates the complete schema', async () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      '0001_schema.sql',
      '0002_attendance_revision.sql',
      '0003_attendance_delete_audit.sql',
    ]);
    expect(env.TEST_MIGRATIONS[0]?.queries.join('\n')).toContain(
      'CREATE TRIGGER users_preserve_last_admin_delete',
    );

    expect(await schemaNames('table')).toEqual([
      'attendance',
      'audit_logs',
      'holiday_sync_failures',
      'holiday_sync_state',
      'holidays_cache',
      'sessions',
      'users',
    ]);

    expect(await schemaNames('index')).toEqual([
      'idx_attendance_date_user',
      'idx_audit_actor_created',
      'idx_audit_target_created',
      'idx_sessions_expires',
      'idx_sessions_user',
    ]);

    expect(await schemaNames('trigger')).toEqual([
      'attendance_audit_delete',
      'attendance_audit_insert',
      'attendance_audit_update',
      'users_preserve_last_admin_delete',
      'users_preserve_last_admin_update',
      'users_username_immutable',
    ]);

    expect(await columnNames('users')).toEqual([
      'id',
      'username',
      'password_hash',
      'display_name',
      'is_admin',
      'default_one_way_fare',
      'default_trip_type',
      'default_transport_mode',
      'default_transport_origin',
      'default_transport_destination',
      'default_clock_in',
      'default_clock_out',
      'default_break_minutes',
      'default_work_type',
      'auth_version',
      'created_at',
    ]);

    expect(await columnNames('attendance')).toEqual([
      'id',
      'user_id',
      'work_date',
      'work_type',
      'clock_in',
      'clock_out',
      'break_minutes',
      'transport_fee',
      'transport_one_way_fee',
      'transport_trip_type',
      'transport_mode',
      'transport_origin',
      'transport_destination',
      'memo',
      'created_at',
      'updated_at',
      'revision',
    ]);
    expect(await columnNames('sessions')).toEqual([
      'token_id',
      'user_id',
      'expires_at',
      'reauthenticated_at',
      'reauth_token_hash',
      'auth_version',
      'created_at',
    ]);

    expect(await indexColumns('idx_attendance_date_user')).toEqual([
      'work_date',
      'user_id',
    ]);
    expect(await indexColumns('sqlite_autoindex_attendance_1')).toEqual([
      'user_id',
      'work_date',
    ]);

    const foreignKeyCheck = await env.DB.prepare('PRAGMA foreign_key_check').all();
    expect(foreignKeyCheck.results).toEqual([]);
  });

  it('upgrades an existing database without losing data or normal deletion audits', async () => {
    // This binding is separate from DB, which setup.ts already fully migrates.
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, 2));
    const oldTrigger = await db.prepare(
      "SELECT sql FROM sqlite_schema WHERE type = 'trigger' AND name = 'attendance_audit_delete'",
    ).first<{ sql: string }>();
    expect(oldTrigger?.sql).toContain('CREATE TRIGGER attendance_audit_delete');
    expect(oldTrigger?.sql).not.toContain('WHEN EXISTS');

    await db.batch([
      db.prepare(`INSERT INTO users (id, username, password_hash, display_name) VALUES
        (1, 'upgrade_worker', 'test-hash', 'Existing worker'),
        (2, 'upgrade_peer', 'test-hash', 'Other worker')`),
      db.prepare(`INSERT INTO attendance (id, user_id, work_date, memo, revision) VALUES
        (11, 1, '2026-10-01', 'Normal deletion', 4),
        (12, 1, '2026-10-02', 'Cascaded deletion', 7),
        (13, 2, '2026-10-01', 'Preserved record', 2)`),
      db.prepare(`INSERT INTO sessions (token_id, user_id, expires_at)
        VALUES ('upgrade-session', 1, '2026-11-01 00:00:00')`),
    ]);
    const readData = async () => {
      const results = await db.batch<Record<string, unknown>>([
        db.prepare('SELECT * FROM users ORDER BY id'),
        db.prepare('SELECT * FROM attendance ORDER BY id'),
        db.prepare('SELECT * FROM sessions ORDER BY token_id'),
        db.prepare('SELECT * FROM audit_logs ORDER BY id'),
      ]);
      return results.map((result) => result.results);
    };
    const existingData = await readData();

    // Applying the full list must skip the already-recorded migrations.
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await readData()).toEqual(existingData);
    const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<NameRow>();
    expect(applied.results.map((row) => row.name)).toEqual(
      env.TEST_MIGRATIONS.map((migration) => migration.name),
    );
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await readData()).toEqual(existingData);

    await db.prepare('DELETE FROM attendance WHERE id = 11').run();
    const normalDelete = await db.prepare(
      "SELECT actor_user_id, target_user_id, entity_key, before_json FROM audit_logs WHERE action = 'attendance_delete'",
    ).all<{ actor_user_id: number; target_user_id: number; entity_key: string; before_json: string }>();
    expect(normalDelete.results).toHaveLength(1);
    expect(normalDelete.results[0]).toMatchObject({
      actor_user_id: 1,
      target_user_id: 1,
      entity_key: '2026-10-01',
    });
    expect(JSON.parse(normalDelete.results[0].before_json)).toMatchObject({ memo: 'Normal deletion' });

    await db.prepare('DELETE FROM users WHERE id = 1').run();
    const deletionLogs = await db.prepare(
      "SELECT entity_key FROM audit_logs WHERE action = 'attendance_delete'",
    ).all<{ entity_key: string }>();
    expect(deletionLogs.results).toEqual([{ entity_key: '2026-10-01' }]);
    const remainingRecords = await db.prepare('SELECT * FROM attendance ORDER BY id').all();
    expect(remainingRecords.results).toEqual(existingData[1].filter((row) => row.id === 13));
    expect((await db.prepare('SELECT id FROM users ORDER BY id').all()).results).toEqual([{ id: 2 }]);
    expect((await db.prepare('SELECT * FROM sessions').all()).results).toEqual([]);
    expect((await db.prepare('SELECT id FROM audit_logs ORDER BY id').all()).results).toHaveLength(4);
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});
