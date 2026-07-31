import type { Holiday, HolidayData } from '../types';

const OFFICIAL_CSV_URL =
  'https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv';
const OFFICIAL_DATE_HEADER = '国民の祝日・休日月日';
const OFFICIAL_NAME_HEADER = '国民の祝日・休日名称';
const OFFICIAL_SOURCE = 'official-csv';

// The scheduled refresh runs weekly. Allow one extra day before reporting that
// an otherwise valid cache is stale, so a short source outage is visible to the
// caller without discarding the last known-good official data.
const CACHE_FRESH_MS = 8 * 24 * 60 * 60 * 1000;
const MIN_HOLIDAYS_PER_YEAR = 16;
const MAX_HOLIDAYS_PER_YEAR = 25;
const MAX_SYNC_YEARS = 10;
const MAX_CSV_BYTES = 1_000_000;
const FAILED_SYNC_RETRY_MINUTES = 15;

export class HolidayDataUnavailableError extends Error {
  readonly year: number;

  constructor(year: number) {
    super(`Authoritative Japanese holiday data is unavailable for ${year}`);
    this.name = 'HolidayDataUnavailableError';
    this.year = year;
  }
}

export interface HolidaySyncOptions {
  /** Re-throw source failures so scheduled executions are marked failed. */
  throwOnFailure?: boolean;
  /** Years that must be present in an otherwise valid official CSV. */
  requiredYears?: readonly number[];
}

type HolidayCacheRow = Holiday & {
  row_source: string;
  state_source: string | null;
  item_count: number | null;
  synced_at: string | null;
};

/**
 * Cabinet Office-published fallback data. These values deliberately include
 * substitute holidays and the statutory day between two national holidays.
 */
const BUNDLED_OFFICIAL_HOLIDAYS: Readonly<Record<number, readonly Holiday[]>> = {
  2026: [
    { date_str: '2026-01-01', name_ja: '元日' },
    { date_str: '2026-01-12', name_ja: '成人の日' },
    { date_str: '2026-02-11', name_ja: '建国記念の日' },
    { date_str: '2026-02-23', name_ja: '天皇誕生日' },
    { date_str: '2026-03-20', name_ja: '春分の日' },
    { date_str: '2026-04-29', name_ja: '昭和の日' },
    { date_str: '2026-05-03', name_ja: '憲法記念日' },
    { date_str: '2026-05-04', name_ja: 'みどりの日' },
    { date_str: '2026-05-05', name_ja: 'こどもの日' },
    { date_str: '2026-05-06', name_ja: '休日' },
    { date_str: '2026-07-20', name_ja: '海の日' },
    { date_str: '2026-08-11', name_ja: '山の日' },
    { date_str: '2026-09-21', name_ja: '敬老の日' },
    { date_str: '2026-09-22', name_ja: '休日' },
    { date_str: '2026-09-23', name_ja: '秋分の日' },
    { date_str: '2026-10-12', name_ja: 'スポーツの日' },
    { date_str: '2026-11-03', name_ja: '文化の日' },
    { date_str: '2026-11-23', name_ja: '勤労感謝の日' },
  ],
  2027: [
    { date_str: '2027-01-01', name_ja: '元日' },
    { date_str: '2027-01-11', name_ja: '成人の日' },
    { date_str: '2027-02-11', name_ja: '建国記念の日' },
    { date_str: '2027-02-23', name_ja: '天皇誕生日' },
    { date_str: '2027-03-21', name_ja: '春分の日' },
    { date_str: '2027-03-22', name_ja: '休日' },
    { date_str: '2027-04-29', name_ja: '昭和の日' },
    { date_str: '2027-05-03', name_ja: '憲法記念日' },
    { date_str: '2027-05-04', name_ja: 'みどりの日' },
    { date_str: '2027-05-05', name_ja: 'こどもの日' },
    { date_str: '2027-07-19', name_ja: '海の日' },
    { date_str: '2027-08-11', name_ja: '山の日' },
    { date_str: '2027-09-20', name_ja: '敬老の日' },
    { date_str: '2027-09-23', name_ja: '秋分の日' },
    { date_str: '2027-10-11', name_ja: 'スポーツの日' },
    { date_str: '2027-11-03', name_ja: '文化の日' },
    { date_str: '2027-11-23', name_ja: '勤労感謝の日' },
  ],
};

