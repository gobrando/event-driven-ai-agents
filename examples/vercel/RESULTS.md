# Verification results

Evidence: **deterministic synthetic fixture replay and local container packaging**, checked 2026-10-26. This is not evidence of a deployed Vercel integration or a Codex ticket-to-PR run.

## Passed

- `npm ci --ignore-scripts --no-audit --no-fund`: installed 53 pinned packages. Dependency installation and image build used public package/image registries; tests and replay used no live accounts or services.
- `npm test`: **52 tests passed, zero failures**. Coverage includes valid/invalid/missing signatures through the real pinned Connect verifier, incorrect identity/path/purpose, expired tokens, durable acceptance, failed publication recovery, duplicate suppression, lifecycle controls, and guarded subscription management.
- The same production SQL ran against in-process PGlite, including rollback of receipt/lifecycle writes when outbox insertion failed and a second store instance reading the first instance's stored result.
- `npm run mock`: valid delivery returned `204`; invalid and unsigned deliveries returned `401`; the worker stored/logged one summary; replaying the delivery produced no second summary. Model spend: **$0**.
- `npm run subscriptions -- discover` and `npm run subscriptions -- create`: printed dry-run plans. Tests cover inspect/list/stop dry-run behavior and mock adapter operations without remote writes.
- `npm run db:migrate`: printed a dry-run plan; no external database was connected or changed.
- `node --check` across source, script, and test modules: passed. Source/config/docs scans found no private repository references, personal absolute paths, or live credentials; lockfile download URLs use the public npm registry.
- `docker build --platform linux/amd64 -t event-agents-vercel:local examples/vercel` from the repository root: **passed** using the actual checked-in Dockerfile and lockfile. Image inspection reported `linux/amd64` and runtime user `node`.
- `docker run --rm --network none --platform linux/amd64 --name event-agents-vercel-default-check event-agents-vercel:local`: exited **1** with `Error: Live mode is disabled`, as expected. No credentials, environment file, mounts, or published ports were supplied. The test container was automatically removed. This verifies default startup behavior, not successful live processing.

## Dependency advisory: unresolved

The image build's npm audit reported **four high-severity dependency findings**, all tracing to [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5): Zod resource exhaustion on oversized constrained collections. `npm audit --omit=dev --json` confirmed the chain `@vercel/connect` → `@vercel/oidc` → `@vercel/cli-config` → `zod@4.1.11`. The [Zod release notes](https://github.com/colinhacks/zod/releases/tag/v4.6.6) document the fix in 4.6.6.

No safe upstream dependency-only fix was found at verification time. Public npm metadata showed current Connect 2.5.5/OIDC 4.0.3 still using cli-config 0.3.3 with Zod 4.1.11. Inspection of both the installed cli-config 0.3.1 and the public 0.3.3 package showed Zod 4.1.11 embedded in `dist/index.js`. A [nested npm override](https://docs.npmjs.com/cli/configuring-npm/package-json/#overrides) would replace the separate package but would not repair that embedded copy. An automatic suggested downgrade would lose the required OIDC token-file support. No force fix, misleading audit-only override, or unreviewed dependency fork was applied.

This is an unresolved dependency risk and a **live-trial blocker**, not evidence of a demonstrated exploit in the synthetic replay. Keep cloud instances at zero and resolve/review the dependency chain before activation.

## Not verified

No Vercel project, connector, provider subscription, production deployment, hosted database, Queue service, or model was accessed. Deployed Function discovery, production signing keys, OIDC rotation, provider retry windows, real queue acknowledgment/retry, daemon scheduling/shutdown, cross-deployment recovery, and infrastructure billing remain unverified. The local image's successful build does not establish compatibility with Vercel's hosted build/deployment system.

The offline key/JWKS interception exists only in test support. The in-memory queue/store has no durability guarantee. PGlite verifies the SQL path locally, not hosted database behavior under concurrent networked workloads.

## Next live trial

First resolve the dependency advisory above and rerun the checks. Then intentionally authorize a disposable synthetic test project, stage this example as its standalone project root, confirm current beta eligibility/pricing, and follow the [README procedure](README.md#configuration-and-live-trial-procedure). Start with zero daemon instances, verify the receiver, then create one ten-minute synthetic subscription using a persisted idempotency key. Run one worker instance long enough to observe a stored summary, exercise a duplicate and interrupted publication, and stop the subscription/worker. Record the live evidence and measured cost before extending the scope.
