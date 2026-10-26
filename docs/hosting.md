# Signed webhooks and dedicated hosting

The bridge is ordinary Node HTTP plus SQLite. Run it on one machine with local persistent storage. Workers can share the local database or use the HTTP job API. Do not put a SQLite file on a network filesystem or assume this is a replicated multi-host queue.

## Event contract

`examples/fixtures/ticket.json` is the application-owned normalized contract. It requires exactly:

```json
{
  "version": 1,
  "id": "ticket-001-revision-1",
  "source": "webhook",
  "type": "ticket.ready",
  "repository": "demo",
  "occurredAt": "2026-10-26T12:00:00.000Z",
  "data": { "title": "A synthetic ticket", "body": "The expected behavior and reproduction." }
}
```

This is not a provider's native webhook format. Map a provider's authenticated event into this format. Repository keys are resolved against trusted worker configuration. IDs contain only letters, digits, colon, dot, underscore and hyphen, with a maximum of160 characters; titles are nonblank and at most200, bodies at most6000. HTTP bodies are limited to64KiB.

## Producer protocol

`POST /events` requires JSON plus:

- `x-agent-timestamp`: Unix time in seconds.
- `x-agent-signature`: `sha256=` followed by lowercase hexadecimal HMAC-SHA256 of `timestamp + "." + rawBody`, using `EVENT_WEBHOOK_SECRET`.

The receiver accepts timestamps within five minutes. Sign the exact bytes sent; do not reserialize the payload after signing. Duplicate signed deliveries are accepted as the same job. A matching ID with changed content returns409. A stable source timestamp/revision is part of the event; delivery time is the signature timestamp.

Unsigned, stale or invalid requests return401. Unsupported event shape returns422, malformed JSON400, oversized body413, and temporary storage failure503. A sender can retry503 using the same event identity. This bridge does not pretend to verify GitHub/Airtable native signatures with this application-owned shared secret.

## Worker protocol

All job endpoints require `Authorization: Bearer <WORKER_TOKEN>`. This must differ from the producer credential. Remote URLs require HTTPS, with localhost HTTP allowed for development. Credentials in URLs and redirects are rejected.

- `POST /jobs/claim`: returns a job with a five-minute lease, or204 when idle.
- `POST /jobs/<id>/renew`: JSON `{ "leaseToken": "..." }`.
- `POST /jobs/<id>/complete`: JSON `{ "leaseToken": "...", "result": {} }`.
- `POST /jobs/<id>/fail`: JSON `{ "leaseToken": "...", "error": "CHECKS_FAILED" }`.
- `GET /jobs/<id>`: operator-visible event/result state. This contains ticket content; keep access private.
- `GET /healthz`: public liveness only, with no event or credential detail.

Only a current lease can update a running job. Worker heartbeat renews every100 seconds. Work has a240-second shared execution deadline. Expired leases can be reclaimed, with a three-attempt ceiling. Failure retries wait five seconds. External side effects still need their own idempotency; a queue cannot make arbitrary effects exactly once.

## Deployment checklist specific to this prototype

Compose binds the receiver to `127.0.0.1:${BRIDGE_PORT:-8787}` on the host. Set up an HTTPS reverse proxy, request/rate limits and restricted operator access before exposing it. Do not expose the Codex app server or the job database. The worker needs only outbound access to the bridge for queue operations.

The named `jobs` volume holds the database, synthetic repository and review artifacts. Back it up, monitor failures and disk usage, and define retention before processing real workloads. Container files outside that volume are disposable. Provider credentials and repository configurations are operator-managed; they do not belong in this public source tree.

To run agents against untrusted repository code, use an additional OS/container execution boundary with scoped filesystem/network/credentials. A Git worktree and cleaned environment alone are insufficient. The shipped container's worker is mock-only; no production Codex billing or sandbox service is provisioned.
