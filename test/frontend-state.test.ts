// @ts-expect-error Vitest raw import
import appSource from '../public/app.js?raw';
import { describe, expect, it } from 'vitest';

interface TestHooks {
  attendanceState: (
    record: { persisted?: boolean; work_type?: string; clock_in?: string | null; clock_out?: string | null; day_of_week?: number; is_holiday?: boolean },
    date: string,
    today: string,
  ) => 'missing' | 'incomplete' | 'undecided' | 'active' | 'normal';
  previousDate: (value: string) => string;
  calculateWorkMinutes: (clockIn: string, clockOut: string, breakMinutes: number) => number;
  boundedInteger: (value: unknown, fallback: number, min: number, max: number) => number;
  handlePotentialDateRollover: () => Promise<void>;
  getLastObservedDate: () => string;
  setLastObservedDate: (val: string) => void;
  setUser: (user: unknown) => void;
  setLoadTodayMock: (fn: () => Promise<void>) => void;
}

function loadFrontendHooks(customLoadToday?: () => Promise<void>): TestHooks {
  const instrumented = appSource.replace(
    'void initialize();',
    `
    if (customLoadToday) {
      loadToday = customLoadToday;
    }
    return {
      attendanceState,
      previousDate,
      calculateWorkMinutes,
      boundedInteger,
      handlePotentialDateRollover,
      getLastObservedDate: () => lastObservedDate,
      setLastObservedDate: (val) => { lastObservedDate = val; },
      setUser: (u) => { state.user = u; },
      setLoadTodayMock: (fn) => { loadToday = fn; },
    };
    `,
  );

  const mockWindow = { matchMedia: () => ({ matches: false }) };
  const mockDoc = {
    documentElement: { dataset: {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    querySelector: () => null,
    getElementById: () => ({ value: '', append: () => {}, appendChild: () => {}, remove: () => {} }),
  };

  const fn = new Function('window', 'document', 'navigator', 'location', 'customLoadToday', `return ${instrumented}`);
  const hooks = fn(mockWindow, mockDoc, { clipboard: {} }, { pathname: '/' }, customLoadToday) as TestHooks;
  if (!hooks) throw new Error('Failed to load frontend hooks from public/app.js');
  return hooks;
}

describe('Frontend Pure State Logic', () => {
  it('correctly calculates attendanceState across all date and punch conditions', () => {
    const { attendanceState } = loadFrontendHooks();
    const today = '2026-08-15';
    const pastWeekday = '2026-08-14';
    const pastWeekend = '2026-08-09';
    const futureDate = '2026-08-20';

    // 1. Past unpersisted weekday -> missing (未刻)
    expect(attendanceState({ day_of_week: 5, is_holiday: false }, pastWeekday, today)).toBe('missing');

    // 2. Past unpersisted weekend -> normal (休日)
    expect(attendanceState({ day_of_week: 0, is_holiday: false }, pastWeekend, today)).toBe('normal');

    // 3. Past unpersisted holiday -> normal (祝日)
    expect(attendanceState({ day_of_week: 2, is_holiday: true }, '2026-08-11', today)).toBe('normal');

    // 4. Past persisted office with clock_in=null -> missing (未刻)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('missing');

    // 5. Past persisted office ON WEEKEND with clock_in=null -> missing (未刻)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 0,
      is_holiday: false,
    }, pastWeekend, today)).toBe('missing');

    // 6. Past open shift (clock_in exists, clock_out is null) -> incomplete (未退)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '10:00',
      clock_out: null,
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('incomplete');

    // 7. Past closed shift -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '10:00',
      clock_out: '19:00',
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('normal');

    // 8. Past paid_leave -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'paid_leave',
      day_of_week: 5,
      is_holiday: false,
    }, pastWeekday, today)).toBe('normal');

    // 9. Today unpersisted weekday -> undecided (未定)
    expect(attendanceState({ day_of_week: 3, is_holiday: false }, today, today)).toBe('undecided');

    // 10. Today unpersisted weekend -> normal
    expect(attendanceState({ day_of_week: 6, is_holiday: false }, today, today)).toBe('normal');

    // 11. Today persisted office with clock_in=null -> undecided (未定)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: null,
      clock_out: null,
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('undecided');

    // 12. Today open shift (currently working) -> active (勤務中)
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '09:30',
      clock_out: null,
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('active');

    // 13. Today completed shift -> normal
    expect(attendanceState({
      persisted: true,
      work_type: 'office',
      clock_in: '09:30',
      clock_out: '18:30',
      day_of_week: 3,
      is_holiday: false,
    }, today, today)).toBe('normal');

    // 14. Future date -> normal
    expect(attendanceState({ day_of_week: 4, is_holiday: false }, futureDate, today)).toBe('normal');
  });

  it('calculates previousDate accurately across month and year boundaries', () => {
    const { previousDate } = loadFrontendHooks();
    expect(previousDate('2026-08-15')).toBe('2026-08-14');
    expect(previousDate('2026-08-01')).toBe('2026-07-31');
    expect(previousDate('2026-03-01')).toBe('2026-02-28');
    expect(previousDate('2024-03-01')).toBe('2024-02-29'); // Leap year
    expect(previousDate('2026-01-01')).toBe('2025-12-31');
    expect(previousDate('invalid')).toBe('');
  });

  it('calculates calculateWorkMinutes with overnight support', () => {
    const { calculateWorkMinutes } = loadFrontendHooks();
    expect(calculateWorkMinutes('10:00', '19:00', 60)).toBe(480);
    expect(calculateWorkMinutes('23:00', '07:00', 60)).toBe(420);
    expect(calculateWorkMinutes('10:00', '11:00', 60)).toBe(0);
  });

  it('bounds integers accurately without silent NaN corruption', () => {
    const { boundedInteger } = loadFrontendHooks();
    expect(boundedInteger('50', 0, 0, 100)).toBe(50);
    expect(boundedInteger('-5', 0, 0, 100)).toBe(0);
    expect(boundedInteger('150', 0, 0, 100)).toBe(100);
    expect(boundedInteger('abc', 42, 0, 100)).toBe(42);
  });

  it('rolls back lastObservedDate when handlePotentialDateRollover fails so next event can retry', async () => {
    let callCount = 0;
    const hooks = loadFrontendHooks(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Network timeout');
      }
    });

    hooks.setUser({ id: 1, name: 'Tester' });
    hooks.setLastObservedDate('2026-08-14');

    // First attempt fails -> throws error and rolls back lastObservedDate to 2026-08-14
    await expect(hooks.handlePotentialDateRollover()).rejects.toThrow('Network timeout');
    expect(hooks.getLastObservedDate()).toBe('2026-08-14');

    // Next attempt succeeds -> lastObservedDate successfully transitions to current date
    await expect(hooks.handlePotentialDateRollover()).resolves.toBeUndefined();
    expect(hooks.getLastObservedDate()).not.toBe('2026-08-14');
  });
});