function cloneHolidays(holidays: readonly Holiday[]): Holiday[] {
  return holidays.map((holiday) => ({ ...holiday }));
}

function isValidYear(year: number): boolean {
  return Number.isInteger(year) && year >= 1955 && year <= 2100;
}

function parseIsoDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function officialDateToIso(value: string): string | null {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(value.trim());
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const iso = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return parseIsoDate(iso) ? iso : null;
}

function parseCsvRow(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('Official holiday CSV contains an unterminated quoted field');
  fields.push(field);
  return fields;
}

/** Parse and strictly validate the Cabinet Office CP932 CSV after decoding. */
export function parseOfficialHolidayCsv(csv: string): Map<number, Holiday[]> {
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) throw new Error('Official holiday CSV is empty');

  const header = parseCsvRow(lines[0]).map((value) => value.trim());
  if (
    header.length !== 2
    || header[0] !== OFFICIAL_DATE_HEADER
    || header[1] !== OFFICIAL_NAME_HEADER
  ) {
    throw new Error('Official holiday CSV header does not match the Cabinet Office format');
  }

  // The requested years receive a stricter per-year check below. This broad
  // bound catches empty/error bodies without depending on how much history the
  // Cabinet Office chooses to retain in future versions of the file.
  const itemCount = lines.length - 1;
  if (itemCount < MIN_HOLIDAYS_PER_YEAR || itemCount > 5_000) {
    throw new Error(`Official holiday CSV row count is implausible: ${itemCount}`);
  }

  const byYear = new Map<number, Holiday[]>();
  const seenDates = new Set<string>();

  for (let lineNumber = 1; lineNumber < lines.length; lineNumber += 1) {
    const fields = parseCsvRow(lines[lineNumber]);
    if (fields.length !== 2) {
      throw new Error(`Official holiday CSV row ${lineNumber + 1} has ${fields.length} columns`);
    }

    const dateStr = officialDateToIso(fields[0]);
    const nameJa = fields[1].trim();
    if (!dateStr) throw new Error(`Official holiday CSV row ${lineNumber + 1} has an invalid date`);
    if (!nameJa || nameJa.length > 100) {
      throw new Error(`Official holiday CSV row ${lineNumber + 1} has an invalid name`);
    }
    if (seenDates.has(dateStr)) {
      throw new Error(`Official holiday CSV contains duplicate date ${dateStr}`);
    }
    seenDates.add(dateStr);

    const year = Number(dateStr.slice(0, 4));
    const holidays = byYear.get(year) ?? [];
    holidays.push({ date_str: dateStr, name_ja: nameJa });
    byYear.set(year, holidays);
  }

  for (const holidays of byYear.values()) {
    holidays.sort((left, right) => left.date_str.localeCompare(right.date_str));
  }
  return byYear;
}

function validateOfficialYear(year: number, holidays: readonly Holiday[]): void {
  if (
    holidays.length < MIN_HOLIDAYS_PER_YEAR
    || holidays.length > MAX_HOLIDAYS_PER_YEAR
  ) {
    throw new Error(`Official holiday count for ${year} is implausible: ${holidays.length}`);
  }

  const seen = new Set<string>();
  for (const holiday of holidays) {
    const parsed = parseIsoDate(holiday.date_str);
    if (!parsed || parsed.year !== year || !holiday.name_ja.trim()) {
      throw new Error(`Official holiday data for ${year} contains an invalid item`);
    }
    if (seen.has(holiday.date_str)) {
      throw new Error(`Official holiday data for ${year} contains duplicate ${holiday.date_str}`);
    }
    seen.add(holiday.date_str);
  }
}

function parseDatabaseTimestamp(value: string | null): number | null {
  if (!value) return null;
  // SQLite datetime('now') has no timezone suffix but is UTC.
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function unavailableHolidayData(year: number): HolidayData {
  return {
    year,
    holidays: [],
    source: 'unavailable',
    complete: false,
    synced_at: null,
  };
}

function bundledHolidayData(year: number): HolidayData | null {
  const fallback = BUNDLED_OFFICIAL_HOLIDAYS[year];
  if (!fallback) return null;
  return {
    year,
    holidays: cloneHolidays(fallback),
    source: 'bundled-official',
    complete: true,
    synced_at: null,
  };
}

async function readResponseBytesLimited(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maximumBytes) {
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
  }

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumBytes) {
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumBytes) {
      await reader.cancel('response too large');
      throw new Error('Cabinet Office holiday CSV exceeds the 1 MB safety limit');
    }
    chunks.push(value);
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

