import { JobStore } from '../src/store.mjs';
import { createBridge } from '../src/server.mjs';

const store = new JobStore(process.env.JOB_DB || '.state/jobs.sqlite');
const server = createBridge({ store, webhookSecret: process.env.EVENT_WEBHOOK_SECRET, workerToken: process.env.WORKER_TOKEN });
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('INVALID_PORT');
server.listen(port, host, () => console.log(JSON.stringify({ type: 'listening', host, port })));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close(() => { store.close(); }));
