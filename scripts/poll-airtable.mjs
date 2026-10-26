import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { JobStore } from '../src/store.mjs';
import { enqueueAirtableRecords, listAirtableRecords } from '../src/triggers/airtable.mjs';

export function parseAirtableArguments(argv, env = process.env) {
  const result = {
    fixture: 'examples/fixtures/airtable-records.json',
    db: env.JOB_DB ?? env.JOB_DB_PATH ?? '.state/jobs.sqlite',
    repository: env.AGENT_REPOSITORY_KEY ?? 'demo',
    intervalSeconds: 60,
    live: false,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--live') result.live = true;
    else if (option === '--once') result.once = true;
    else if (['--fixture', '--db', '--repository-key', '--interval-seconds'].includes(option)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      if (option === '--fixture') result.fixture = value;
      else if (option === '--db') result.db = value;
      else if (option === '--repository-key') result.repository = value;
      else result.intervalSeconds = Number(value);
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (!Number.isFinite(result.intervalSeconds) || result.intervalSeconds < 30) {
    throw new Error('Airtable polling interval must be at least 30 seconds.');
  }
  if (!result.live) result.once = true;
  if (result.live && env.ALLOW_LIVE_TRIGGERS !== 'true') {
    throw new Error('Live triggers require ALLOW_LIVE_TRIGGERS=true.');
  }
  return result;
}

export async function runAirtable({ argv = [], env = process.env, dependencies = {}, signal } = {}) {
  const options = parseAirtableArguments(argv, env);
  const mapping = {
    repository: options.repository,
    sourceKey: options.live ? `${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}` : 'fixture',
    readyField: env.AIRTABLE_READY_FIELD ?? 'Ready',
    revisionField: env.AIRTABLE_REVISION_FIELD ?? 'Run revision',
    titleField: env.AIRTABLE_TITLE_FIELD ?? 'Title',
    bodyField: env.AIRTABLE_BODY_FIELD ?? 'Body',
  };
  const store = (dependencies.createStore ?? (db => new JobStore(db)))(options.db);
  try {
    let result;
    do {
      if (signal?.aborted) break;
      let records;
      if (options.live) {
        records = await (dependencies.listRecords ?? listAirtableRecords)({
          token: env.AIRTABLE_TOKEN,
          baseId: env.AIRTABLE_BASE_ID,
          tableId: env.AIRTABLE_TABLE_ID,
          view: env.AIRTABLE_VIEW,
          fetchImpl: dependencies.fetchImpl,
          signal,
        });
      } else {
        const fixture = JSON.parse(await (dependencies.readFile ?? readFile)(resolve(options.fixture), 'utf8'));
        if (fixture.offset) throw new Error('Fixture must contain a complete records array, without a pagination offset.');
        records = fixture.records;
      }
      result = { mode: options.live ? 'live' : 'fixture', ...await enqueueAirtableRecords(records, { store, ...mapping }) };
      (dependencies.log ?? console.log)(JSON.stringify(result));
      if (!options.once) await (dependencies.delay ?? delay)(options.intervalSeconds * 1_000, undefined, { signal });
    } while (!options.once);
    return result;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const shutdown = new AbortController();
  process.once('SIGINT', () => shutdown.abort());
  process.once('SIGTERM', () => shutdown.abort());
  try {
    await runAirtable({ argv: process.argv.slice(2), signal: shutdown.signal });
  } catch (error) {
    if (!shutdown.signal.aborted) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
