import { Hono } from 'hono';
import type { TransportTripType, User } from '../types';
import { hashPassword, verifyPassword, verifySecret } from '../utils/password';
import {
  authMiddleware,
  clearSessionCookie,
  consumePasswordReauthentication,
  createSession,
  getRequestUser,
  getSessionToken,
  markSessionReauthenticated,
  revokeSession,
  setSessionCookie,
} from '../middleware/auth';
import {
  boundedInteger,
  optionalString,
  passwordValue,
  readJsonObject,
  RequestValidationError,
  requiredString,
  tripTypeValue,
  usernameValue,
} from '../utils/validation';

type AuthVars = {
  Variables: { user: User };
  Bindings: CloudflareBindings;
};

type PublicUser = Pick<
  User,
  | 'id'
  | 'username'
  | 'display_name'
  | 'is_admin'
  | 'default_one_way_fare'
  | 'default_trip_type'
>;

type LoginUser = User & { password_hash: string };

const DUMMY_PASSWORD_HASH =
  'pbkdf2_sha256$100000$000102030405060708090a0b0c0d0e0f$f5189e60cb03088f4e88e76da67f422cc0e45557767c3a85dc6b4c3e6c0825e0';
const SETUP_TOKEN_PLACEHOLDERS = new Set([
  'change-me',
  'replace-with-openssl-rand-hex-32',
]);

const auth = new Hono<AuthVars>();

function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    display_name: user.display_name,
    is_admin: user.is_admin,
    default_one_way_fare: user.default_one_way_fare,
    default_trip_type: user.default_trip_type,
  };
}

function assertOnlyKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
    throw new RequestValidationError('请求中包含不支持的字段');
  }
}

function loginIdentifier(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string') throw new RequestValidationError(`${label}不能为空`);
  const normalized = value.normalize('NFKC').trim();
  if (normalized.length < 1 || normalized.length > maxLength) {
    throw new RequestValidationError(`${label}格式不正确`);
  }
  return normalized;
}

function credentialString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    throw new RequestValidationError(`${label}格式不正确`);
  }
  return value;
}

function optionalFare(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return boundedInteger(value, '默认片道交通费', 0, 100_000);
}

function optionalTripType(value: unknown): TransportTripType | undefined {
  return value === undefined ? undefined : tripTypeValue(value);
}

auth.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});

// GET /api/auth/status
auth.get('/status', async (c) => {
  const configured = await c.env.DB.prepare(
    'SELECT EXISTS(SELECT 1 FROM users LIMIT 1) AS value',
  ).first<{ value: number }>();
  const user = await getRequestUser(c.env, c.req.raw);

  return c.json({
    setup_required: configured?.value !== 1,
    authenticated: user !== null,
    user: user ? toPublicUser(user) : null,
  });
});

