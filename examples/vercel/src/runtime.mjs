import { liveConfig } from './config.mjs';
import { createPostgresStore } from './store.mjs';
import { createVercelQueue } from './queue.mjs';

export async function createLiveRuntime(env = process.env) {
  const config = liveConfig(env);
  return {
    config,
    store: await createPostgresStore(config.databaseUrl),
    queue: createVercelQueue(config),
  };
}
