# Trigger adapters

These adapters only validate and enqueue work. Empty polls and ignored events never invoke a model. Fixture mode is the default; both commands use `.state/jobs.sqlite` unless `--db PATH` or `JOB_DB` is supplied. The trigger CLIs also accept legacy `JOB_DB_PATH` when `JOB_DB` is absent; prefer `JOB_DB` for all processes so they share one inbox. Their repository key comes from `--repository-key`, then `AGENT_REPOSITORY_KEY`, then `demo`. Ticket fields cannot choose a checkout, shell command, or repository.

```sh
npm run airtable:poll -- --fixture examples/fixtures/airtable-records.json --once
npm run github:enqueue -- --fixture examples/fixtures/github-event.json
npm run worker -- --once
```

The shared event has `version: 1`, `source`, `type: "ticket.ready"`, a stable `id`, an ISO `occurredAt`, the configured `repository` key, and `data: { title, body }`. Titles are limited to 200 characters and bodies to 6,000. Treat both strings as untrusted task data.

## Airtable polling

Create a test table with these application-owned fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `Ready` | Checkbox | Only boolean `true` is eligible. |
| `Run revision` | Text or positive integer | A deliberate execution revision. Increment for another run. |
| `Title` | Text | Nonempty task title. |
| `Body` | Long text | Optional task description. |

Set `AIRTABLE_TOKEN`, `AIRTABLE_BASE_ID`, and `AIRTABLE_TABLE_ID` in the environment. Use a token limited to record reads on the selected test base. `AIRTABLE_VIEW` optionally narrows the records. `AIRTABLE_READY_FIELD`, `AIRTABLE_REVISION_FIELD`, `AIRTABLE_TITLE_FIELD`, and `AIRTABLE_BODY_FIELD` override field names.

```sh
ALLOW_LIVE_TRIGGERS=true npm run airtable:poll -- --live --once
ALLOW_LIVE_TRIGGERS=true npm run airtable:poll -- --live --interval-seconds 60
```

Live mode performs read-only requests to Airtable's documented `GET /v0/{baseId}/{tableIdOrName}` endpoint and follows each returned `offset`, including after an empty page. Polling defaults to 60 seconds and refuses intervals below 30 seconds. A failed request stops the command with an error instead of treating the source as empty. No record updates, status writeback, or automatic API retries are implemented. See the [official list-records contract](https://airtable.com/developers/web/api/list-records).

An event ID hashes the configured repository key, base/table scope, record ID, and `Run revision`. Identical repeated polls enqueue once in a persistent database. Editing a queued record under the same revision produces `EVENT_CONFLICT`; increment the revision for changed work or a new run. `occurredAt` retains Airtable's `createdTime`, which is record creation time rather than the moment a checkbox changed. Airtable omits empty/false fields, so an absent checkbox is ignored and an absent body becomes an empty string.

A fixture is a complete `{ "records": [...] }` response without `offset`. Fixture mode always performs one pass and makes no network requests. It uses a separate `fixture` source scope. Preserve the database between live polls; deleting it also deletes deduplication history.

## GitHub events

`issues` events enqueue only `action: "labeled"` with `label.name: "ready-for-agent"`. The event ID hashes the configured repository key, issue number, and `issue.updated_at`, so replaying the same delivery is a duplicate. Removing and reapplying the label after an update can create another run. Other issue activities are ignored.

`repository_dispatch` accepts `action: "ticket-ready"`. GitHub exposes its arbitrary `client_payload` JSON; this adapter defines the following application-owned shape:

```json
{
  "action": "ticket-ready",
  "client_payload": {
    "id": "synthetic-task-001",
    "revision": "1",
    "title": "Add a small fixture test",
    "body": "Use only synthetic examples.",
    "occurredAt": "2026-01-01T00:00:00.000Z"
  }
}
```

Pass `--event-name repository_dispatch` for that input. Preserve `id` and `revision` when retrying. Both GitHub mappings ignore repository names, routing instructions, and commands supplied in ticket content.

The [workflow example](../examples/github-actions/agent.yml) is inactive under `examples/`. It checks the triggering actor's current repository permission before checkout or enqueue, then passes `GITHUB_EVENT_PATH` to the CLI as a file. The [official permissions endpoint](https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user) reports the maintain role as `write`; the example accepts `write` or `admin`. It uses read-only repository permissions and the mock worker, with no model secret or writeback step. No issue text is interpolated into shell code.

Live GitHub ingestion requires `--live`, `ALLOW_LIVE_TRIGGERS=true`, and `GITHUB_TRIGGER_AUTHORIZED=true`. The final variable is an assertion from a trusted caller after its maintainer check, not authentication by itself. The mapping library and fixture CLI do not authenticate arbitrary webhook requests. Do not expose either as an unauthenticated HTTP endpoint.

GitHub-hosted runners are ephemeral: this example's SQLite deduplication lasts for that job only. Durable cross-run deduplication and retry handling require a persistent worker/database or a separately authenticated durable enqueue service. The workflow runs code from the repository's default branch and becomes active only after installation there. [GitHub documents the dispatch lifecycle and `client_payload`](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#repository_dispatch).
