import type { PublicAppConfig, TransportTripType, User } from '../types';

function integerSetting(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function tripTypeSetting(value: string | undefined): TransportTripType {
  return value === 'one_way' ? 'one_way' : 'round_trip';
}

export function getPublicConfig(env: CloudflareBindings): PublicAppConfig {
  return {
    timezone: 'Asia/Tokyo',
    default_break_minutes: integerSetting(env.DEFAULT_BREAK_MINUTES, 60, 0, 480),
    default_one_way_fare: integerSetting(env.DEFAULT_ONE_WAY_FARE, 210, 0, 100_000),
    default_trip_type: tripTypeSetting(env.DEFAULT_TRIP_TYPE),
    overtime_threshold_hours: integerSetting(env.OVERTIME_THRESHOLD_HOURS, 180, 0, 744),
  };
}

export function getSessionTtlSeconds(env: CloudflareBindings): number {
  return integerSetting(env.SESSION_TTL_SECONDS, 604_800, 300, 2_592_000);
}

export function getUserFareDefaults(
  env: CloudflareBindings,
  user: Pick<User, 'default_one_way_fare' | 'default_trip_type'>,
): { one_way_fare: number; trip_type: TransportTripType } {
  const config = getPublicConfig(env);
  return {
    one_way_fare: user.default_one_way_fare ?? config.default_one_way_fare,
    trip_type: user.default_trip_type || config.default_trip_type,
  };
}
