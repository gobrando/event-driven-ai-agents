import { required } from '../src/config.mjs';
import { createPostgresStore } from '../src/store.mjs';

if (!process.argv.includes('--apply') || process.env.POC_ALLOW_DB_WRITES !== 'true' || process.env.POC_TEST_DATA_ONLY !== 'true') {
  console.log('DRY RUN: initialize dedicated test Postgres inbox/outbox tables. Requires --apply, POC_ALLOW_DB_WRITES=true and POC_TEST_DATA_ONLY=true.');
} else {
  const store = await createPostgresStore(required(process.env, 'DATABASE_URL'));
  try { await store.migrate(); console.log('Test inbox/outbox schema initialized.'); }
  finally { await store.close(); }
}