/**
 * Read one year's last known-good official cache in a single D1 statement.
 * Legacy third-party cache rows are intentionally not considered authoritative.
 */
export async function getHolidayData(
  env: CloudflareBindings,
  year: number,
  now = new Date(),
): Promise<HolidayData> {
  if (!isValidYear(year)) return unavailableHolidayData(year);

  const cached = await env.DB.prepare(
    `SELECT
       h.date_str,
       h.name_ja,
       h.source AS row_source,
       s.source AS state_source,
       s.item_count,
       s.synced_at
     FROM holidays_cache h
     LEFT JOIN holiday_sync_state s ON s.year = h.year
     WHERE h.year = ?
     ORDER BY h.date_str`,
  )
    .bind(year)
    .all<HolidayCacheRow>();

  const rows = cached.results;
  const state = rows[0];
  const allOfficial = rows.length > 0
    && rows.every((row) => row.row_source === OFFICIAL_SOURCE)
    && state?.state_source === OFFICIAL_SOURCE
    && state.item_count === rows.length;

  if (allOfficial) {
    const holidays = rows.map(({ date_str, name_ja }) => ({ date_str, name_ja }));
    try {
      validateOfficialYear(year, holidays);
      const syncedTimestamp = parseDatabaseTimestamp(state.synced_at);
      const stale = syncedTimestamp === null
        || now.getTime() - syncedTimestamp > CACHE_FRESH_MS
        || now.getTime() < syncedTimestamp;
      return {
        year,
        holidays,
        source: 'cache',
        complete: !stale,
        synced_at: state.synced_at,
      };
    } catch {
      // Do not expose a malformed cache. The bundled fallback below remains
      // available for the two years that were manually verified from CAO data.
    }
  }

  return bundledHolidayData(year) ?? unavailableHolidayData(year);
}

/**
 * Fetch the Cabinet Office CSV once, then atomically replace each requested
 * year's cache. Normal current+next-year refresh uses only six D1 statements.
 * Any fetch, parse, validation, or batch failure leaves the old cache intact.
 */
