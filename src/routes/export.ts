import { Hono } from 'hono';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { buildMonthlySummary } from '../utils/summary';
import { yearMonthValues } from '../utils/validation';

const exportRoute = new Hono<AuthEnv>();
exportRoute.use('*', authMiddleware);

/**
 * Returns authoritative monthly data. The browser turns this small JSON payload
 * into XLSX, keeping ZIP/XML work outside the Workers Free 10 ms CPU budget.
 */
exportRoute.get('/:year/:month', async (c) => {
  const { year, month } = yearMonthValues(c.req.param('year'), c.req.param('month'));
  const summary = await buildMonthlySummary(c.env, c.get('user'), year, month);
  return c.json(summary, 200, {
    'Cache-Control': 'private, no-store',
  });
});

export default exportRoute;
