import { readFileSync } from 'node:fs';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// PRIVATE DEPLOYMENT OVERRIDE: test the real configured browser allowlist.
const deploymentConfig = readFileSync(new URL('./wrangler.jsonc', import.meta.url), 'utf8');
const privateProbeOrigins = deploymentConfig.match(/"HEALTH_PROBE_ALLOWED_ORIGINS"\s*:\s*"([^"]*)"/)?.[1];
if (!privateProbeOrigins) throw new Error('Deployment health probe allowlist is missing');

const migrations = await readD1Migrations('./migrations');

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-07-29',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        ratelimits: {
          AUTH_RATE_LIMITER: {
            namespace_id: '2316401101',
            simple: { limit: 1_000, period: 60 },
          },
        },
        bindings: {
          DEFAULT_BREAK_MINUTES: '60',
          DEFAULT_ONE_WAY_FARE: '210',
          DEFAULT_TRIP_TYPE: 'round_trip',
          DEFAULT_CLOCK_IN: '10:00',
          DEFAULT_CLOCK_OUT: '19:00',
          OVERTIME_THRESHOLD_HOURS: '180',
          SESSION_TTL_SECONDS: '604800',
          HEALTH_PROBE_ALLOWED_ORIGINS: `https://status.example.test,https://dashboard.example.test,${privateProbeOrigins}`,
          SETUP_TOKEN: 'test-setup-token-0123456789abcdef0123456789abcdef',
          TEST_MIGRATIONS: migrations,
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
  },
});
