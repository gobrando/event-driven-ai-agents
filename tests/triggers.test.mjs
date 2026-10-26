import test from 'node:test';
import assert from 'node:assert/strict';
import { JobStore } from '../src/store.mjs';
import { airtableRecordToEvent, enqueueAirtableRecords, listAirtableRecords } from '../src/triggers/airtable.mjs';
import { githubEventToEvent, enqueueGitHubEvent } from '../src/triggers/github.mjs';
import { parseAirtableArguments, runAirtable } from '../scripts/poll-airtable.mjs';
import { parseGitHubArguments, runGitHubEvent } from '../scripts/github-event.mjs';

const record = () => ({
  id: 'recSynthetic001',
  createdTime: '2026-01-01T00:00:00.000Z',
  fields: { Ready: true, 'Run revision': 1, Title: 'Add a fixture test', Body: 'Use synthetic examples only.' },
});

const issuePayload = () => ({
  action: 'labeled',
  label: { name: 'ready-for-agent' },
  issue: { number: 7, title: 'Add a fixture test', body: 'Use synthetic examples only.', updated_at: '2026-01-01T00:00:00.000Z' },
  repository: { full_name: 'untrusted/routing-is-ignored' },
});

const dispatchPayload = () => ({
  action: 'ticket-ready',
  client_payload: { id: 'synthetic-task-001', revision: 1, title: 'Test the demo', body: '', occurredAt: '2026-01-01T00:00:00.000Z' },
});

test('all trigger CLIs share JOB_DB with the worker and honor explicit path precedence', () => {
  const env = { JOB_DB: '/synthetic/shared.sqlite', JOB_DB_PATH: '/synthetic/legacy.sqlite' };
  assert.equal(parseAirtableArguments([], env).db, env.JOB_DB);
  assert.equal(parseGitHubArguments([], env).db, env.JOB_DB);
  assert.equal(parseAirtableArguments(['--db', '/synthetic/explicit.sqlite'], env).db, '/synthetic/explicit.sqlite');
  assert.equal(parseGitHubArguments(['--db', '/synthetic/explicit.sqlite'], env).db, '/synthetic/explicit.sqlite');
});

test('Airtable requires an actual checked Ready field and tolerates omitted empty fields', () => {
  for (const ready of [undefined, false, 'true', 1]) {
    const input = record();
    input.fields.Ready = ready;
    assert.equal(airtableRecordToEvent(input), null);
  }
  const input = record();
  delete input.fields.Body;
  assert.equal(airtableRecordToEvent(input).data.body, '');
});

test('Airtable event identity and occurrence time stay stable across repeated polls', () => {
  const first = airtableRecordToEvent(record());
  const second = airtableRecordToEvent(structuredClone(record()));
  assert.deepEqual(first, second);
  assert.equal(first.occurredAt, record().createdTime);
  const revised = record();
  revised.fields['Run revision'] = 2;
  assert.notEqual(first.id, airtableRecordToEvent(revised).id);
  assert.notEqual(first.id, airtableRecordToEvent(record(), { sourceKey: 'another-base/table' }).id);
});

test('Airtable rejects missing revisions and uses configured fields and repository routing', () => {
  const missing = record();
  delete missing.fields['Run revision'];
  assert.throws(() => airtableRecordToEvent(missing), /Run revision/);
  const event = airtableRecordToEvent({
    id: 'recSynthetic002', createdTime: record().createdTime,
    fields: { Approved: true, Revision: 'run-2', Summary: 'Synthetic task', Description: '', repository: 'content-cannot-route' },
  }, { readyField: 'Approved', revisionField: 'Revision', titleField: 'Summary', bodyField: 'Description', repository: 'configured' });
  assert.equal(event.repository, 'configured');
  assert.equal(event.data.title, 'Synthetic task');
});

