import { setTimeout as delay } from 'node:timers/promises';
import { runCodingJob } from './agents/coding.mjs';

export async function workOnce({ store, config, runJob = runCodingJob, signal, log = console.log }) {
  if (signal?.aborted) return null;
  const job = await store.claim();
  if (!job) return null;
  const execution = new AbortController();
  const parentAbort = () => execution.abort();
  signal?.addEventListener('abort', parentAbort, { once: true });
  if (signal?.aborted) execution.abort();
  let leaseLost = false;
  const heartbeat = setInterval(async () => {
    try { await store.renew(job.id, job.leaseToken); }
    catch { leaseLost = true; execution.abort(); }
  }, 100_000);
  heartbeat.unref();
  try {
    const result = await runJob(job.event, { ...config, jobId: job.id, signal: execution.signal });
    if (execution.signal.aborted || leaseLost) throw new Error('LEASE_LOST');
    await store.complete(job.id, job.leaseToken, result);
    log(JSON.stringify({ jobId: job.id, state: 'completed', mode: config.mode || 'mock' }));
    return { id: job.id, result };
  } catch {
    if (!leaseLost) {
      try { await store.fail(job.id, job.leaseToken, execution.signal.aborted ? 'INTERRUPTED' : 'JOB_FAILED'); } catch { /* lease owner changed */ }
    }
    log(JSON.stringify({ jobId: job.id, state: 'retry-or-failed' }));
    return { id: job.id, failed: true };
  } finally {
    clearInterval(heartbeat);
    signal?.removeEventListener('abort', parentAbort);
  }
}

export async function workLoop(options) {
  while (!options.signal?.aborted) {
    try { await workOnce(options); }
    catch { (options.log ?? console.log)(JSON.stringify({ state: 'bridge-retry' })); }
    try { await (options.delay ?? delay)(5000, undefined, { signal: options.signal }); } catch { /* shutdown */ }
  }
}
