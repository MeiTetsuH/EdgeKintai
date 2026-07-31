// ================================================================
// Admin 権限ガードミドルウェア
// ================================================================

import { createMiddleware } from 'hono/factory';
import type { AuthEnv } from './auth';

/** Admin権限チェック（authMiddlewareの後に使用） */
export const adminGuard = createMiddleware<AuthEnv>(async (c, next) => {
  const user = c.get('user');
  if (!user || user.is_admin !== 1) {
    return c.json({ error: '管理者権限が必要です' }, 403);
  }
  await next();
});
