-- EdgeKintai final schema. The pre-release demo database is intentionally not
-- upgrade-compatible; deploy this schema to a new `edge-kintai-db` database.

CREATE TABLE users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  is_admin             INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  default_one_way_fare INTEGER CHECK (
    default_one_way_fare IS NULL
    OR default_one_way_fare BETWEEN 0 AND 100000
  ),
  default_trip_type    TEXT NOT NULL DEFAULT 'round_trip'
    CHECK (default_trip_type IN ('one_way', 'round_trip')),
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (length(username) BETWEEN 3 AND 64),
  CHECK (username NOT GLOB '*[^A-Za-z0-9._-]*'),
  CHECK (length(display_name) BETWEEN 1 AND 80)
);

CREATE TABLE audit_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id  INTEGER,
  target_user_id INTEGER,
  action         TEXT NOT NULL,
  entity_type    TEXT NOT NULL,
  entity_key     TEXT NOT NULL,
  before_json    TEXT,
  after_json     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE attendance (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id                   INTEGER NOT NULL,
  work_date                 TEXT NOT NULL,
  work_type                 TEXT NOT NULL DEFAULT 'office'
    CHECK (work_type IN ('office', 'remote', 'paid_leave', 'holiday', 'absent')),
  clock_in                  TEXT,
  clock_out                 TEXT,
  break_minutes             INTEGER NOT NULL DEFAULT 60
    CHECK (break_minutes BETWEEN 0 AND 480),
  transport_fee             INTEGER NOT NULL DEFAULT 0
    CHECK (transport_fee BETWEEN 0 AND 200000),
  transport_one_way_fee     INTEGER NOT NULL DEFAULT 0
    CHECK (transport_one_way_fee BETWEEN 0 AND 100000),
  transport_trip_type       TEXT NOT NULL DEFAULT 'round_trip'
    CHECK (transport_trip_type IN ('one_way', 'round_trip')),
  memo                      TEXT NOT NULL DEFAULT '' CHECK (length(memo) <= 500),
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (user_id, work_date),
  CHECK (work_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  CHECK (
    clock_in IS NULL OR (
      clock_in GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(clock_in, 1, 2) AS INTEGER) <= 23
    )
  ),
  CHECK (
    clock_out IS NULL OR (
      clock_out GLOB '[0-2][0-9]:[0-5][0-9]'
      AND CAST(substr(clock_out, 1, 2) AS INTEGER) <= 23
    )
  ),
  CHECK (clock_out IS NULL OR clock_in IS NOT NULL),
  CHECK (
    transport_fee = transport_one_way_fee
      * CASE WHEN transport_trip_type = 'round_trip' THEN 2 ELSE 1 END
  ),
  CHECK (
    work_type = 'office'
    OR (transport_fee = 0 AND transport_one_way_fee = 0)
  ),
  CHECK (
    work_type IN ('office', 'remote')
    OR (clock_in IS NULL AND clock_out IS NULL AND break_minutes = 0)
  )
);

CREATE TABLE holidays_cache (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  year       INTEGER NOT NULL CHECK (year BETWEEN 1955 AND 2100),
  date_str   TEXT NOT NULL,
  name_ja    TEXT NOT NULL CHECK (length(name_ja) BETWEEN 1 AND 100),
  source     TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (year, date_str),
  CHECK (date_str GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);

CREATE TABLE holiday_sync_state (
  year            INTEGER PRIMARY KEY CHECK (year BETWEEN 1955 AND 2100),
  source          TEXT NOT NULL,
  item_count      INTEGER NOT NULL CHECK (item_count >= 0),
  source_modified TEXT,
  synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE holiday_sync_failures (
  year        INTEGER PRIMARY KEY CHECK (year BETWEEN 1955 AND 2100),
  retry_after TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token_id          TEXT PRIMARY KEY,
  user_id           INTEGER NOT NULL,
  expires_at        TEXT NOT NULL,
  reauthenticated_at TEXT,
  reauth_token_hash  TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_attendance_user_date ON attendance(user_id, work_date);
CREATE INDEX idx_attendance_date_user ON attendance(work_date, user_id);
CREATE INDEX idx_holidays_year ON holidays_cache(year);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_audit_target_created ON audit_logs(target_user_id, created_at);
CREATE INDEX idx_audit_actor_created ON audit_logs(actor_user_id, created_at);

CREATE TRIGGER users_preserve_last_admin_update
BEFORE UPDATE OF is_admin ON users
WHEN OLD.is_admin = 1 AND NEW.is_admin = 0
  AND (SELECT count(*) FROM users WHERE is_admin = 1) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot remove last administrator');
END;

CREATE TRIGGER users_preserve_last_admin_delete
BEFORE DELETE ON users
WHEN OLD.is_admin = 1
  AND (SELECT count(*) FROM users WHERE is_admin = 1) <= 1
BEGIN
  SELECT RAISE(ABORT, 'cannot delete last administrator');
END;

-- Attendance audit rows are written by SQLite triggers, making every business
-- mutation and its audit record one atomic D1 transaction.
CREATE TRIGGER attendance_audit_insert
AFTER INSERT ON attendance
BEGIN
  INSERT INTO audit_logs (
    actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
  ) VALUES (
    NEW.user_id,
    NEW.user_id,
    'attendance_create',
    'attendance',
    NEW.work_date,
    NULL,
    json_object(
      'work_type', NEW.work_type,
      'clock_in', NEW.clock_in,
      'clock_out', NEW.clock_out,
      'break_minutes', NEW.break_minutes,
      'transport_fee', NEW.transport_fee,
      'transport_one_way_fee', NEW.transport_one_way_fee,
      'transport_trip_type', NEW.transport_trip_type,
      'memo', NEW.memo
    )
  );
END;

CREATE TRIGGER attendance_audit_update
AFTER UPDATE ON attendance
BEGIN
  INSERT INTO audit_logs (
    actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
  ) VALUES (
    NEW.user_id,
    NEW.user_id,
    'attendance_update',
    'attendance',
    NEW.work_date,
    json_object(
      'work_type', OLD.work_type,
      'clock_in', OLD.clock_in,
      'clock_out', OLD.clock_out,
      'break_minutes', OLD.break_minutes,
      'transport_fee', OLD.transport_fee,
      'transport_one_way_fee', OLD.transport_one_way_fee,
      'transport_trip_type', OLD.transport_trip_type,
      'memo', OLD.memo
    ),
    json_object(
      'work_type', NEW.work_type,
      'clock_in', NEW.clock_in,
      'clock_out', NEW.clock_out,
      'break_minutes', NEW.break_minutes,
      'transport_fee', NEW.transport_fee,
      'transport_one_way_fee', NEW.transport_one_way_fee,
      'transport_trip_type', NEW.transport_trip_type,
      'memo', NEW.memo
    )
  );
END;

CREATE TRIGGER attendance_audit_delete
AFTER DELETE ON attendance
BEGIN
  INSERT INTO audit_logs (
    actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
  ) VALUES (
    OLD.user_id,
    OLD.user_id,
    'attendance_delete',
    'attendance',
    OLD.work_date,
    json_object(
      'work_type', OLD.work_type,
      'clock_in', OLD.clock_in,
      'clock_out', OLD.clock_out,
      'break_minutes', OLD.break_minutes,
      'transport_fee', OLD.transport_fee,
      'transport_one_way_fee', OLD.transport_one_way_fee,
      'transport_trip_type', OLD.transport_trip_type,
      'memo', OLD.memo
    ),
    NULL
  );
END;
