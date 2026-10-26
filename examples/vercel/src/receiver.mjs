import {
  experimental_verifyMcpEvent,
  Experimental_McpEventVerificationError,
} from '@vercel/connect/mcp';
import { validateDeliveryData } from './triage.mjs';

export function createReceiver({ store, queue, verifierOptions, verify = experimental_verifyMcpEvent }) {
  return async function receive(request) {
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    let delivery;
    try {
      delivery = await verify(request, verifierOptions);
    } catch (error) {
      return new Response(null, {
        status: error instanceof Experimental_McpEventVerificationError && error.code === 'invalid_delivery' ? 401 : 503,
      });
    }
    try {
      validateDeliveryData(delivery);
    } catch {
      return new Response(null, { status: 422 });
    }
    try {
      // SQL transaction commits the verified receipt and pending outbox job.
      // Unknown subscription bindings are retryable (including the creation race).
      await store.accept(delivery);
      await queue.send({ deliveryId: delivery.deliveryId });
      await store.markPublished(delivery.deliveryId);
      return new Response(null, { status: 204 });
    } catch {
      // No ack on failed durable acceptance or queue publication.
      // The daemon republishes committed outbox jobs after an interrupted send.
      return new Response(null, { status: 503 });
    }
  };
}