// POST /api/auth/setup
auth.post('/setup', async (c) => {
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, [
    'setup_token',
    'username',
    'password',
    'display_name',
    'default_one_way_fare',
    'default_trip_type',
  ]);

  const setupRate = await c.env.AUTH_RATE_LIMITER.limit({
    key: `setup:${clientAddress(c.req.raw)}`,
  });
  if (!setupRate.success) return c.json({ error: '尝试次数过多，请稍后再试' }, 429);

  const providedSetupToken = typeof body.setup_token === 'string' ? body.setup_token : '';
  const expectedSetupToken = c.env.SETUP_TOKEN;
  if (
    !expectedSetupToken
    || expectedSetupToken.length < 32
    || SETUP_TOKEN_PLACEHOLDERS.has(expectedSetupToken)
  ) {
    return c.json({ error: '初期设置当前不可用' }, 503);
  }
  if (!providedSetupToken || !(await verifySecret(providedSetupToken, expectedSetupToken))) {
    return c.json({ error: '初期设置凭据不正确' }, 403);
  }

  const username = usernameValue(body.username);
  const password = passwordValue(body.password);
  const requestedName = optionalString(body.display_name, '姓名', 80);
  const displayName = requestedName || username;
  const defaultOneWayFare = optionalFare(body.default_one_way_fare) ?? null;
  const defaultTripType = optionalTripType(body.default_trip_type) ?? 'round_trip';
  const passwordHash = await hashPassword(password);
  const createdAt = new Date().toISOString();

  const insert = c.env.DB.prepare(
    `INSERT INTO users (
       username,
       password_hash,
       display_name,
       is_admin,
       default_one_way_fare,
       default_trip_type,
       created_at
     )
     SELECT ?, ?, ?, 1, ?, ?, ?
     WHERE NOT EXISTS (SELECT 1 FROM users)
     RETURNING
       id,
       username,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type`,
  ).bind(
    username,
    passwordHash,
    displayName,
    defaultOneWayFare,
    defaultTripType,
    createdAt,
  );
  const setupAudit = c.env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     )
     SELECT id, id, 'initial_setup', 'user', CAST(id AS TEXT), NULL, ?
     FROM users
     WHERE username = ? AND created_at = ?`,
  ).bind(
    JSON.stringify({
      username,
      display_name: displayName,
      is_admin: 1,
      default_one_way_fare: defaultOneWayFare,
      default_trip_type: defaultTripType,
    }),
    username,
    createdAt,
  );
  const results = await c.env.DB.batch([insert, setupAudit]);
  const user = results[0]?.results?.[0] as User | undefined;

  if (!user) return c.json({ error: '初期设置已完成' }, 403);

  const session = await createSession(c.env, user.id);
  return c.json(
    { success: true, user: toPublicUser(user) },
    201,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

// POST /api/auth/login
auth.post('/login', async (c) => {
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['username', 'password']);
  const username = loginIdentifier(body.username, '登录名', 64);
  const password = credentialString(body.password, '密码', 128);
  const [addressRate, accountRate] = await Promise.all([
    c.env.AUTH_RATE_LIMITER.limit({
      key: `login-ip:${clientAddress(c.req.raw)}`,
    }),
    c.env.AUTH_RATE_LIMITER.limit({
      key: `login-account:${username.toLowerCase()}`,
    }),
  ]);
  if (!addressRate.success || !accountRate.success) {
    return c.json({ error: '尝试次数过多，请稍后再试' }, 429);
  }

  const row = await c.env.DB.prepare(
    `SELECT
       id,
       username,
       password_hash,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type
     FROM users
     WHERE username = ?
     LIMIT 1`,
  )
    .bind(username)
    .first<LoginUser>();

  const valid = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
  if (!row || !valid) {
    return c.json({ error: '登录名或密码不正确' }, 401);
  }

  const session = await createSession(c.env, row.id);
  return c.json(
    { success: true, user: toPublicUser(row) },
    200,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

// POST /api/auth/logout
auth.post('/logout', async (c) => {
  const token = getSessionToken(c.req.raw);
  try {
    await revokeSession(c.env, token);
  } catch (error) {
    console.error(JSON.stringify({
      message: 'session revocation failed',
      error: error instanceof Error ? error.message : String(error),
    }));
    return c.json(
      { error: '退出登录失败，请稍后重试' },
      503,
      { 'Set-Cookie': clearSessionCookie() },
    );
  }

  return c.json(
    { success: true },
    200,
    { 'Set-Cookie': clearSessionCookie() },
  );
});

// GET /api/auth/me
auth.get('/me', authMiddleware, (c) => c.json(toPublicUser(c.get('user'))));

// PATCH /api/auth/profile
auth.patch('/profile', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['display_name', 'default_one_way_fare', 'default_trip_type']);

  const assignments: string[] = [];
  const values: Array<string | number | null> = [];

  if (body.display_name !== undefined) {
    assignments.push('display_name = ?');
    values.push(requiredString(body.display_name, '姓名', 1, 80));
  }

  if (body.default_one_way_fare !== undefined) {
    assignments.push('default_one_way_fare = ?');
    values.push(optionalFare(body.default_one_way_fare) ?? null);
  }

  if (body.default_trip_type !== undefined) {
    assignments.push('default_trip_type = ?');
    values.push(tripTypeValue(body.default_trip_type));
  }

  if (assignments.length === 0) {
    throw new RequestValidationError('请至少提交一个可修改字段');
  }

  values.push(currentUser.id);
  const update = c.env.DB.prepare(
    `UPDATE users
     SET ${assignments.join(', ')}
     WHERE id = ?
     RETURNING
       id,
       username,
       display_name,
       is_admin,
       created_at,
       default_one_way_fare,
       default_trip_type`,
  )
    .bind(...values);
  const afterForAudit = {
    ...currentUser,
    ...(body.display_name !== undefined ? { display_name: values[0] as string } : {}),
    ...(body.default_one_way_fare !== undefined
      ? { default_one_way_fare: optionalFare(body.default_one_way_fare) ?? null }
      : {}),
    ...(body.default_trip_type !== undefined
      ? { default_trip_type: tripTypeValue(body.default_trip_type) }
      : {}),
  };
  const results = await c.env.DB.batch([
    update,
    authAuditStatement(c.env, currentUser.id, 'profile_update', currentUser, afterForAudit),
  ]);
  const updated = results[0]?.results?.[0] as User | undefined;

  if (!updated) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({ success: true, user: toPublicUser(updated) });
});

// POST /api/auth/profile/password/verify
// Keep password verification and password hashing in separate requests so each
// request performs at most one intentionally expensive PBKDF2 operation.
auth.post('/profile/password/verify', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['current_password']);
  const currentPassword = credentialString(body.current_password, '当前密码', 128);

  const [verifyAddressRate, verifyAccountRate] = await Promise.all([
    c.env.AUTH_RATE_LIMITER.limit({
      key: `password-verify-ip:${clientAddress(c.req.raw)}`,
    }),
    c.env.AUTH_RATE_LIMITER.limit({
      key: `password-verify-account:${currentUser.id}`,
    }),
  ]);
  if (!verifyAddressRate.success || !verifyAccountRate.success) {
    return c.json({ error: '尝试次数过多，请稍后再试' }, 429);
  }

  const credential = await c.env.DB.prepare(
    'SELECT password_hash FROM users WHERE id = ? LIMIT 1',
  )
    .bind(currentUser.id)
    .first<{ password_hash: string }>();
  const valid = credential
    ? await verifyPassword(currentPassword, credential.password_hash)
    : false;
  if (!valid) return c.json({ error: '当前密码不正确' }, 401);

  const reauthToken = await markSessionReauthenticated(c.env, c.req.raw, currentUser.id);
  if (!reauthToken) return c.json({ error: 'Unauthorized' }, 401);
  return c.json({
    success: true,
    reauth_token: reauthToken,
    expires_in_seconds: 300,
  });
});

// POST /api/auth/profile/password
auth.post('/profile/password', authMiddleware, async (c) => {
  const currentUser = c.get('user');
  const body = await readJsonObject(c.req.raw);
  assertOnlyKeys(body, ['new_password', 'reauth_token']);
  const newPassword = passwordValue(body.new_password, '新密码');
  const reauthToken = credentialString(body.reauth_token, '重新验证凭据', 64);

  const recentlyVerified = await consumePasswordReauthentication(
    c.env,
    c.req.raw,
    currentUser.id,
    reauthToken,
  );
  if (!recentlyVerified) {
    return c.json({ error: '请先重新验证当前密码' }, 403);
  }

  const passwordHash = await hashPassword(newPassword);
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
      .bind(passwordHash, currentUser.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?')
      .bind(currentUser.id),
    authAuditStatement(c.env, currentUser.id, 'password_change', null, null),
  ]);

  const session = await createSession(c.env, currentUser.id);
  return c.json(
    { success: true, user: toPublicUser(currentUser) },
    200,
    { 'Set-Cookie': setSessionCookie(session) },
  );
});

function authAuditStatement(
  env: CloudflareBindings,
  userId: number,
  action: string,
  before: unknown,
  after: unknown,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO audit_logs (
       actor_user_id, target_user_id, action, entity_type, entity_key, before_json, after_json
     ) VALUES (?, ?, ?, 'user', ?, ?, ?)`,
  ).bind(
    userId,
    userId,
    action,
    String(userId),
    before === null ? null : JSON.stringify(before),
    after === null ? null : JSON.stringify(after),
  );
}

function clientAddress(request: Request): string {
  return request.headers.get('CF-Connecting-IP')?.slice(0, 64) || 'unknown';
}

export default auth;
