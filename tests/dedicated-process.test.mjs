import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { loadWorkerConfig } from '../src/config.mjs';
import { signWebhook } from '../src/webhook.mjs';
import { HttpJobStore } from '../src/http-store.mjs';

test('dedicated receiver and remote worker run as separate OS processes', { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-server-'));
  const reserve = createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const config = await loadWorkerConfig(undefined, { stateRoot: root });
  const configPath = join(root, 'agent.config.json');
  await writeFile(configPath, JSON.stringify(config));
  const webhookSecret = randomBytes(32).toString('hex');
  const workerToken = randomBytes(32).toString('hex');
  const server = spawn(process.execPath, ['scripts/server.mjs'], {
    env: { ...process.env, JOB_DB: join(root, 'jobs.sqlite'), PORT: String(port), EVENT_WEBHOOK_SECRET: webhookSecret, WORKER_TOKEN: workerToken },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  server.stdout.on('data', data => { output += data; });
  server.stderr.on('data', data => { output += data; });
  const url = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let tries = 0; tries < 100; tries++) {
      try { ready = (await fetch(`${url}/healthz`)).ok; } catch { /* wait for bind */ }
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, output);
    const body = await readFile('examples/fixtures/ticket.json', 'utf8');
    const accepted = await fetch(`${url}/events`, { method: 'POST', headers: { 'content-type': 'application/json', ...signWebhook(body, webhookSecret) }, body });
    assert.equal(accepted.status, 202);
    const { id } = await accepted.json();
    const worker = spawn(process.execPath, ['scripts/worker.mjs', '--bridge', url, '--config', configPath, '--once'], {
      env: { ...process.env, WORKER_TOKEN: workerToken }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let workerOutput = '';
    worker.stdout.on('data', data => { workerOutput += data; });
    worker.stderr.on('data', data => { workerOutput += data; });
    const [code] = await once(worker, 'close');
    assert.equal(code, 0, workerOutput);
    const job = await new HttpJobStore(url, workerToken).get(id);
    assert.equal(job.state, 'completed');
    assert.equal(job.result.status, 'review-ready');
    assert.equal(job.result.modelSpendUsd, 0);
    assert.match(await readFile(job.result.reviewPath, 'utf8'), /return a \+ b/);
  } finally {
    server.kill('SIGTERM');
    await once(server, 'close');
    await rm(root, { recursive: true, force: true });
  }
});
