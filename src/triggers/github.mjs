import { createHash } from 'node:crypto';
import { validateEvent } from '../events.mjs';

export const READY_LABEL = 'ready-for-agent';
export const DISPATCH_TYPE = 'ticket-ready';

function stableId(parts) {
  return `github:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

/** Map a trusted delivery file. Authentication/maintainer authorization belongs to the caller. */
export function githubEventToEvent(payload, { eventName = 'issues', repository = 'demo', readyLabel = READY_LABEL } = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid GitHub event object.');
  if (eventName === 'issues') {
    if (payload.action !== 'labeled' || payload.label?.name !== readyLabel) return null;
    const issue = payload.issue;
    if (!issue || !Number.isSafeInteger(issue.number) || issue.number < 1 || issue.pull_request) {
      throw new Error('A ready issue event requires an issue number.');
    }
    return validateEvent({
      version: 1,
      id: stableId([repository, 'issues', issue.number, issue.updated_at]),
      source: 'github',
      type: 'ticket.ready',
      repository,
      occurredAt: issue.updated_at,
      data: { title: issue.title, body: issue.body ?? '' },
    });
  }
  if (eventName === 'repository_dispatch') {
    if (payload.action !== DISPATCH_TYPE) return null;
    // This client_payload contract is application-owned; GitHub forwards arbitrary JSON here.
    const data = payload.client_payload;
    if (!data || typeof data.id !== 'string' || !data.id.trim() || data.id.length > 200 ||
        !((typeof data.revision === 'string' && data.revision.trim()) ||
          (Number.isSafeInteger(data.revision) && data.revision >= 1))) {
      throw new Error('ticket-ready dispatch requires stable client_payload.id and revision.');
    }
    return validateEvent({
      version: 1,
      id: stableId([repository, 'repository_dispatch', data.id, String(data.revision)]),
      source: 'github',
      type: 'ticket.ready',
      repository,
      occurredAt: data.occurredAt,
      data: { title: data.title, body: data.body ?? '' },
    });
  }
  throw new Error('Supported GitHub event names: issues, repository_dispatch.');
}

export async function enqueueGitHubEvent(payload, { store, ...options }) {
  const event = githubEventToEvent(payload, options);
  if (!event) return { ignored: true, duplicate: false };
  const { duplicate, job } = await store.enqueue(event);
  return { ignored: false, duplicate, jobId: job.id };
}
