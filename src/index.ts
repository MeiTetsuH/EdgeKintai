import { Hono } from 'hono';
import adminRoutes from './routes/admin';
import attendanceRoutes from './routes/attendance';
import authRoutes from './routes/auth';
import exportRoutes from './routes/export';
import { authMiddleware, type AuthEnv } from './middleware/auth';
import { getPublicConfig } from './utils/config';
import {
  getHolidayData,
  HolidayDataUnavailableError,
  syncCurrentAndNextOfficialHolidays,
} from './utils/holidays';
import { RequestValidationError } from './utils/validation';

const app = new Hono<AuthEnv>();

app.use('/api/*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.header('X-Request-Id', requestId);
  c.header('Cache-Control', 'no-store');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');

  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const origin = c.req.header('Origin');
    const fetchSite = c.req.header('Sec-Fetch-Site');
    const expectedOrigin = new URL(c.req.url).origin;
    if ((origin && origin !== expectedOrigin) || fetchSite === 'cross-site') {
      return c.json({ error: '跨站请求已被拒绝' }, 403);
    }
  }

  await next();
});

app.get('/api/health', async (c) => {
  await c.env.DB.prepare('SELECT 1 AS ok').first();
  return c.json({ ok: true, service: 'edge-kintai' });
});

app.get('/api/config', (c) => c.json(getPublicConfig(c.env)));

app.route('/api/auth', authRoutes);
app.route('/api/attendance', attendanceRoutes);
app.route('/api/export', exportRoutes);
app.route('/api/admin', adminRoutes);

app.get('/api/holidays/:year', authMiddleware, async (c) => {
  const yearText = c.req.param('year');
  if (!/^\d{4}$/.test(yearText)) throw new RequestValidationError('年份不正确');
  const year = Number(yearText);
  if (year < 1955 || year > 2100) throw new RequestValidationError('年份必须在 1955-2100 之间');
  return c.json(await getHolidayData(c.env, year));
});

app.notFound((c) => c.json({ error: 'API 不存在' }, 404));

app.onError((error, c) => {
  if (error instanceof RequestValidationError) {
    return c.json({ error: error.message }, error.status);
  }
  if (error instanceof HolidayDataUnavailableError) {
    return c.json({ error: `${error.year} 年的日本节假日数据暂时不可用，请稍后重试` }, 503);
  }

  const requestId = c.res.headers.get('X-Request-Id') ?? 'unknown';
  console.error(JSON.stringify({
    level: 'error',
    event: 'request_failed',
    request_id: requestId,
    method: c.req.method,
    path: c.req.path,
    error: error instanceof Error ? error.name : 'UnknownError',
  }));
  return c.json({ error: '服务器发生错误', request_id: requestId }, 500);
});

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil((async () => {
      const results = await Promise.allSettled([
        env.DB.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run(),
        syncCurrentAndNextOfficialHolidays(env, new Date(), { throwOnFailure: true }),
      ]);
      const failures = results.filter((result) => result.status === 'rejected');
      if (failures.length > 0) {
        throw new Error(`Scheduled maintenance failed (${failures.length}/2 tasks)`);
      }
    })());
  },
} satisfies ExportedHandler<CloudflareBindings>;
