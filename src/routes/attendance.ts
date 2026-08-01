import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import type { Attendance, TransportMode, TransportTripType, WorkType } from '../types';
import { getPublicConfig, getUserCommuteDefaults } from '../utils/config';
import { buildHolidayMap, getHolidayData } from '../utils/holidays';
import { buildMonthlySummary } from '../utils/summary';
import { nowTimeJST, previousDate, timeToMinutes, todayJST } from '../utils/time';
import {
  boundedInteger,
  dateValue,
  nullableBoundedInteger,
  nullableTime,
  optionalString,
  readJsonObject,
  RequestValidationError,
  transportModeValue,
  tripTypeValue,
  workTypeValue,
  yearMonthValues,
} from '../utils/validation';

const attendance = new Hono<AuthEnv>();
attendance.use('*', authMiddleware);

function fareTotal(oneWayFare: number, tripType: TransportTripType): number {
  return oneWayFare * (tripType === 'round_trip' ? 2 : 1);
}

function isClockable(workType: WorkType): workType is 'office' | 'remote' {
  return workType === 'office' || workType === 'remote';
}

attendance.get('/today', async (c) => {
  const user = c.get('user');
  const date = todayJST();
  const [record, holidayData] = await Promise.all([
    c.env.DB.prepare('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?')
      .bind(user.id, date)
      .first<Attendance>(),
    getHolidayData(c.env, Number(date.slice(0, 4))),
  ]);
  const holidayName = buildHolidayMap(holidayData.holidays).get(date) ?? null;
  const defaults = getUserCommuteDefaults(c.env, user);
  const publicConfig = getPublicConfig(c.env);
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay();

  return c.json({
    date,
    day_of_week: dayOfWeek,
    is_holiday: holidayName !== null,
    holiday_name: holidayName,
    is_weekend: dayOfWeek === 0 || dayOfWeek === 6,
    record: record ?? null,
    defaults: {
      break_minutes: publicConfig.default_break_minutes,
      one_way_fare: defaults.one_way_fare,
      trip_type: defaults.trip_type,
      transport_mode: defaults.transport_mode,
      transport_origin: defaults.transport_origin,
      transport_destination: defaults.transport_destination,
      transport_fee: fareTotal(defaults.one_way_fare, defaults.trip_type),
    },
    holiday_data: {
      source: holidayData.source,
      complete: holidayData.complete,
      synced_at: holidayData.synced_at,
    },
  });
});

attendance.post('/clock-in', async (c) => {
  const user = c.get('user');
  const body = await readJsonObject(c.req.raw);
  const workType = workTypeValue(body.work_type, 'office');
  if (!isClockable(workType)) {
    throw new RequestValidationError('打刻只能选择出社或在宅勤務');
  }

  const date = todayJST();
  const clockIn = nullableTime(body.clock_in, '出勤时刻') ?? nowTimeJST();
  if (!clockIn) throw new RequestValidationError('出勤时刻不能为空');

  const config = getPublicConfig(c.env);
  const defaults = getUserCommuteDefaults(c.env, user);
  const breakMinutes = boundedInteger(
    body.break_minutes,
    '休息分钟',
    0,
    480,
    config.default_break_minutes,
  );
  const requestedTripType = body.transport_trip_type === undefined
    ? undefined
    : tripTypeValue(body.transport_trip_type);
  const requestedTransportMode = body.transport_mode === undefined
    ? undefined
    : transportModeValue(body.transport_mode);
  const requestedOrigin = optionalString(body.transport_origin, '出发地', 120);
  const requestedDestination = optionalString(body.transport_destination, '到达地', 120);
  const requestedFare = nullableBoundedInteger(
    body.transport_one_way_fee,
    '片道交通费',
    0,
    100_000,
  );
  const tripType: TransportTripType = workType === 'office'
    ? (requestedTripType ?? defaults.trip_type)
    : 'one_way';
  const transportMode: TransportMode = workType === 'office'
    ? (requestedTransportMode ?? defaults.transport_mode)
    : 'rail';
  const transportOrigin = workType === 'office'
    ? (requestedOrigin ?? defaults.transport_origin)
    : '';
  const transportDestination = workType === 'office'
    ? (requestedDestination ?? defaults.transport_destination)
    : '';
  const oneWayFare = workType === 'office' ? (requestedFare ?? defaults.one_way_fare) : 0;
  const totalFare = workType === 'office' ? fareTotal(oneWayFare, tripType) : 0;

  const upsert = c.env.DB.prepare(
    `INSERT INTO attendance (
       user_id, work_date, work_type, clock_in, clock_out, break_minutes,
       transport_fee, transport_one_way_fee, transport_trip_type,
       transport_mode, transport_origin, transport_destination, memo
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, '')
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       work_type = excluded.work_type,
       clock_in = excluded.clock_in,
       clock_out = NULL,
       break_minutes = excluded.break_minutes,
       transport_fee = excluded.transport_fee,
       transport_one_way_fee = excluded.transport_one_way_fee,
       transport_trip_type = excluded.transport_trip_type,
       transport_mode = excluded.transport_mode,
       transport_origin = excluded.transport_origin,
       transport_destination = excluded.transport_destination,
       updated_at = datetime('now')
     WHERE attendance.clock_in IS NULL AND attendance.clock_out IS NULL
     RETURNING *`,
  ).bind(
    user.id,
    date,
    workType,
    clockIn,
    breakMinutes,
    totalFare,
    oneWayFare,
    tripType,
    transportMode,
    transportOrigin,
    transportDestination,
  );
  const record = await upsert.first<Attendance>();

  if (!record) return c.json({ error: '今天已经打过出勤卡' }, 409);
  return c.json({ success: true, record });
});

