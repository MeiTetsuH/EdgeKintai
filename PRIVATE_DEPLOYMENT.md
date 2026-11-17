# Personal production deployment

This fork deploys EdgeKintai at `https://attendance.mingzhe.uk` and merges verified releases from `workHMZ/EdgeKintai`. The GitHub repository itself is public; do not commit secrets or local credentials.

## Overrides to retain during synchronization

- `wrangler.jsonc`: Worker/account identity (`worktime`), D1 binding, disabled `workers.dev`/preview URLs and `HEALTH_PROBE_ALLOWED_ORIGINS`.
- `vitest.config.mts`: the marked deployment-only block reads the actual probe allowlist from `wrangler.jsonc` and appends it to the isolated test bindings without loading `.dev.vars`.
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
git diff <upstream-commit-or-tag> --name-only
git diff --exit-code <upstream-commit-or-tag> -- test/health.test.ts
rg -n 'PRIVATE DEPLOYMENT OVERRIDE' vitest.config.mts
npm run verify
```

Do not use `merge=ours` or `assume-unchanged`, which can hide upstream fixes. Verify CI status, the Cloudflare deployment version and the live endpoint independently.

## Dependency and runtime maintenance recorded on 2026-11-17

The four deployment override paths above remain intentional fork customizations. Shared dependency manifests and lockfiles match `workHMZ/EdgeKintai` commit `4146074` (print styles, README screenshots and dependency updates on top of `2.9.1`) byte-for-byte:

- `wrangler` `^4.163.0` (`undici` `7.30.1`) and `@cloudflare/vitest-plugin` `^1.8.3` (`zod` `4.6.6`) resolve patched versions natively, so no scoped overrides are needed. `hono` is `^4.13.19`, `eslint` `^10.15.0` and `@cloudflare/workers-types` `^5.20261116.1`.
- The `minimatch` override was removed on 2026-11-17: ESLint 10.15 requires `minimatch ^11.0.5` and the lockfile resolves `11.0.9`, which patches [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) (`npm audit`: 0 vulnerabilities).
- `wrangler.jsonc` aligns `compatibility_date` (`2026-11-10`), `upload_source_maps` and `observability` (`redact_query_string`, `logs`, `traces`) with upstream while retaining the personal Worker/account/D1/Origin settings.
- `.nvmrc` pins Node `24.22.1`; `package.json` keeps `engines.node` at `>=24.22.1 <25`. Node `24.22.3` is the latest 24.x; the floor stays at `24.22.1`, matching the `NODE_VERSION=24.22.1` build variable documented in `README.md`.
- The CI workflow pins `actions/setup-node` to `v7.1.0` and `actions/checkout` to `v7.0.1` by commit SHA.

On the next upstream merge, review `package.json` and `package-lock.json` alongside the four override paths, keep both repositories' manifests and lockfiles aligned using npm, inspect `npm audit`, and run `npm run verify` plus `npm run deploy:dry-run`.

The existing Cloudflare Git integration follows this fork's `main` and runs the project's verification/deployment scripts. Wait for that deployment rather than issuing a duplicate manual deploy. Check the active version and public `/health` independently; unauthenticated `/api/health/ready` must remain protected.
