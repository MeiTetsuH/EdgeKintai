import { applyD1Migrations, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { D1Migration } from '@cloudflare/vitest-plugin';
import {
  BASELINE_NAME,
  ensureBaseline,
  SCHEMA_QUERY,
  type MigrationAdapter,
  type SchemaRow,
} from '../scripts/migration-plan.mjs';
import legacyMigrationSource from './fixtures/legacy-migrations.json?raw';

const legacyMigrations: D1Migration[] = JSON.parse(legacyMigrationSource);

function databaseAdapter(db: D1Database): MigrationAdapter {
  return { query: async (sql) => (await db.prepare(sql).all<Record<string, unknown>>()).results };
}

function snapshotAdapter(
  schema: SchemaRow[],
  names: string[],
  violations: Record<string, unknown>[] = [],
) {
  const writes: string[] = [];
  const adapter: MigrationAdapter = {
    async query(sql) {
      if (sql === SCHEMA_QUERY) return schema;
      if (sql.startsWith('SELECT name FROM sqlite_schema')) return [{ name: 'd1_migrations' }];
      if (sql === 'SELECT name FROM d1_migrations ORDER BY id') return names.map((name) => ({ name }));
      if (sql === 'PRAGMA foreign_key_check') return violations;
      writes.push(sql);
      return [];
    },
  };
  return { adapter, writes };
}

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
  it('applies the single baseline and creates the complete schema', async () => {
    expect(env.TEST_MIGRATIONS.map((migration) => migration.name)).toEqual([
      BASELINE_NAME,
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
    const expected = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    expect(await ensureBaseline(databaseAdapter(env.DB), expected)).toBe('current');
  });

  it('adopts a real legacy database without changing any data or deletion audit behavior', async () => {
    // This binding is separate from DB, which setup.ts already fully migrates.
    const db = env.UPGRADE_DB;
    const adapter = databaseAdapter(db);
    const expected = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    expect(await ensureBaseline(adapter, expected)).toBe('fresh');
    await applyD1Migrations(db, legacyMigrations.slice(0, 2));
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
      db.prepare(`INSERT INTO holidays_cache (year, date_str, name_ja, source)
        VALUES (2026, '2026-01-01', '元日', 'legacy-test')`),
      db.prepare(`INSERT INTO holiday_sync_state (year, source, item_count, source_modified)
        VALUES (2026, 'legacy-test', 1, '2026-10-01')`),
      db.prepare(`INSERT INTO holiday_sync_failures (year, retry_after)
        VALUES (2027, '2026-11-01 00:00:00')`),
    ]);
    const readData = async () => {
      const results = await db.batch<Record<string, unknown>>([
        db.prepare('SELECT * FROM users ORDER BY id'),
        db.prepare('SELECT * FROM attendance ORDER BY id'),
        db.prepare('SELECT * FROM sessions ORDER BY token_id'),
        db.prepare('SELECT * FROM audit_logs ORDER BY id'),
        db.prepare('SELECT * FROM holidays_cache ORDER BY id'),
        db.prepare('SELECT * FROM holiday_sync_state ORDER BY year'),
        db.prepare('SELECT * FROM holiday_sync_failures ORDER BY year'),
      ]);
      return results.map((result) => result.results);
    };
    const partialData = await readData();
    await expect(ensureBaseline(adapter, expected)).rejects.toThrow('Unsupported migration history');
    expect(await readData()).toEqual(partialData);
    await applyD1Migrations(db, legacyMigrations);
    const existingData = await readData();
    expect(existingData).toEqual(partialData);
    const oldHistory = await db.prepare('SELECT * FROM d1_migrations ORDER BY id').all();

    expect(await ensureBaseline(adapter, expected, { checkOnly: true })).toBe('adoptable');
    expect((await db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results)
      .toEqual(oldHistory.results);
    expect(await readData()).toEqual(existingData);

    // Adoption records the new name, so the strict CREATE statements are skipped.
    expect(await ensureBaseline(adapter, expected)).toBe('adopted');
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect(await readData()).toEqual(existingData);
    const applied = await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<NameRow>();
    expect(applied.results.map((row) => row.name)).toEqual(
      [...legacyMigrations.map((migration) => migration.name), BASELINE_NAME],
    );
    expect((await db.prepare('SELECT * FROM d1_migrations ORDER BY id').all()).results.slice(0, 3))
      .toEqual(oldHistory.results);
    expect(await ensureBaseline(adapter, expected)).toBe('current');
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

  it('accepts equivalent ALTER-added column ordering and SQL formatting', async () => {
    const expected = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    const schema = expected.map((row) => ({ ...row }));
    const users = schema.find((row) => row.name === 'users')!;
    const definitions = [
      /default_break_minutes\s+INTEGER\s+NOT NULL\s+DEFAULT 60\s+CHECK \(default_break_minutes BETWEEN 0 AND 480\),/,
      /default_work_type\s+TEXT\s+NOT NULL\s+DEFAULT 'office'\s+CHECK \(default_work_type IN \('office', 'remote'\)\),/,
    ];
    const moved = definitions.map((pattern) => {
      const match = users.sql.match(pattern);
      expect(match).not.toBeNull();
      users.sql = users.sql.replace(pattern, '');
      return match![0];
    });
    users.sql = users.sql.replace('CHECK (length(username)', `${moved.join('\n')}\nCHECK (length(username)`);
    users.sql = users.sql.replace('CREATE TABLE', 'create\n/* equivalent formatting */ table');
    const { adapter, writes } = snapshotAdapter(schema, legacyMigrations.map((migration) => migration.name));
    expect(await ensureBaseline(adapter, expected, { checkOnly: true })).toBe('adoptable');
    expect(writes).toEqual([]);
  });

  it.each([
    ['incomplete history', ['0001_schema.sql', '0002_attendance_revision.sql']],
    ['unknown history', ['0001_schema.sql', '0002_attendance_revision.sql', '0003_other.sql']],
    ['unexpected extra history', [...legacyMigrations.map((migration) => migration.name), '999_unknown.sql']],
    ['baseline with incomplete legacy history', [BASELINE_NAME, '0001_schema.sql']],
    ['untracked existing database', []],
  ])('rejects %s without writing a baseline marker', async (_description, names) => {
    const schema = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    const { adapter, writes } = snapshotAdapter(schema, names);
    await expect(ensureBaseline(adapter, schema)).rejects.toThrow('Unsupported migration history');
    expect(writes).toEqual([]);
  });

  it.each([
    ['missing revision', 'attendance', (sql: string) => sql.replace(/,\s*revision\s+INTEGER\s+NOT NULL\s+DEFAULT 1\s+CHECK \(revision >= 1\)/, '')],
    ['changed default', 'users', (sql: string) => sql.replace('DEFAULT 60', 'DEFAULT 30')],
    ['changed quoted literal', 'users', (sql: string) => sql.replace("'office', 'remote'", "'office ', 'remote'")],
    ['changed compound key ordering', 'attendance', (sql: string) => sql.replace('UNIQUE (user_id, work_date)', 'UNIQUE (work_date, user_id)')],
    ['missing cascade audit guard', 'attendance_audit_delete', (sql: string) => sql.replace('WHEN EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)', '')],
  ])('rejects schema drift: %s', async (_description, name, transform) => {
    const expected = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    const schema = expected.map((row) => ({ ...row, sql: row.name === name ? transform(row.sql) : row.sql }));
    expect(schema).not.toEqual(expected);
    const { adapter, writes } = snapshotAdapter(schema, legacyMigrations.map((migration) => migration.name));
    await expect(ensureBaseline(adapter, expected)).rejects.toThrow('Database schema does not match');
    expect(writes).toEqual([]);
  });

  it('rejects foreign key violations without writing a baseline marker', async () => {
    const schema = (await env.DB.prepare(SCHEMA_QUERY).all<SchemaRow>()).results;
    const { adapter, writes } = snapshotAdapter(
      schema,
      legacyMigrations.map((migration) => migration.name),
      [{ table: 'attendance', rowid: 12, parent: 'users', fkid: 0 }],
    );
    await expect(ensureBaseline(adapter, schema)).rejects.toThrow('foreign key violations');
    expect(writes).toEqual([]);
  });
});
