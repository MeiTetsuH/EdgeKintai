export const BASELINE_NAME = '001_schema.sql';

export const SCHEMA_QUERY = `SELECT type, name, tbl_name, sql FROM sqlite_schema
WHERE name NOT GLOB 'sqlite_*'
  AND name NOT GLOB '_cf_*'
  AND name <> 'd1_migrations'
ORDER BY type, name`;

export interface SchemaRow extends Record<string, unknown> {
  type: string;
  name: string;
  tbl_name: string;
  sql: string;
}

export interface MigrationAdapter {
  query(sql: string): Promise<Record<string, unknown>[]>;
}

export type BaselineState = 'fresh' | 'current' | 'adoptable' | 'adopted';

const LEGACY_NAMES = [
  '0001_schema.sql',
  '0002_attendance_revision.sql',
  '0003_attendance_delete_audit.sql',
];

/** Keep quoted contents intact while ignoring formatting and SQL comments. */
function sqlTokens(sql: string): string[] {
  const tokens: string[] = [];
  let position = 0;
  while (position < sql.length) {
    const char = sql[position];
    if (/\s/.test(char)) {
      position += 1;
    } else if (sql.startsWith('--', position)) {
      const end = sql.indexOf('\n', position + 2);
      position = end === -1 ? sql.length : end + 1;
    } else if (sql.startsWith('/*', position)) {
      const end = sql.indexOf('*/', position + 2);
      if (end === -1) throw new Error('Unterminated schema SQL comment');
      position = end + 2;
    } else if (char === "'" || char === '"' || char === '`' || char === '[') {
      const start = position;
      const close = char === '[' ? ']' : char;
      position += 1;
      let closed = false;
      while (position < sql.length) {
        if (sql[position] === close) {
          position += 1;
          if (char !== '[' && sql[position] === close) {
            position += 1;
          } else {
            closed = true;
            break;
          }
        } else {
          position += 1;
        }
      }
      if (!closed) throw new Error('Unterminated quoted schema SQL value');
      tokens.push(sql.slice(start, position));
    } else if (/[A-Za-z0-9_$]/.test(char)) {
      const start = position;
      while (position < sql.length && /[A-Za-z0-9_$]/.test(sql[position])) position += 1;
      tokens.push(sql.slice(start, position).toLowerCase());
    } else {
      tokens.push(char);
      position += 1;
    }
  }
  while (tokens.at(-1) === ';') tokens.pop();
  return tokens;
}

function canonicalSql(row: SchemaRow): string {
  const tokens = sqlTokens(row.sql);
  if (row.type !== 'table') return JSON.stringify(tokens);

  // ALTER-added columns can occupy a different position in equivalent tables.
  // Sort only whole declarations, preserving column order inside keys/checks.
  const opening = tokens.indexOf('(');
  if (opening === -1) throw new Error(`Unsupported table schema: ${row.name}`);
  const declarations: string[] = [];
  let depth = 1;
  let start = opening + 1;
  for (let index = start; index < tokens.length; index += 1) {
    if (tokens[index] === '(') depth += 1;
    else if (tokens[index] === ')') depth -= 1;
    if (depth === 0 || (depth === 1 && tokens[index] === ',')) {
      declarations.push(JSON.stringify(tokens.slice(start, index)));
      start = index + 1;
    }
    if (depth === 0) {
      return JSON.stringify([
        tokens.slice(0, opening),
        declarations.sort(),
        tokens.slice(index + 1),
      ]);
    }
  }
  throw new Error(`Unbalanced table schema: ${row.name}`);
}

function schemaMap(rows: readonly Record<string, unknown>[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const row of rows) {
    if (
      typeof row.type !== 'string' || typeof row.name !== 'string'
      || typeof row.tbl_name !== 'string' || typeof row.sql !== 'string'
    ) throw new Error('Invalid database schema metadata');
    const schemaRow = row as SchemaRow;
    const key = `${schemaRow.type}:${schemaRow.name}`;
    if (result.has(key)) throw new Error(`Duplicate schema object: ${key}`);
    result.set(key, JSON.stringify([schemaRow.tbl_name, canonicalSql(schemaRow)]));
  }
  return result;
}

/** Adopt only a verified, fully upgraded legacy database; never rewrite its data. */
export async function ensureBaseline(
  adapter: MigrationAdapter,
  expectedSchema: readonly SchemaRow[],
  options: { checkOnly?: boolean } = {},
): Promise<BaselineState> {
  const expected = schemaMap(expectedSchema);
  if (expected.size === 0) throw new Error('The expected baseline schema is empty');

  const schema = await adapter.query(SCHEMA_QUERY);
  const migrationTable = await adapter.query(
    "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'",
  );
  const history = migrationTable.length === 0
    ? []
    : await adapter.query('SELECT name FROM d1_migrations ORDER BY id');
  const names = history.map((row) => row.name);

  if (schema.length === 0 && names.length === 0) return 'fresh';
  const legacy = LEGACY_NAMES.every((name) => names.includes(name));
  const baseline = names.includes(BASELINE_NAME);
  const allowedNames = baseline
    ? (legacy ? [...LEGACY_NAMES, BASELINE_NAME] : [BASELINE_NAME])
    : LEGACY_NAMES;
  if (
    (!legacy && !baseline)
    || names.length !== allowedNames.length
    || !allowedNames.every((name) => names.includes(name))
  ) throw new Error('Unsupported migration history; a complete known legacy schema is required');

  const actual = schemaMap(schema);
  if (actual.size !== expected.size) throw new Error('Database schema does not match the baseline');
  for (const [key, value] of expected) {
    if (actual.get(key) !== value) {
      throw new Error(`Database schema does not match the baseline: ${key}`);
    }
  }
  const violations = await adapter.query('PRAGMA foreign_key_check');
  if (violations.length !== 0) throw new Error('Database has foreign key violations; baseline adoption stopped');

  if (baseline) return 'current';
  if (options.checkOnly) return 'adoptable';
  await adapter.query(`INSERT OR IGNORE INTO d1_migrations (name) VALUES ('${BASELINE_NAME}')`);
  return 'adopted';
}
