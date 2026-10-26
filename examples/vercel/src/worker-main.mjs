import { setTimeout as delay } from 'node:timers/promises';
import { createLiveRuntime } from './runtime.mjs';
import { runOnce } from './worker.mjs';

const shutdown = new AbortController();
process.on('SIGTERM', () => shutdown.abort());
process.on('SIGINT', () => shutdown.abort());

const { store, queue } = await createLiveRuntime();
try {
  while (!shutdown.signal.aborted) {
    try {
      await runOnce({ store, queue, signal: shutdown.signal });
    } catch {
      // Never print tokens, DB URLs or raw provider error bodies.
      console.error(JSON.stringify({ type: 'worker_retry', message: 'Job failed; pending work remains retryable.' }));
    }
    try { await delay(5000, undefined, { signal: shutdown.signal }); } catch { /* drain */ }
  }
} finally {
  await store.close();
}
