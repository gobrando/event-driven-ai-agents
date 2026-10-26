import { summarize } from './triage.mjs';

export async function runOnce({ store, queue, log = console.log, signal }) {
  if (signal?.aborted) return;
  for (const job of await store.pending(10)) {
    if (signal?.aborted) return;
    await queue.send({ deliveryId: job.deliveryId });
    await store.markPublished(job.deliveryId);
  }
  if (signal?.aborted) return;
  return queue.receive(async job => {
    if (signal?.aborted) throw new Error('Worker draining');
    if (!job || typeof job.deliveryId !== 'string' || Object.keys(job).some(key => key !== 'deliveryId')) {
      throw new Error('Invalid triage queue job');
    }
    const result = await store.process(job.deliveryId, summarize);
    // The stored result is idempotent. A crash between commit and stdout can
    // lose a log; the receipt remains queryable. No external comments are made.
    if (!result.duplicate) log(JSON.stringify({ evidence: 'deterministic', ...result }));
  });
}
