import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

const ALLOWED_ORIGINS = ['https://mingzhe.uk', 'https://workhmz.github.io'];

describe('personal deployment browser probes', () => {
  it.each(ALLOWED_ORIGINS)('allows %s without cookies or caching', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', { headers: { Origin: origin } });
    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('vary')?.toLowerCase().split(',').map((v) => v.trim())).toContain('origin');
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'edge-kintai' });
  });

  it.each(ALLOWED_ORIGINS)('accepts the GET preflight from %s', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', {
      method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET');
    expect(response.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it.each([
    'https://example.com', 'http://mingzhe.uk', 'https://mingzhe.uk/',
    'https://workhmz.github.io/workHMZ/', 'https://workhmz.github.io.evil.example',
    'https://mingzhe.uk.evil.example',
  ])('rejects browser access from %s', async (origin) => {
    const response = await SELF.fetch('https://example.test/health', { headers: { Origin: origin } });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps authenticated readiness outside public CORS', async () => {
    const response = await SELF.fetch('https://example.test/api/health/ready', {
      headers: { Origin: ALLOWED_ORIGINS[0] },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});
