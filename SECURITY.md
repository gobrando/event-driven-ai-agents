# Security and data boundaries

This is a prototype/reference implementation. Use synthetic or public test data until the selected live integration, repository scope and operating controls have been reviewed.

The optional Vercel example currently has four high audit findings through an upstream bundled Zod dependency ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)). Keep its live mode and daemon instances disabled pending a reviewed upstream fix. A dependency override that leaves the embedded copy intact is not a resolution. The root portable runtime has no third-party production dependencies. Details are recorded in [Vercel results](examples/vercel/RESULTS.md#dependency-advisory-unresolved).

- Default commands do not call a model, push a target branch, create an agent-generated PR, subscribe to events or deploy a service.
- Never commit `.env` files, Airtable tokens, GitHub credentials, Codex auth state, job databases, generated worktrees or patches from private repositories. Those runtime files are excluded from Git and Docker build context.
- Use separate producer and worker credentials, each at least32 random bytes. Transport private events over HTTPS. Rotate credentials if exposed; deleting a Git commit is not a substitute for rotation.
- A webhook grants access to submit jobs, not arbitrary commands or paths. Authorize senders and keep repository mapping in operator configuration. Public issue content is untrusted task data.
- The active CI workflows use synthetic input and read-only repository permissions. The live-event GitHub workflow is an inactive example and checks the actor's authority before using event data. Do not put provider API keys at job scope around repository-controlled scripts.
- Codex execution is disabled without both explicit opt-in and a real external cumulative $1 budget-enforcement integration. Environment flags and process timeouts do not implement a spend limit.
- Review artifacts and job records may contain source code and ticket content. Keep them private and define retention and access controls. The bridge's worker token can read this content.
- Worktree isolation prevents accidental edits to the original checkout; it does not sandbox malicious code. Use an OS-level execution boundary before running untrusted checks or models with credentials.

Report a suspected vulnerability through the repository's private vulnerability reporting feature if enabled. Avoid posting secrets or private workload content in public issues. Provider and dependency advisories are tracked during development, but a passing test suite is not a security certification.
