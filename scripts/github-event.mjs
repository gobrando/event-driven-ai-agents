import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JobStore } from '../src/store.mjs';
import { enqueueGitHubEvent } from '../src/triggers/github.mjs';

export function parseGitHubArguments(argv, env = process.env) {
  const result = {
    fixture: 'examples/fixtures/github-event.json',
    db: env.JOB_DB ?? env.JOB_DB_PATH ?? '.state/jobs.sqlite',
    repository: env.AGENT_REPOSITORY_KEY ?? 'demo',
    eventName: 'issues',
    live: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const option = argv[i];
    if (option === '--live') result.live = true;
    else if (['--fixture', '--db', '--repository-key', '--event-name'].includes(option)) {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
      if (option === '--fixture') result.fixture = value;
      else if (option === '--db') result.db = value;
      else if (option === '--repository-key') result.repository = value;
      else result.eventName = value;
    } else throw new Error(`Unknown option: ${option}`);
  }
  if (result.live && (env.ALLOW_LIVE_TRIGGERS !== 'true' || env.GITHUB_TRIGGER_AUTHORIZED !== 'true')) {
    throw new Error('Live GitHub events require ALLOW_LIVE_TRIGGERS=true and a maintainer-checked GITHUB_TRIGGER_AUTHORIZED=true caller.');
  }
  return result;
}

export async function runGitHubEvent({ argv = [], env = process.env, dependencies = {} } = {}) {
  const options = parseGitHubArguments(argv, env);
  const payload = JSON.parse(await (dependencies.readFile ?? readFile)(resolve(options.fixture), 'utf8'));
  const store = (dependencies.createStore ?? (db => new JobStore(db)))(options.db);
  try {
    const result = {
      mode: options.live ? 'live' : 'fixture',
      ...await enqueueGitHubEvent(payload, {
        store,
        repository: options.repository,
        eventName: options.eventName,
      }),
    };
    (dependencies.log ?? console.log)(JSON.stringify(result));
    return result;
  } finally {
    await store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runGitHubEvent({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