attendance.post('/clock-out', async (c) => {
  const user = c.get('user');
  const body: Record<string, unknown> = c.req.raw.body === null
    ? {}
    : await readJsonObject(c.req.raw);
  const clockOut = nullableTime(body.clock_out, '退勤时刻') ?? nowTimeJST();
  if (!clockOut) throw new RequestValidationError('退勤时刻不能为空');
  const date = todayJST();
  const todayRecord = await c.env.DB.prepare(
    'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?',
  )
    .bind(user.id, date)
    .first<Attendance>();
  if (todayRecord?.clock_out) return c.json({ error: '今天已经打过退勤卡' }, 409);

  let openRecord = todayRecord?.clock_in && !todayRecord.clock_out
    && isClockable(todayRecord.work_type)
    ? todayRecord
    : null;
  if (!openRecord) {
    openRecord = await c.env.DB.prepare(
      `SELECT * FROM attendance
       WHERE user_id = ? AND work_date = ?
         AND clock_in IS NOT NULL AND clock_out IS NULL
         AND work_type IN ('office', 'remote')
       LIMIT 1`,
    )
      .bind(user.id, previousDate(date))
      .first<Attendance>();
  }

  if (!openRecord) return c.json({ error: '请先打出勤卡' }, 400);
  if (
    openRecord.work_date !== date
    && openRecord.clock_in
    && timeToMinutes(clockOut) >= timeToMinutes(openRecord.clock_in)
  ) {
    return c.json({ error: '前一天的出勤已超过 24 小时，请在补录画面中修正' }, 409);
  }

  const record = await c.env.DB.prepare(
    `UPDATE attendance
     SET clock_out = ?, updated_at = datetime('now')
     WHERE user_id = ? AND work_date = ?
       AND clock_in IS NOT NULL AND clock_out IS NULL
       AND work_type IN ('office', 'remote')
     RETURNING *`,
  )
    .bind(clockOut, user.id, openRecord.work_date)
    .first<Attendance>();

  if (!record) return c.json({ error: '退勤记录已被更新，请重新载入' }, 409);
  return c.json({ success: true, record });
});

attendance.get('/:year/:month', async (c) => {
  const { year, month } = yearMonthValues(c.req.param('year'), c.req.param('month'));
  return c.json(await buildMonthlySummary(c.env, c.get('user'), year, month));
});

