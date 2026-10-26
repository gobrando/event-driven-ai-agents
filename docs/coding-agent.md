# Ticket to review artifact or draft pull request

`runCodingJob(event, trustedOptions)` runs a ticket against one configured local Git repository. Events contain a repository **key**, title, and body. Filesystem paths, checks, allowed paths, GitHub destination, base revision, and execution policy come only from the operator's configuration. Ticket text cannot supply a shell command or destination.

The default mock performs real local work: it creates a deterministic `codex/ticket-<job-id>` branch in an isolated Git worktree, fixes the documented synthetic fixture, runs configured checks as argument arrays, and writes `review.patch` plus `result.json` outside the source checkout. It does not invoke a model, push a branch, or create a remote pull request. The source checkout's files remain unchanged. Git worktree/branch metadata is added to its Git repository.

The mock accepts exactly this `src/answer.mjs` fixture:

```js
export function add(a, b) { return a - b; }
```

The file must end with one newline. The mock replaces subtraction with addition and refuses other source contents. Configure a real check such as `node --test` with a test asserting `add(2, 3) === 5`. `examples/agent.config.json` shows the trusted configuration shape; replace its placeholder paths and GitHub destination. `workRoot` must be absolute and outside the source repository.

```js
import { runCodingJob } from '../src/agents/coding.mjs';

const result = await runCodingJob({
  version: 1, id: 'synthetic-ticket-1', source: 'local-fixture',
  type: 'ticket.ready', repository: 'demo',
  occurredAt: '2026-10-26T12:00:00Z',
  data: { title: 'Correct addition in the synthetic example', body: 'Make add(2, 3) return 5.' },
}, trustedConfiguration);
```

The job key derives from source, event ID, and configured repository key. Replays reuse the worktree and saved result. Reusing that identity with changed ticket content or trusted configuration is rejected. Run only one leased execution for a given job key at a time; the shared queue/store owns concurrency. Failed jobs retain their worktree and bounded diagnostics for inspection. Successful check output is retained in private `checks.json`; the queue result carries command/exit-code summaries and an artifact path so verbose tests do not exceed the HTTP result limit. An operator can remove disposable worktrees with `git worktree remove <path>` and delete their local job directory after preserving evidence.

## Checks and execution boundaries

Checks receive a fresh HOME/TMPDIR and an explicit environment allowlist containing PATH, locale, CI, and noninteractive Git settings. They receive no GitHub, model, webhook, or other inherited provider secrets. Git hooks are disabled for host Git commands. Changes are checked against `allowedPaths` before and after checks, symlink changes are rejected, and staging names the explicit changed files. Source commands are executed without a shell. Total command execution has a default maximum of 240 seconds and output is bounded to 512 KiB per command.

A worktree is filesystem isolation for the checkout, not a security sandbox for arbitrary repository tests. Use trusted test repositories, synthetic/public content, and a disposable host/container without sensitive files or network credentials. Repository code can access resources allowed to its operating-system user. Checks must not be run on hostile repositories on a personal workstation. Publication credentials are introduced only after repository-controlled checks finish.

## Optional Codex integration

The stock CLI demo leaves model execution disabled. `mode: 'codex'` requires both `ALLOW_CODEX=true` and an injected trusted `codexBudgetEnforcer` function. The function receives `{maxUsd: 1, jobId, signal, run}` and must enforce the **cumulative** $1 maximum across retries and concurrent jobs according to the operator's shared budget policy before calling `run()`. An environment flag, process timeout, or CLI token count is not a spend cap. No built-in paid-provider budget integration is claimed. Installing a trustworthy enforcing integration is an open question; the public CLI cannot enable this lane from JSON configuration alone.

When both guards are present, the runner invokes the preinstalled CLI through an argument array:

```text
codex exec --ignore-user-config --sandbox workspace-write --json -C <worktree> -
```

The prompt goes through stdin; JSONL `thread.started.thread_id` is retained in the result for later inspection. No provider API keys are passed through the runner's environment. The operator must supply an appropriately isolated, authenticated local execution environment within the external budget integration. This module does not install the CLI, log in, copy auth files, or run real model calls during tests. Follow the official [non-interactive Codex guidance](https://learn.chatgpt.com/docs/non-interactive-mode) and use a separate credential-safe service/action for public CI rather than copying personal account authentication into a public workflow.

## Optional draft PR publication

Publication is independent of the model lane and requires **both** `publish: true` in trusted configuration and `ALLOW_GIT_WRITES=true`. A trusted `baseBranch` is also required. After passing checks, the publisher verifies both fetch and push origin URLs exactly match the configured `githubRepository` on github.com, commits explicitly staged files, and pushes only the deterministic branch without force. The current patch hash must still match the checked artifact. `gh pr create` receives `--draft` and a body file. It never merges, deploys, or publishes a site.

The publisher first looks for any prior PR on the deterministic branch in the configured repository. Repeating an uncertain creation recovers the existing open draft URL instead of opening another PR. Existing closed, non-draft, or fork PRs fail closed. GitHub credentials are introduced only for the publisher's `gh` process and Git transport, after checks finish. An explicit `GH_TOKEN`/`GITHUB_TOKEN` uses a generated askpass helper; no token is embedded in a file or remote URL. SSH transport can use the host's separately configured authentication. No remote operations run in mock mode unless publication is explicitly enabled. The reviewed local artifact remains useful without GitHub credentials.

The injectable `runCommand` hook is a trusted testing boundary, not an event-controlled plugin interface. Tests use it to simulate model/remote commands while exercising real local Git worktrees and checks. Tests also prove timeout/output bounds, scope rejection, default no-publication behavior, and secret removal from checks.