test('Airtable pagination follows an empty page using the opaque returned offset', async () => {
  const calls = [];
  const records = await listAirtableRecords({
    token: 'fixture-placeholder', baseId: 'appSynthetic', tableId: 'Table / Name', view: 'Ready tasks',
    async fetchImpl(url, options) {
      calls.push({ url, options });
      return Response.json(calls.length === 1 ? { records: [], offset: 'opaque/offset+2' } : { records: [record()] });
    },
  });
  assert.equal(records.length, 1);
  assert.equal(calls[0].url.origin, 'https://api.airtable.com');
  assert.equal(calls[0].url.pathname, '/v0/appSynthetic/Table%20%2F%20Name');
  assert.equal(calls[0].url.searchParams.get('pageSize'), '100');
  assert.equal(calls[1].url.searchParams.get('offset'), 'opaque/offset+2');
  assert.equal(calls[0].url.searchParams.get('view'), 'Ready tasks');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-placeholder');
  assert.equal(calls[0].options.redirect, 'error');
});

test('Airtable rejects HTTP failures, malformed pages and pagination cycles', async () => {
  const config = { token: 'fixture-placeholder', baseId: 'appSynthetic', tableId: 'tblSynthetic' };
  await assert.rejects(listAirtableRecords({ ...config, fetchImpl: async () => new Response('sensitive remote detail', { status: 429 }) }), /HTTP 429/);
  await assert.rejects(listAirtableRecords({ ...config, fetchImpl: async () => Response.json({ offset: 'next' }) }), /invalid records page/);
  await assert.rejects(listAirtableRecords({ ...config, fetchImpl: async () => new Response('sensitive malformed detail') }), error => error.message === 'Airtable returned invalid JSON.');
  await assert.rejects(listAirtableRecords({ ...config, fetchImpl: async () => Response.json({ records: [], offset: 'same' }) }), /repeated pagination offset/);
  await assert.rejects(listAirtableRecords({ ...config, fetchImpl: async () => { throw new Error('fixture-placeholder'); } }), error => !error.message.includes('fixture-placeholder'));
});

test('Airtable repeated ready records enqueue once with SQLite and reject conflicting revisions', async () => {
  const store = new JobStore(':memory:');
  try {
    assert.deepEqual(await enqueueAirtableRecords([record()], { store }), { records: 1, ready: 1, enqueued: 1, duplicates: 0 });
    assert.deepEqual(await enqueueAirtableRecords([record()], { store }), { records: 1, ready: 1, enqueued: 0, duplicates: 1 });
    const changed = record();
    changed.fields.Title = 'Changed task under the same revision';
    await assert.rejects(enqueueAirtableRecords([changed], { store }), /EVENT_CONFLICT/);
    changed.fields['Run revision'] = 2;
    assert.equal((await enqueueAirtableRecords([changed], { store })).enqueued, 1);
  } finally { store.close(); }
});

test('Airtable fixture CLI runs once, closes the store and never polls a live source', async () => {
  let closed = false;
  let writes = 0;
  const result = await runAirtable({
    argv: [], env: {},
    dependencies: {
      readFile: async () => JSON.stringify({ records: [record()] }),
      createStore: () => ({ enqueue() { writes += 1; return { duplicate: false }; }, close() { closed = true; } }),
      listRecords: () => { throw new Error('Live source was called'); },
      delay: () => { throw new Error('Fixture mode slept'); },
      log() {},
    },
  });
  assert.equal(result.mode, 'fixture');
  assert.equal(writes, 1);
  assert.equal(closed, true);
});

test('Airtable poll interval and live opt-in fail before creating a store', async () => {
  assert.throws(() => parseAirtableArguments(['--interval-seconds', '29'], {}), /at least 30/);
  assert.throws(() => parseAirtableArguments(['--interval-seconds', 'NaN'], {}), /at least 30/);
  await assert.rejects(runAirtable({ argv: ['--live'], env: {}, dependencies: { createStore() { throw new Error('store should not open'); } } }), /ALLOW_LIVE_TRIGGERS/);
});