attendance.put('/:date', async (c) => {
  const user = c.get('user');
  const date = dateValue(c.req.param('date'));
  const body = await readJsonObject(c.req.raw);
  const existing = await c.env.DB.prepare(
    'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?',
  )
    .bind(user.id, date)
    .first<Attendance>();

  const config = getPublicConfig(c.env);
  const defaults = getUserCommuteDefaults(c.env, user);
  const workType = workTypeValue(body.work_type, existing?.work_type ?? 'office');
  let clockIn = nullableTime(body.clock_in, '出勤时刻');
  let clockOut = nullableTime(body.clock_out, '退勤时刻');
  let breakMinutes = boundedInteger(
    body.break_minutes,
    '休息分钟',
    0,
    480,
    existing?.break_minutes ?? config.default_break_minutes,
  );
  const memo = optionalString(body.memo, '备注', 500) ?? existing?.memo ?? '';
  const preserveExistingCommute = existing?.work_type === 'office';
  let tripType = tripTypeValue(
    body.transport_trip_type,
    preserveExistingCommute ? existing.transport_trip_type : defaults.trip_type,
  );
  let transportMode = transportModeValue(
    body.transport_mode,
    preserveExistingCommute ? existing.transport_mode : defaults.transport_mode,
  );
  const requestedOrigin = optionalString(body.transport_origin, '出发地', 120);
  const requestedDestination = optionalString(body.transport_destination, '到达地', 120);
  let transportOrigin = requestedOrigin
    ?? (preserveExistingCommute ? existing.transport_origin : defaults.transport_origin);
  let transportDestination = requestedDestination
    ?? (preserveExistingCommute ? existing.transport_destination : defaults.transport_destination);
  const requestedFare = nullableBoundedInteger(
    body.transport_one_way_fee,
    '片道交通费',
    0,
    100_000,
  );
  let oneWayFare = requestedFare
    ?? (preserveExistingCommute
      ? existing.transport_one_way_fee ?? defaults.one_way_fare
      : defaults.one_way_fare);

  if (isClockable(workType)) {
    if (clockIn === undefined) clockIn = existing?.clock_in ?? null;
    if (clockOut === undefined) clockOut = existing?.clock_out ?? null;
    if (!clockIn && clockOut) throw new RequestValidationError('填写退勤时刻前必须先填写出勤时刻');
  } else {
    clockIn = null;
    clockOut = null;
    breakMinutes = 0;
    oneWayFare = 0;
    tripType = 'one_way';
    transportMode = 'rail';
    transportOrigin = '';
    transportDestination = '';
  }

  if (workType !== 'office') {
    oneWayFare = 0;
    tripType = 'one_way';
    transportMode = 'rail';
    transportOrigin = '';
    transportDestination = '';
  }
  const totalFare = workType === 'office' ? fareTotal(oneWayFare, tripType) : 0;

  const upsert = c.env.DB.prepare(
    `INSERT INTO attendance (
       user_id, work_date, work_type, clock_in, clock_out, break_minutes,
       transport_fee, transport_one_way_fee, transport_trip_type,
       transport_mode, transport_origin, transport_destination, memo
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, work_date) DO UPDATE SET
       work_type = excluded.work_type,
       clock_in = excluded.clock_in,
       clock_out = excluded.clock_out,
       break_minutes = excluded.break_minutes,
       transport_fee = excluded.transport_fee,
       transport_one_way_fee = excluded.transport_one_way_fee,
       transport_trip_type = excluded.transport_trip_type,
       transport_mode = excluded.transport_mode,
       transport_origin = excluded.transport_origin,
       transport_destination = excluded.transport_destination,
       memo = excluded.memo,
       updated_at = datetime('now')
     RETURNING *`,
  ).bind(
    user.id,
    date,
    workType,
    clockIn,
    clockOut,
    breakMinutes,
    totalFare,
    oneWayFare,
    tripType,
    transportMode,
    transportOrigin,
    transportDestination,
    memo,
  );
  const record = await upsert.first<Attendance>();
  return c.json({ success: true, record });
});

attendance.delete('/:date', async (c) => {
  const user = c.get('user');
  const date = dateValue(c.req.param('date'));
  const existing = await c.env.DB.prepare(
    'DELETE FROM attendance WHERE user_id = ? AND work_date = ? RETURNING *',
  )
    .bind(user.id, date)
    .first<Attendance>();
  if (!existing) return c.json({ error: '该日期没有可删除的记录' }, 404);
  return c.json({ success: true });
});

export default attendance;
