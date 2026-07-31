import { describe, expect, it } from 'vitest';
import {
  calcWorkMinutes,
  dayOfWeek,
  isValidDate,
  isValidTime,
  todayJST,
} from '../src/utils/time';

describe('Japan time helpers', () => {
  it('uses the JST calendar around the UTC date boundary', () => {
    expect(todayJST(new Date('2026-01-01T00:00:00Z'))).toBe('2026-01-01');
    expect(todayJST(new Date('2025-12-31T15:00:00Z'))).toBe('2026-01-01');
  });

  it('strictly validates dates and times', () => {
    expect(isValidDate('2028-02-29')).toBe(true);
    expect(isValidDate('2026-02-29')).toBe(false);
    expect(isValidDate('2026-02-31')).toBe(false);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('00:60')).toBe(false);
  });

  it('calculates normal and overnight shifts after break time', () => {
    expect(calcWorkMinutes('09:00', '18:00', 60)).toBe(480);
    expect(calcWorkMinutes('22:00', '06:00', 60)).toBe(420);
  });

  it('calculates weekdays without host-timezone drift', () => {
    expect(dayOfWeek('2026-01-01')).toBe(4);
  });
});