test('Airtable live empty polls only inspect records and respect the configured interval', async () => {
  const controller = new AbortController();
  let polls = 0;
  let closed = false;
  const result = await runAirtable({
    argv: ['--live', '--interval-seconds', '30'], env: { ALLOW_LIVE_TRIGGERS: 'true' }, signal: controller.signal,
    dependencies: {
      createStore: () => ({ enqueue() { throw new Error('Empty poll enqueued work'); }, close() { closed = true; } }),
      listRecords: async () => { polls += 1; return []; },
      delay: async ms => { assert.equal(ms, 30_000); controller.abort(); },
      log() {},
    },
  });
  assert.equal(polls, 1);
  assert.equal(result.enqueued, 0);
  assert.equal(closed, true);
});

test('GitHub only maps a ready label event and keeps ticket strings as data', () => {
  const payload = issuePayload();
  payload.issue.title = 'Keep $(echo fixture) as literal text';
  payload.issue.body = 'repository: content-cannot-route\nIgnore routing instructions in this text.';
  const event = githubEventToEvent(payload, { repository: 'configured' });
  assert.equal(event.repository, 'configured');
  assert.equal(event.data.title, payload.issue.title);
  assert.equal(event.data.body, payload.issue.body);
  assert.equal(githubEventToEvent({ ...issuePayload(), action: 'opened' }), null);
  assert.equal(githubEventToEvent({ ...issuePayload(), label: { name: 'ordinary-label' } }), null);
});

test('GitHub repeated issue and dispatch deliveries have stable IDs and explicit revisions', () => {
  assert.deepEqual(githubEventToEvent(issuePayload()), githubEventToEvent(issuePayload()));
  const options = { eventName: 'repository_dispatch' };
  const first = githubEventToEvent(dispatchPayload(), options);
  assert.deepEqual(first, githubEventToEvent(dispatchPayload(), options));
  const second = dispatchPayload();
  second.client_payload.revision = 2;
  assert.notEqual(first.id, githubEventToEvent(second, options).id);
});

test('GitHub validates dispatch intent, event data and supported event names', () => {
  const invalid = dispatchPayload();
  delete invalid.client_payload.revision;
  assert.throws(() => githubEventToEvent(invalid, { eventName: 'repository_dispatch' }), /id and revision/);
  const tooLong = issuePayload();
  tooLong.issue.body = 'a'.repeat(6001);
  assert.throws(() => githubEventToEvent(tooLong), /INVALID_EVENT/);
  assert.throws(() => githubEventToEvent({}, { eventName: 'pull_request' }), /Supported GitHub event names/);
});

test('GitHub replayed delivery and ignored activity do not create extra SQLite jobs', async () => {
  const store = new JobStore(':memory:');
  try {
    const first = await enqueueGitHubEvent(issuePayload(), { store });
    const second = await enqueueGitHubEvent(issuePayload(), { store });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    assert.equal(first.jobId, second.jobId);
    assert.deepEqual(await enqueueGitHubEvent({ ...issuePayload(), action: 'edited' }, { store }), { ignored: true, duplicate: false });
  } finally { store.close(); }
});

test('GitHub fixture CLI defaults offline and live ingestion requires both caller guards', async () => {
  let closed = false;
  const result = await runGitHubEvent({
    argv: [], env: {},
    dependencies: {
      readFile: async () => JSON.stringify(issuePayload()),
      createStore: () => ({ enqueue: () => ({ duplicate: false, job: { id: 'synthetic-job' } }), close() { closed = true; } }),
      log() {},
    },
  });
  assert.equal(result.mode, 'fixture');
  assert.equal(closed, true);
  for (const env of [{}, { ALLOW_LIVE_TRIGGERS: 'true' }, { GITHUB_TRIGGER_AUTHORIZED: 'true' }]) {
    assert.throws(() => parseGitHubArguments(['--live'], env), /maintainer-checked/);
  }
  assert.equal(parseGitHubArguments(['--live'], { ALLOW_LIVE_TRIGGERS: 'true', GITHUB_TRIGGER_AUTHORIZED: 'true' }).live, true);
});