export async function syncOfficialHolidays(
  env: CloudflareBindings,
  years: readonly number[],
  options: HolidaySyncOptions = {},
): Promise<HolidayData[]> {
  const requestedYears = [...new Set(years)];
  if (
    requestedYears.length === 0
    || requestedYears.length > MAX_SYNC_YEARS
    || requestedYears.some((year) => !isValidYear(year))
  ) {
    throw new RangeError(`Holiday sync requires 1-${MAX_SYNC_YEARS} valid years`);
  }
  if (options.requiredYears?.some((year) => !requestedYears.includes(year))) {
    throw new RangeError('Required holiday years must be included in requested years');
  }

  try {
    const response = await fetch(OFFICIAL_CSV_URL, {
      headers: { Accept: 'text/csv' },
      cache: 'no-cache',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Cabinet Office holiday CSV returned HTTP ${response.status}`);
    }

    const csvBytes = await readResponseBytesLimited(response, MAX_CSV_BYTES);
    const csv = new TextDecoder('shift_jis', { fatal: true, ignoreBOM: false }).decode(csvBytes);
    const officialByYear = parseOfficialHolidayCsv(csv);
    for (const requiredYear of options.requiredYears ?? []) {
      if (!officialByYear.has(requiredYear)) {
        throw new Error(`Official holiday CSV does not contain required year ${requiredYear}`);
      }
    }
    const sourceModified = response.headers.get('last-modified')
      ?? response.headers.get('etag');

    const statements: D1PreparedStatement[] = [];
    const refreshed = new Map<number, Holiday[]>();

    for (const year of requestedYears) {
      const holidays = officialByYear.get(year);
      // The Cabinet Office normally publishes only through the following year.
      // A not-yet-published year is not a reason to destroy its previous cache.
      if (!holidays) continue;
      validateOfficialYear(year, holidays);

      statements.push(
        env.DB.prepare('DELETE FROM holidays_cache WHERE year = ?').bind(year),
      );

      // Four bound values per item and at most 25 items keeps this statement at
      // D1's 100-bound-parameter limit.
      const valueGroups = holidays.map(() => '(?, ?, ?, ?)').join(', ');
      const values = holidays.flatMap((holiday) => [
        year,
        holiday.date_str,
        holiday.name_ja,
        OFFICIAL_SOURCE,
      ]);
      statements.push(
        env.DB.prepare(
          `INSERT INTO holidays_cache (year, date_str, name_ja, source)
           VALUES ${valueGroups}`,
        ).bind(...values),
      );
      statements.push(
        env.DB.prepare(
          `INSERT INTO holiday_sync_state
             (year, source, item_count, source_modified, synced_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(year) DO UPDATE SET
             source = excluded.source,
             item_count = excluded.item_count,
             source_modified = excluded.source_modified,
             synced_at = excluded.synced_at`,
        ).bind(year, OFFICIAL_SOURCE, holidays.length, sourceModified),
      );
      statements.push(
        env.DB.prepare('DELETE FROM holiday_sync_failures WHERE year = ?').bind(year),
      );
      refreshed.set(year, holidays);
    }

    if (statements.length > 0) await env.DB.batch(statements);

    const syncedAt = new Date().toISOString();
    const results: HolidayData[] = [];
    for (const year of requestedYears) {
      const holidays = refreshed.get(year);
      if (holidays) {
        results.push({
          year,
          holidays: cloneHolidays(holidays),
          source: 'official-csv',
          complete: true,
          synced_at: syncedAt,
        });
      } else {
        results.push(await getHolidayData(env, year));
      }
    }
    return results;
  } catch (error) {
    console.error(JSON.stringify({
      level: 'error',
      event: 'holiday_sync_failed',
      error: error instanceof Error ? error.name : 'UnknownError',
    }));
    if (options.throwOnFailure) throw error;
    return Promise.all(requestedYears.map((year) => getHolidayData(env, year)));
  }
}

/**
 * Return data safe for monthly calculations. Uncached years are fetched on
 * demand; if the official source and bundled fallback are both unavailable we
 * fail closed instead of counting national holidays as ordinary workdays.
 */
export async function getRequiredHolidayData(
  env: CloudflareBindings,
  year: number,
): Promise<HolidayData> {
  const cached = await getHolidayData(env, year);
  if (cached.source !== 'unavailable') return cached;

  const recentFailure = await env.DB.prepare(
    `SELECT year
     FROM holiday_sync_failures
     WHERE year = ? AND retry_after > datetime('now')
     LIMIT 1`,
  )
    .bind(year)
    .first<{ year: number }>();
  if (recentFailure) throw new HolidayDataUnavailableError(year);

  const [synced] = await syncOfficialHolidays(env, [year]);
  if (synced?.source !== 'unavailable') return synced;
  await env.DB.prepare(
    `INSERT INTO holiday_sync_failures (year, retry_after, created_at)
     VALUES (?, datetime('now', ?), datetime('now'))
     ON CONFLICT(year) DO UPDATE SET
       retry_after = excluded.retry_after,
       created_at = excluded.created_at`,
  )
    .bind(year, `+${FAILED_SYNC_RETRY_MINUTES} minutes`)
    .run();
  throw new HolidayDataUnavailableError(year);
}

/** Current JST year plus next year, intended for the weekly scheduled handler. */
export function currentAndNextJstYears(now = new Date()): [number, number] {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const currentYear = jst.getUTCFullYear();
  return [currentYear, currentYear + 1];
}

export async function syncCurrentAndNextOfficialHolidays(
  env: CloudflareBindings,
  now = new Date(),
  options: HolidaySyncOptions = {},
): Promise<HolidayData[]> {
  const years = currentAndNextJstYears(now);
  const requiredYears = options.throwOnFailure
    ? [...new Set([years[0], ...(options.requiredYears ?? [])])]
    : options.requiredYears;
  return syncOfficialHolidays(env, years, { ...options, requiredYears });
}

/** Build a de-duplicated date-to-name map. */
export function buildHolidayMap(holidays: readonly Holiday[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const holiday of holidays) map.set(holiday.date_str, holiday.name_ja);
  return map;
}
