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

## Dependency and runtime maintenance recorded on 2026-11-11

The four deployment override paths above remain intentional fork customizations. Shared dependency manifests and lockfiles match `workHMZ/EdgeKintai` `2.9.1` (`8d483c46220e5ea9ef84d973d086b0c2844d83ae`) byte-for-byte:

- `wrangler` `^4.160.0` (`miniflare` -> `undici` `7.30.1`) and `@cloudflare/vitest-plugin` `^1.7.0` (`zod` `4.6.6`) now resolve patched versions natively, so the earlier scoped overrides for `miniflare.undici` and `@cloudflare/vitest-plugin.zod` were removed.
- `overrides.minimatch = ^11.0.7` in `package.json` and `package-lock.json` patches [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) in the ESLint development dependency chain (`npm audit`: 0 vulnerabilities). Retain until ESLint's dependency tree resolves `minimatch >=11.0.1` without an override.
- `wrangler.jsonc` aligns `compatibility_date` (`2026-11-10`), `upload_source_maps` and `observability` (`redact_query_string`, `logs`, `traces`) with upstream while retaining the personal Worker/account/D1/Origin settings.
- `.nvmrc` pins Node `24.22.1`; `package.json` keeps `engines.node` at `>=24.22.1 <25`.

On the next upstream merge, review `package.json` and `package-lock.json` alongside the four override paths, keep both repositories' manifests and lockfiles aligned using npm, inspect `npm audit`, and run `npm run verify` plus `npm run deploy:dry-run`.

The existing Cloudflare Git integration follows this fork's `main` and runs the project's verification/deployment scripts. Wait for that deployment rather than issuing a duplicate manual deploy. Check the active version and public `/health` independently; unauthenticated `/api/health/ready` must remain protected.
