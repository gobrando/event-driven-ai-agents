# Verification results — 2026-10-26

Evidence labels distinguish deterministic fixtures, actual local processes/containers, hosted CI and unverified live-provider behavior. No real business tickets, private source data or model calls were used.

| Check | Result | What it establishes |
|---|---|---|
| `npm run check` | **Passed: lint +45 tests** | Portable validation, SQL persistence/deduplication/lease fencing, HTTP signature/auth rejection, retry handling, real Git/check execution, bounded child processes, mocked publication recovery, and trigger contracts |
| `npm run demo` | **Passed:3 completed jobs** | Airtable fixture +GitHub fixture +actual signed localhost webhook each produce a real tested synthetic patch/review record; original checkout unchanged; duplicate replay does not start another job |
| Documented fixture CLI commands | **Passed** | Airtable poll and GitHub ingestion enqueue into the selected shared DB; the standalone worker processes it |
| Dedicated process test | **Passed** | Receiver and remote-style worker run as separate OS processes and exchange a real HTTP job/lease/result |
| `npm run test:container` | **Passed** | Builds the current Docker source, starts separate unprivileged Compose services, completes a signed synthetic ticket, survives receiver restart, rejects duplicate work, removes its test containers/volume |
| `npm run test:vercel` | **Passed:52 tests** | Real Connect RS256 verifier with ephemeral offline JWKS, durable inbox/outbox SQL in PGlite, adapter/lifecycle contracts, default safety guards |
| `npm run demo:vercel` | **Passed** | Valid delivery204; invalid/missing authentication401; one deterministic triage summary; no duplicate summaries |
| Vercel Linux amd64 Dockerfile | **Passed** | Actual image builds; default startup exits with `Live mode is disabled` with networking disabled and no credentials |
| Quality-gate negative controls | **Passed** | ESLint rejects an unused-variable input; the tampered-delivery test fails against a deliberate signature-bypass mutation in a disposable source copy; actual source unchanged |
| Root production dependency audit | **Passed:0 findings** | Root portable runtime has no third-party production dependencies; this does not cover the optional Vercel dependency tree |
| Public-source inspection | **Passed** | Source/fixtures/config reviewed for personal paths, private-source identifiers, real credentials, auth files and private package URLs; runtime state remains ignored |
| GitHub-hosted CI/manual synthetic workflow | **Pending publication** | Links and observed conclusions will be recorded after the new public repository runs its workflows |

All model spend during these checks was **$0**. Local Git branches and patches are synthetic test artifacts. No agent-generated remote PRs, live subscriptions, production deployments, Airtable writes or provider-event changes were made.

## Known blocker: optional Vercel dependency chain

The Vercel runtime audit reports **four high findings** tracing to Zod4.1.11 bundled inside `@vercel/cli-config`, through `@vercel/oidc`. A normal Zod override would leave the embedded code unchanged. This remains an upstream live-trial blocker; no clean audit or production readiness is claimed for that example. See [the investigation](examples/vercel/RESULTS.md#dependency-advisory-unresolved). Its offline contracts and container build passed independently of this finding.

## Unverified / deliberately unavailable

- Real Airtable permissions, API quotas and continuous production event delivery. The HTTP contract is tested with fixtures/injected responses; no real base was accessed.
- Internet-facing HTTPS ingress, domain/rate-limit configuration, multi-host scaling, disaster recovery and long-term operational reliability. Compose verifies a local single-host setup.
- Real Codex solution quality, model billing, desktop-sidebar integration or an externally enforced cumulative $1 budget. The stock CLI refuses live Codex execution without the additional programmatic enforcing integration. Test model/PR operations are fake transports; Git worktrees and repository checks are real.
- Actual remote draft-PR publication by the agent worker. The implementation validates destination/policy and recovers simulated uncertain creation, but publication was not enabled.
- Vercel production deployment/rollout, signing-key rotation, upstream provider catalogs/subscriptions/renewal/cleanup, real Queue/OIDC-file behavior, external Postgres and infrastructure pricing. Instances remain zero.

The next meaningful trial is one explicitly scoped synthetic ticket on the selected real provider, using approved repository permissions, a reviewed execution boundary and an actual model-budget enforcement service. Keep merge and deployment separate from draft-PR generation.
