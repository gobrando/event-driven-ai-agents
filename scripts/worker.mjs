import { JobStore } from '../src/store.mjs';
import { HttpJobStore } from '../src/http-store.mjs';
import { argument, loadWorkerConfig } from '../src/config.mjs';
import { workOnce, workLoop } from '../src/worker.mjs';

const argv = process.argv.slice(2);
const allowed = ['--db', '--config', '--bridge', '--once'];
for (const token of argv.filter(value => value.startsWith('--'))) if (!allowed.includes(token)) throw new Error('UNKNOWN_ARGUMENT');
const config = await loadWorkerConfig(argument(argv, '--config'));
const bridge = argument(argv, '--bridge');
const store = bridge ? new HttpJobStore(bridge, process.env.WORKER_TOKEN) : new JobStore(argument(argv, '--db', process.env.JOB_DB || '.state/jobs.sqlite'));
const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown.abort());
try {
  if (argv.includes('--once')) {
    const result = await workOnce({ store, config, signal: shutdown.signal });
    if (result?.failed) process.exitCode = 1;
    else if (!result) console.log(JSON.stringify({ state: 'idle' }));
  } else await workLoop({ store, config, signal: shutdown.signal });
} finally { await store.close(); }
