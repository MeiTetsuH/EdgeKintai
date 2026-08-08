import { describe, expect, it, vi } from 'vitest';
import { checkRateLimit } from '../src/utils/rate-limit';

describe('authentication rate-limit safety', () => {
  it('fails closed when the production binding is missing', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const allowed = await checkRateLimit(
        undefined,
        'login-account:private-user',
        new Request('https://example.test/api/auth/login'),
      );
      expect(allowed).toBe(false);
      expect(errorSpy).toHaveBeenCalledOnce();
      expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('private-user');
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('keeps local Wrangler preview usable without a binding', async () => {
    await expect(checkRateLimit(
      undefined,
      'login-account:local-user',
      new Request('http://127.0.0.1:8787/api/auth/login'),
    )).resolves.toBe(true);
  });

  it('fails closed when a production limiter throws', async () => {
    const limiter = {
      limit: vi.fn().mockRejectedValue(new Error('binding unavailable')),
    } satisfies RateLimit;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(checkRateLimit(
        limiter,
        'password-verify-account:1',
        new Request('https://example.test/api/auth/profile/password/verify'),
      )).resolves.toBe(false);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
