import { Hono } from 'hono';
import { adminGuard } from '../middleware/adminGuard';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import type { Attendance, User } from '../types';
import { stringifyAuditJson } from '../utils/audit';
import { getPublicConfig } from '../utils/config';
import { getRequiredHolidayData } from '../utils/holidays';
import { hashPassword } from '../utils/password';
import { buildMonthlySummaryFromRecords } from '../utils/summary';
import { monthStart, nextMonthStart } from '../utils/time';
import {
  displayNameValue,
  boundedInteger,
  defaultWorkTypeValue,
  nullableBoundedInteger,
  optionalString,
  passwordValue,
  positiveIdValue,
  readJsonObject,
  RequestValidationError,
  transportModeValue,
  tripTypeValue,
  usernameValue,
  yearMonthValues,
  nullableTime,
} from '../utils/validation';

const admin = new Hono<AuthEnv>();
type ManagedUser = Omit<User, 'auth_version'>;

admin.use('*', authMiddleware);
admin.use('*', adminGuard);

admin.get('/users', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT id, username, display_name, is_admin, created_at,
            default_one_way_fare, default_trip_type,
            default_transport_mode, default_transport_origin, default_transport_destination,
            default_clock_in, default_clock_out, default_break_minutes, default_work_type
     FROM users ORDER BY display_name COLLATE NOCASE, id`,
  ).all<ManagedUser>();
  return c.json({ users: result.results });
});

admin.post('/users', async (c) => {
  const actor = c.get('user');
  const body = await readJsonObject(c.req.raw);
  const username = usernameValue(body.username);
  const displayName = body.display_name === undefined
    ? username
    : displayNameValue(body.display_name);
  const password = passwordValue(body.password);
  const isAdmin = adminFlagValue(body.is_admin, 0);
  const defaultFare = nullableBoundedInteger(
    body.default_one_way_fare,
    '默认片道交通费',
    0,
    100_000,
  ) ?? null;
  const defaultTripType = tripTypeValue(body.default_trip_type, 'round_trip');
  const defaultTransportMode = transportModeValue(body.default_transport_mode, 'rail');
  const defaultTransportOrigin = optionalString(body.default_transport_origin, '出发地', 120) ?? '';
  const defaultTransportDestination = optionalString(body.default_transport_destination, '到达地', 120) ?? '';
  const defaultClockIn = nullableTime(body.default_clock_in, '默认出勤时间') ?? null;
  const defaultClockOut = nullableTime(body.default_clock_out, '默认退勤时间') ?? null;
  const defaultBreakMinutes = boundedInteger(
    body.default_break_minutes,
    '默认休息分钟',
    0,
    480,
    getPublicConfig(c.env).default_break_minutes,
  );
  const defaultWorkType = defaultWorkTypeValue(body.default_work_type, 'office');
  const passwordHash = await hashPassword(password);

  let user: ManagedUser | undefined;
  try {
    const insert = c.env.DB.prepare(
      `INSERT INTO users (
         username, password_hash, display_name, is_admin,
         default_one_way_fare, default_trip_type,
         default_transport_mode, default_transport_origin, default_transport_destination,
         default_clock_in, default_clock_out, default_break_minutes, default_work_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id, username, display_name, is_admin, created_at,
                 default_one_way_fare, default_trip_type,
                 default_transport_mode, default_transport_origin, default_transport_destination,
                 default_clock_in, default_clock_out, default_break_minutes, default_work_type`,
    ).bind(
      username,
      passwordHash,
      displayName,
      isAdmin,
      defaultFare,
      defaultTripType,
      defaultTransportMode,
      defaultTransportOrigin,
      defaultTransportDestination,
      defaultClockIn,
      defaultClockOut,
      defaultBreakMinutes,
      defaultWorkType,
    );
    const audit = c.env.DB.prepare(
      `INSERT INTO audit_logs (
         actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
       )
       SELECT ?, id, 'user_create', 'user', CAST(id AS TEXT), NULL, ?
       FROM users
       WHERE username = ?`,
    ).bind(
      actor.id,
      stringifyAuditJson({
        username,
        display_name: displayName,
        is_admin: isAdmin,
        default_one_way_fare: defaultFare,
        default_trip_type: defaultTripType,
        default_transport_mode: defaultTransportMode,
        default_transport_origin: defaultTransportOrigin,
        default_transport_destination: defaultTransportDestination,
        default_clock_in: defaultClockIn,
        default_clock_out: defaultClockOut,
        default_break_minutes: defaultBreakMinutes,
        default_work_type: defaultWorkType,
      }),
      username,
    );
    const results = await c.env.DB.batch([insert, audit]);
    user = results[0]?.results?.[0] as ManagedUser | undefined;
  } catch (error) {
    if (String(error).includes('UNIQUE')) {
      return c.json({ error: '该登录名已被使用' }, 409);
    }
    throw error;
  }

  if (!user) throw new Error('User insert returned no row');
  return c.json({ success: true, user }, 201);
});

admin.patch('/users/:id', async (c) => {
  const actor = c.get('user');
  const targetId = positiveIdValue(c.req.param('id'));
  const body = await readJsonObject(c.req.raw);
  const existing = await getUser(c.env, targetId);
  if (!existing) return c.json({ error: '用户不存在' }, 404);

  const displayName = body.display_name === undefined
    ? existing.display_name
    : displayNameValue(body.display_name);
  const isAdmin = adminFlagValue(body.is_admin, existing.is_admin);
  const defaultFare = body.default_one_way_fare === undefined
    ? existing.default_one_way_fare
    : nullableBoundedInteger(body.default_one_way_fare, '默认片道交通费', 0, 100_000) ?? null;
  const defaultTripType = tripTypeValue(body.default_trip_type, existing.default_trip_type);
  const defaultTransportMode = transportModeValue(
    body.default_transport_mode,
    existing.default_transport_mode,
  );
  const defaultTransportOrigin = body.default_transport_origin === undefined
    ? existing.default_transport_origin
    : optionalString(body.default_transport_origin, '出发地', 120) ?? '';
  const defaultTransportDestination = body.default_transport_destination === undefined
    ? existing.default_transport_destination
    : optionalString(body.default_transport_destination, '到达地', 120) ?? '';
  const defaultClockIn = body.default_clock_in === undefined
    ? existing.default_clock_in
    : nullableTime(body.default_clock_in, '默认出勤时间') ?? null;
  const defaultClockOut = body.default_clock_out === undefined
    ? existing.default_clock_out
    : nullableTime(body.default_clock_out, '默认退勤时间') ?? null;
  const defaultBreakMinutes = body.default_break_minutes === undefined
    ? existing.default_break_minutes
    : boundedInteger(body.default_break_minutes, '默认休息分钟', 0, 480);
  const defaultWorkType = body.default_work_type === undefined
    ? existing.default_work_type
    : defaultWorkTypeValue(body.default_work_type);

  if (existing.is_admin === 1 && isAdmin === 0) {
    const otherAdmin = await c.env.DB.prepare(
      'SELECT id FROM users WHERE is_admin = 1 AND id != ? LIMIT 1',
    ).bind(targetId).first();
    if (!otherAdmin) return c.json({ error: '不能取消最后一名管理员的权限' }, 409);
  }

  const update = c.env.DB.prepare(
    `UPDATE users
     SET display_name = ?,
         is_admin = ?,
         default_one_way_fare = ?,
         default_trip_type = ?,
         default_transport_mode = ?,
         default_transport_origin = ?,
         default_transport_destination = ?,
         default_clock_in = ?,
         default_clock_out = ?,
         default_break_minutes = ?,
         default_work_type = ?,
         auth_version = CASE WHEN is_admin <> ? THEN auth_version + 1 ELSE auth_version END
     WHERE id = ?
     RETURNING id, username, display_name, is_admin, created_at,
               default_one_way_fare, default_trip_type,
               default_transport_mode, default_transport_origin, default_transport_destination,
               default_clock_in, default_clock_out, default_break_minutes, default_work_type`,
  ).bind(
    displayName,
    isAdmin,
    defaultFare,
    defaultTripType,
    defaultTransportMode,
    defaultTransportOrigin,
    defaultTransportDestination,
    defaultClockIn,
    defaultClockOut,
    defaultBreakMinutes,
    defaultWorkType,
    isAdmin,
    targetId,
  );
  const after = {
    ...existing,
    display_name: displayName,
    is_admin: isAdmin,
    default_one_way_fare: defaultFare,
    default_trip_type: defaultTripType,
    default_transport_mode: defaultTransportMode,
    default_transport_origin: defaultTransportOrigin,
    default_transport_destination: defaultTransportDestination,
    default_clock_in: defaultClockIn,
    default_clock_out: defaultClockOut,
    default_break_minutes: defaultBreakMinutes,
    default_work_type: defaultWorkType,
  };
  let results: D1Result<unknown>[];
  try {
    results = await c.env.DB.batch([
      update,
      adminAuditStatement(c.env, actor.id, targetId, 'user_update', targetId, existing, after),
      ...(existing.is_admin !== isAdmin
        ? [c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId)]
        : []),
    ]);
  } catch (error) {
    if (String(error).includes('cannot remove last administrator')) {
      return c.json({ error: '不能取消最后一名管理员的权限' }, 409);
    }
    throw error;
  }
  const user = results[0]?.results?.[0] as ManagedUser | undefined;
  return c.json({ success: true, user });
});

admin.post('/users/:id/password', async (c) => {
  const actor = c.get('user');
  const targetId = positiveIdValue(c.req.param('id'));
  const body = await readJsonObject(c.req.raw);
  const newPassword = passwordValue(body.new_password, '新密码');
  const target = await getUser(c.env, targetId);
  if (!target) return c.json({ error: '用户不存在' }, 404);
  const passwordHash = await hashPassword(newPassword);

  await c.env.DB.batch([
    c.env.DB.prepare(
      'UPDATE users SET password_hash = ?, auth_version = auth_version + 1 WHERE id = ?',
    ).bind(passwordHash, targetId),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId),
    adminAuditStatement(c.env, actor.id, targetId, 'password_reset', targetId, null, null),
  ]);
  return c.json({ success: true });
});

admin.delete('/users/:id', async (c) => {
  const actor = c.get('user');
  const targetId = positiveIdValue(c.req.param('id'));
  if (targetId === actor.id) return c.json({ error: '不能删除自己' }, 400);
  const target = await getUser(c.env, targetId);
  if (!target) return c.json({ error: '用户不存在' }, 404);

  try {
    await c.env.DB.batch([
      adminAuditStatement(c.env, actor.id, targetId, 'user_delete', targetId, target, null),
      c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId),
    ]);
  } catch (error) {
    if (String(error).includes('cannot delete last administrator')) {
      return c.json({ error: '不能删除最后一名管理员' }, 409);
    }
    throw error;
  }
  return c.json({ success: true });
});

admin.get('/overview/:year/:month', async (c) => {
  const { year, month } = yearMonthValues(c.req.param('year'), c.req.param('month'));
  const start = monthStart(year, month);
  const end = nextMonthStart(year, month);
  const [usersResult, recordsResult, holidayData] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, username, display_name, is_admin, created_at,
              default_one_way_fare, default_trip_type,
              default_transport_mode, default_transport_origin, default_transport_destination,
              default_clock_in, default_clock_out, default_break_minutes, default_work_type
       FROM users ORDER BY display_name COLLATE NOCASE, id`,
    ).all<ManagedUser>(),
    c.env.DB.prepare(
      `SELECT * FROM attendance
       WHERE work_date >= ? AND work_date < ?
       ORDER BY user_id, work_date`,
    ).bind(start, end).all<Attendance>(),
    getRequiredHolidayData(c.env, year),
  ]);

  const recordsByUser = new Map<number, Attendance[]>();
  for (const record of recordsResult.results) {
    const records = recordsByUser.get(record.user_id) ?? [];
    records.push(record);
    recordsByUser.set(record.user_id, records);
  }

  const users = usersResult.results.map((user) => ({
    user_id: user.id,
    username: user.username,
    display_name: user.display_name,
    summary: buildMonthlySummaryFromRecords(
      c.env,
      user,
      year,
      month,
      recordsByUser.get(user.id) ?? [],
      holidayData,
    ),
  }));

  return c.json({ year, month, users });
});

function adminFlagValue(value: unknown, fallback: number): 0 | 1 {
  if (value === undefined) return fallback === 1 ? 1 : 0;
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new RequestValidationError('管理员权限值不正确');
}

async function getUser(env: CloudflareBindings, id: number): Promise<ManagedUser | null> {
  return env.DB.prepare(
    `SELECT id, username, display_name, is_admin, created_at,
            default_one_way_fare, default_trip_type,
            default_transport_mode, default_transport_origin, default_transport_destination,
            default_clock_in, default_clock_out, default_break_minutes, default_work_type
     FROM users WHERE id = ?`,
  ).bind(id).first<ManagedUser>();
}

function adminAuditStatement(
  env: CloudflareBindings,
  actorId: number,
  targetId: number,
  action: string,
  entityKey: number,
  before: unknown,
  after: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     ) VALUES (?, ?, ?, 'user', ?, ?, ?)`,
  ).bind(
    actorId,
    targetId,
    action,
    String(entityKey),
    before === null ? null : stringifyAuditJson(before),
    after === null ? null : stringifyAuditJson(after),
  );
}

export default admin;
