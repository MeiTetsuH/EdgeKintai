import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildHolidayMap, getHolidayData } from '../src/utils/holidays';

describe('official Japanese holiday fallback', () => {
  it('contains the Cabinet Office 2026 substitute and statutory holidays', async () => {
    const data = await getHolidayData(env, 2026);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'rule-based', complete: false });
    expect(data.holidays).toHaveLength(18);
    expect(map.get('2026-05-06')).toBe('休日'); // Substitute holiday for Children's Day
    expect(map.get('2026-09-22')).toBe('休日'); // Substitute holiday for Autumnal Equinox
  });

  it('correctly calculates Silver Week citizens holidays in 2032', async () => {
    // 2032 has a Citizen's Holiday (国民の休日) on 9/21
    // 9/20 is Respect for the Aged Day
    // 9/22 is Autumnal Equinox
    const data = await getHolidayData(env, 2032);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'rule-based', complete: false });
    expect(map.get('2032-09-20')).toBe('敬老の日');
    expect(map.get('2032-09-21')).toBe('休日');
    expect(map.get('2032-09-22')).toBe('秋分の日');
  });

  it('correctly creates substitute holidays when holiday falls on Sunday', async () => {
    // 2034-01-01 should be a Sunday. So 2034-01-02 should be a substitute holiday.
    const data = await getHolidayData(env, 2034);
    const map = buildHolidayMap(data.holidays);
    expect(map.get('2034-01-01')).toBe('元日');
    expect(map.get('2034-01-02')).toBe('休日');
  });

  it('does not pretend an unpublished future year is a working calendar if < 2016', async () => {
    const data = await getHolidayData(env, 2015);
    expect(data).toMatchObject({ source: 'unavailable', complete: false, holidays: [] });
  });
});
