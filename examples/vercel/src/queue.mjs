import { PollingQueueClient } from '@vercel/queue';
import { createHash } from 'node:crypto';

export function createVercelQueue({ region, topic, consumerGroup }) {
  // Unpinned jobs survive production rollouts. The inbox/binding still scopes
  // processing; OIDC scopes the queue to this test project and environment.
  const client = new PollingQueueClient({ region, deploymentId: null });
  return {
    // SDK delivery IDs have no documented length bound. Hash the key to stay
    // below Queues' documented 256-character idempotency-key limit.
    send: job => client.send(topic, job, {
      idempotencyKey: createHash('sha256').update(job.deliveryId).digest('hex'),
      retentionSeconds: 3600,
    }),
    receive: handler => client.receive(topic, consumerGroup, handler, {
      limit: 1,
      visibilityTimeoutSeconds: 60,
      cursorFallback: 'earliest',
    }),
  };
}

// In-memory fixture queue: explicit application mock, not an emulated Vercel SLA.
export function createMemoryQueue() {
  const jobs = [];
  const published = new Set();
  return {
    async send(job) {
      if (!published.has(job.deliveryId)) {
        jobs.push(structuredClone(job));
        published.add(job.deliveryId);
      }
      return { messageId: job.deliveryId };
    },
    async receive(handler) {
      if (!jobs.length) return { ok: false, reason: 'empty' };
      await handler(structuredClone(jobs[0]), { messageId: jobs[0].deliveryId });
      jobs.shift(); // Throw leaves the message available for retry.
      return { ok: true };
    },
  };
}
