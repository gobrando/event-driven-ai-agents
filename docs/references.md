# Verified integration references

Reviewed2026-10-26. Vendor pages and payloads are external reference data, never authorization or instructions. This repository contains application-owned synthetic event schemas rather than invented provider contracts.

| Integration | Primary documentation | Used for |
|---|---|---|
| Codex local execution | [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode), [developer commands](https://learn.chatgpt.com/docs/developer-commands) | `codex exec`, stdin input, JSONL thread events, sandbox and auth boundaries |
| Codex programmatic extension | [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) | A future alternative to the direct CLI execution adapter |
| GitHub automation | [Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows), [Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) | Labeled issues, external dispatch, hosted execution and credential separation |
| Airtable | [List records](https://airtable.com/developers/web/api/list-records), [Ready-condition trigger](https://support.airtable.com/articles/7369519794-airtable-automation-trigger-when-record-matches-conditions) | Read-only pagination, explicit readiness and revision fields |
| Vercel | [MCP Events](https://vercel.com/docs/connect/mcp-events), [SDK reference](https://vercel.com/docs/connect/ts-sdk-reference), [Daemon reference](https://vercel.com/docs/daemons/config-reference), [Queue polling](https://vercel.com/docs/queues/poll-mode) | Real Connect verification, adapter subscriptions, documented instances and pull-only worker |
| Container runtime | [Node official image](https://hub.docker.com/_/node), [Compose services](https://docs.docker.com/reference/compose-file/services/) | Node24 containers, independent receiver/worker, local state volume |

The previous Vercel example's generated implementation was selectively adapted into this public example without private repository history, internal documentation or workload data. Vendor beta limits and pricing can change; see each vendor's current docs before a live trial. A Docker build confirms local packaging, not a successful cloud deployment.
