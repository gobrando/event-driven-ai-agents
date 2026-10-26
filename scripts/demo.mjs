import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { JobStore } from '../src/store.mjs';
import { createBridge } from '../src/server.mjs';
import { HttpJobStore } from '../src/http-store.mjs';
import { signWebhook } from '../src/webhook.mjs';
import { enqueueAirtableRecords } from '../src/triggers/airtable.mjs';
import { enqueueGitHubEvent } from '../src/triggers/github.mjs';
import { loadWorkerConfig } from '../src/config.mjs';
import { workOnce } from '../src/worker.mjs';

await mkdir('.state', { recursive: true, mode: 0o700 });
const root = await mkdtemp(resolve('.state/demo-'));
const store = new JobStore(`${root}/jobs.sqlite`);
const config = await loadWorkerConfig(undefined, { stateRoot: root });
const webhookSecret = randomBytes(32).toString('hex');
const workerToken = randomBytes(32).toString('hex');
const server = createBridge({ store, webhookSecret, workerToken });
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = `http://127.0.0.1:${server.address().port}`;
const client = new HttpJobStore(origin, workerToken);
try {
  const airtable = JSON.parse(await readFile('examples/fixtures/airtable-records.json', 'utf8'));
  const localResult = await enqueueAirtableRecords(airtable.records, { store });
  assert.equal(localResult.enqueued, 1);
  assert.equal((await enqueueAirtableRecords(airtable.records, { store })).duplicates, 1);
  const github = JSON.parse(await readFile('examples/fixtures/github-event.json', 'utf8'));
  const githubResult = await enqueueGitHubEvent(github, { store });
  assert.equal(githubResult.ignored, false);
  const body = await readFile('examples/fixtures/ticket.json', 'utf8');
  const response = await fetch(`${origin}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signWebhook(body, webhookSecret) }, body });
  assert.equal(response.status, 202);
  const unsigned = await fetch(`${origin}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.equal(unsigned.status, 401);
  const results = [];
  for (let i = 0; i < 3; i++) {
    const done = await workOnce({ store: client, config });
    assert.ok(done && !done.failed, 'Synthetic coding job must pass');
    assert.equal(done.result.status, 'review-ready');
    assert.equal(done.result.modelSpendUsd, 0);
    assert.ok((await readFile(done.result.reviewPath, 'utf8')).includes('return a + b'));
    results.push({ id: done.id, status: done.result.status, reviewPath: done.result.reviewPath });
  }
  assert.equal(await workOnce({ store: client, config }), null);
  // Isolated changes must not modify the original repository checkout.
  assert.equal(await readFile(`${root}/demo-repository/src/answer.mjs`, 'utf8'), 'export function add(a, b) { return a - b; }\n');
  const result = {
    evidence: 'deterministic-local-integration',
    triggers: ['airtable-fixture', 'github-fixture', 'signed-http-webhook'],
    jobsCompleted: results.length, unsignedStatus: unsigned.status, duplicateJobs: 0,
    modelSpendUsd: 0, realPullRequestsCreated: 0, results,
  };
  await writeFile(`${root}/results.json`, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  store.close();
}
