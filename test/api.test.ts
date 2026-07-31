import { env, SELF } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { previousDate, todayJST } from '../src/utils/time';

const origin = 'https://example.test';
const setupToken = 'test-setup-token-0123456789abcdef0123456789abcdef';

async function jsonRequest(
  path: string,
  method: string,
  body?: Record<string, unknown>,
  cookie?: string,
  requestOrigin = origin,
): Promise<Response> {
  const headers = new Headers({
    'Content-Type': 'application/json',
    Origin: requestOrigin,
  });
  if (cookie) headers.set('Cookie', cookie);
  return SELF.fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function setupAdmin(): Promise<{ cookie: string; user: Record<string, unknown> }> {
  const response = await jsonRequest('/api/auth/setup', 'POST', {
    setup_token: setupToken,
    username: 'admin',
    display_name: '山田 太郎',
    password: 'strong-password-123',
    default_one_way_fare: 220,
    default_trip_type: 'round_trip',
  });
  expect(response.status).toBe(201);
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('__Host-edge_kintai_session=');
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Secure');
  expect(setCookie).toContain('SameSite=Strict');
  return {
    cookie: setCookie.split(';', 1)[0],
    user: (await response.json<{ user: Record<string, unknown> }>()).user,
  };
}

describe('EdgeKintai API', () => {
  it('protects first setup and creates exactly one administrator', async () => {
    const statusBefore = await SELF.fetch(`${origin}/api/auth/status`);
    expect(await statusBefore.json()).toMatchObject({ setup_required: true, authenticated: false });

    const rejected = await jsonRequest('/api/auth/setup', 'POST', {
      setup_token: 'wrong-token-that-is-long-enough-0000000000',
      username: 'attacker',
      display_name: 'Attacker',
      password: 'strong-password-123',
    });
    expect(rejected.status).toBe(403);

    const { cookie, user } = await setupAdmin();
    expect(user).toMatchObject({ username: 'admin', display_name: '山田 太郎', is_admin: 1 });

    const second = await jsonRequest('/api/auth/setup', 'POST', {
      setup_token: setupToken,
      username: 'second',
      display_name: 'Second',
      password: 'strong-password-123',
    });
    expect(second.status).toBe(403);

    const me = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: 'admin', is_admin: 1 });
  });

  it('keeps login name separate while updating profile and rotating password sessions', async () => {
    const { cookie } = await setupAdmin();
    const profile = await jsonRequest('/api/auth/profile', 'PATCH', {
      display_name: '佐藤 花子',
      default_one_way_fare: 310,
      default_trip_type: 'one_way',
    }, cookie);
    expect(profile.status).toBe(200);
    expect(await profile.json()).toMatchObject({
      user: {
        username: 'admin',
        display_name: '佐藤 花子',
        default_one_way_fare: 310,
        default_trip_type: 'one_way',
      },
    });

    const unverified = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'new-strong-password-456',
      reauth_token: '0'.repeat(64),
    }, cookie);
    expect(unverified.status).toBe(403);

    const wrongVerification = await jsonRequest('/api/auth/profile/password/verify', 'POST', {
      current_password: 'wrong-password-123',
    }, cookie);
    expect(wrongVerification.status).toBe(401);

    const verification = await jsonRequest('/api/auth/profile/password/verify', 'POST', {
      current_password: 'strong-password-123',
    }, cookie);
    expect(verification.status).toBe(200);
    const reauthToken = (await verification.json<{ reauth_token: string }>()).reauth_token;
    expect(reauthToken).toMatch(/^[0-9a-f]{64}$/);

    const changed = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'new-strong-password-456',
      reauth_token: reauthToken,
    }, cookie);
    expect(changed.status).toBe(200);
    const newCookie = (changed.headers.get('set-cookie') ?? '').split(';', 1)[0];
    expect(newCookie).not.toBe(cookie);

    const oldSession = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: cookie } });
    expect(oldSession.status).toBe(401);
    const newSession = await SELF.fetch(`${origin}/api/auth/me`, { headers: { Cookie: newCookie } });
    expect(newSession.status).toBe(200);

    const replayed = await jsonRequest('/api/auth/profile/password', 'POST', {
      new_password: 'third-strong-password-789',
      reauth_token: reauthToken,
    }, newCookie);
    expect(replayed.status).toBe(403);
  });

  it('backfills attendance and calculates round-trip fare on the server', async () => {
    const { cookie } = await setupAdmin();
    const office = await jsonRequest('/api/attendance/2026-07-01', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 220,
      transport_trip_type: 'round_trip',
      memo: '本社勤務',
    }, cookie);
    expect(office.status).toBe(200);
    expect(await office.json()).toMatchObject({
      record: {
        transport_one_way_fee: 220,
        transport_trip_type: 'round_trip',
        transport_fee: 440,
      },
    });

    const paidLeave = await jsonRequest('/api/attendance/2026-07-02', 'PUT', {
      work_type: 'paid_leave',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 999,
      transport_trip_type: 'round_trip',
    }, cookie);
    expect(paidLeave.status).toBe(200);
    expect(await paidLeave.json()).toMatchObject({
      record: { clock_in: null, clock_out: null, break_minutes: 0, transport_fee: 0 },
    });

    const summary = await SELF.fetch(`${origin}/api/attendance/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(summary.status).toBe(200);
    expect(await summary.json()).toMatchObject({
      employee_name: '山田 太郎',
      username: 'admin',
      office_days: 1,
      paid_leave_days: 1,
      total_work_minutes: 480,
      total_transport_fee: 440,
    });

    const exportData = await SELF.fetch(`${origin}/api/export/2026/7`, {
      headers: { Cookie: cookie },
    });
    expect(exportData.status).toBe(200);
    expect(await exportData.json()).toMatchObject({
      employee_name: '山田 太郎',
      records: expect.arrayContaining([
        expect.objectContaining({ work_date: '2026-07-01', transport_fee: 440 }),
      ]),
    });

    const invalid = await jsonRequest('/api/attendance/2026-02-31', 'PUT', {
      work_type: 'office',
      clock_in: '00:99',
    }, cookie);
    expect(invalid.status).toBe(400);
  });

  it('closes a previous-day overnight shift without accepting a 24-hour shift', async () => {
    const { cookie } = await setupAdmin();
    const yesterday = previousDate(todayJST());
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'office', '23:00', NULL, 0, 0, 0, 'round_trip', '')`,
    ).bind(yesterday).run();
    await env.DB.prepare(
      `INSERT INTO attendance (
         user_id, work_date, work_type, clock_in, clock_out, break_minutes,
         transport_fee, transport_one_way_fee, transport_trip_type, memo
       ) VALUES (1, ?, 'paid_leave', NULL, NULL, 0, 0, 0, 'round_trip', '')`,
    ).bind(todayJST()).run();

    const closed = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '01:00',
    }, cookie);
    expect(closed.status).toBe(200);
    expect(await closed.json()).toMatchObject({
      record: { work_date: yesterday, clock_in: '23:00', clock_out: '01:00' },
    });

    await env.DB.prepare('UPDATE attendance SET clock_out = NULL WHERE user_id = 1 AND work_date = ?')
      .bind(yesterday)
      .run();
    const tooLong = await jsonRequest('/api/attendance/clock-out', 'POST', {
      clock_out: '23:00',
    }, cookie);
    expect(tooLong.status).toBe(409);
  });

  it('fails monthly reports closed when authoritative holiday data is unavailable', async () => {
    const { cookie } = await setupAdmin();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('temporarily unavailable', { status: 503 }),
    );
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const response = await SELF.fetch(`${origin}/api/export/2028/1`, {
        headers: { Cookie: cookie },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining('2028'),
      });
      const cachedFailure = await SELF.fetch(`${origin}/api/export/2028/1`, {
        headers: { Cookie: cookie },
      });
      expect(cachedFailure.status).toBe(503);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
      consoleSpy.mockRestore();
    }
  });

  it('enforces admin authorization and same-origin writes', async () => {
    const { cookie } = await setupAdmin();
    await expect(
      env.DB.prepare('DELETE FROM users WHERE id = 1').run(),
    ).rejects.toThrow(/cannot delete last administrator/);
    const crossSite = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
    }, cookie, 'https://evil.example');
    expect(crossSite.status).toBe(403);

    const created = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
      default_one_way_fare: 180,
      default_trip_type: 'round_trip',
    }, cookie);
    expect(created.status).toBe(201);
    const createdBody = await created.json<{ user: { id: number } }>();

    const selfDelete = await jsonRequest('/api/admin/users/1', 'DELETE', {}, cookie);
    expect(selfDelete.status).toBe(400);
    const deleted = await jsonRequest(`/api/admin/users/${createdBody.user.id}`, 'DELETE', {}, cookie);
    expect(deleted.status).toBe(200);
  });

  it('isolates each user and revokes a deleted user immediately', async () => {
    const { cookie: adminCookie } = await setupAdmin();
    const created = await jsonRequest('/api/admin/users', 'POST', {
      username: 'worker',
      display_name: '一般 社員',
      password: 'worker-password-123',
    }, adminCookie);
    const workerId = (await created.json<{ user: { id: number } }>()).user.id;

    const login = await jsonRequest('/api/auth/login', 'POST', {
      username: 'worker',
      password: 'worker-password-123',
    });
    expect(login.status).toBe(200);
    const workerCookie = (login.headers.get('set-cookie') ?? '').split(';', 1)[0];

    const forbidden = await SELF.fetch(`${origin}/api/admin/users`, {
      headers: { Cookie: workerCookie },
    });
    expect(forbidden.status).toBe(403);

    await jsonRequest('/api/attendance/2026-07-06', 'PUT', {
      work_type: 'office',
      clock_in: '09:00',
      clock_out: '18:00',
      break_minutes: 60,
      transport_one_way_fee: 220,
      transport_trip_type: 'round_trip',
    }, adminCookie);
    const workerSummary = await SELF.fetch(`${origin}/api/attendance/2026/7`, {
      headers: { Cookie: workerCookie },
    });
    expect(await workerSummary.json()).toMatchObject({ office_days: 0, total_transport_fee: 0 });

    const removed = await jsonRequest(`/api/admin/users/${workerId}`, 'DELETE', {}, adminCookie);
    expect(removed.status).toBe(200);
    const revoked = await SELF.fetch(`${origin}/api/auth/me`, {
      headers: { Cookie: workerCookie },
    });
    expect(revoked.status).toBe(401);
  });

  it('returns JSON 404 and API security headers', async () => {
    const response = await SELF.fetch(`${origin}/api/does-not-exist`);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('keeps audit data in D1 instead of storing generated files', async () => {
    const { cookie } = await setupAdmin();
    await jsonRequest('/api/attendance/2026-07-03', 'PUT', {
      work_type: 'remote',
      clock_in: '09:30',
      clock_out: '18:00',
      break_minutes: 45,
      transport_one_way_fee: 500,
      transport_trip_type: 'round_trip',
    }, cookie);
    const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM audit_logs')
      .first<{ count: number }>();
    expect(count?.count).toBeGreaterThanOrEqual(2);
  });
});
