# Personal production deployment

This fork deploys EdgeKintai at `https://attendance.mingzhe.uk` and merges verified releases from `workHMZ/EdgeKintai`. The GitHub repository itself is public; do not commit secrets or local credentials.

## Overrides to retain during synchronization

- `wrangler.jsonc`: Worker/account identity, D1 binding, disabled workers.dev/preview URLs and `HEALTH_PROBE_ALLOWED_ORIGINS`.
- `vitest.config.mts`: the marked deployment-only block reads the actual probe allowlist from `wrangler.jsonc` and adds it to the isolated test bindings.
- `test/private-health-cors.test.ts`: verifies the real deployment origins independently of upstream health tests.
- This document.

The production domain is managed in Cloudflare. Preserve existing secrets and domain settings when deploying; do not replace this configuration with the public template.

## Browser health probe

The existing public `GET /health` endpoint is lightweight liveness and does not query D1. Like the R2FileBox deployment, only these exact browser Origin values can read it:

- `https://mingzhe.uk`
- `https://workhmz.github.io`

An Origin has no pathname or trailing slash. The GitHub Pages project path is not part of the allowlist. There is no GitHub Actions health-monitor workflow.

Example for either allowed website:

```js
const response = await fetch('https://attendance.mingzhe.uk/health', {
  mode: 'cors',
  credentials: 'omit',
  cache: 'no-store',
  signal: AbortSignal.timeout(5000),
});
const result = await response.json();
if (!response.ok || result.ok !== true || result.service !== 'edge-kintai') {
  throw new Error('Attendance liveness probe failed');
}
```

This probe does not prove database readiness. `/api/health/ready` requires an authenticated session and does not grant public CORS access. CORS restricts browser response access; it does not prevent non-browser requests to the public liveness endpoint.

## Release checks

Before deploying, run `npm ci`, `npm run verify`, and `npm run deploy:dry-run`. `npm run deploy` applies outstanding D1 migrations before uploading the Worker. Obtain deployment authorization before running it.

After merging an upstream release, compare the documented private delta and preserve upstream test contracts:

```sh
git diff <upstream-tag> --name-only
git diff --exit-code <upstream-tag> -- test/health.test.ts
rg -n 'PRIVATE DEPLOYMENT OVERRIDE' vitest.config.mts
npm run verify
```

Do not use `merge=ours` or `assume-unchanged`, which can hide upstream fixes. Verify CI status, the Cloudflare deployment version and the live endpoint independently.
