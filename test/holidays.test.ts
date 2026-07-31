import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { buildHolidayMap, getHolidayData } from '../src/utils/holidays';

describe('official Japanese holiday fallback', () => {
  it('contains the Cabinet Office 2026 substitute and statutory holidays', async () => {
    const data = await getHolidayData(env, 2026);
    const map = buildHolidayMap(data.holidays);
    expect(data).toMatchObject({ source: 'bundled-official', complete: true });
    expect(data.holidays).toHaveLength(18);
    expect(map.get('2026-05-06')).toBe('休日');
    expect(map.get('2026-09-22')).toBe('休日');
  });

  it('does not pretend an unpublished future year is a working calendar', async () => {
    const data = await getHolidayData(env, 2028);
    expect(data).toMatchObject({ source: 'unavailable', complete: false, holidays: [] });
  });
});
