export const DESTINATION_PATH = '/api/hooks';

export function required(env, name) {
  if (!env[name]?.trim()) throw new Error(`Missing ${name}`);
  return env[name];
}

export function liveConfig(env = process.env) {
  if (env.POC_LIVE_ENABLED !== 'true') throw new Error('Live mode is disabled');
  if (env.POC_TEST_DATA_ONLY !== 'true') throw new Error('Confirm synthetic/public test data with POC_TEST_DATA_ONLY=true');
  if (env.LLM_ENABLED && env.LLM_ENABLED !== 'false') throw new Error('LLM calls are not implemented; this POC has a $0 model budget');
  const region = env.QUEUE_REGION || 'iad1';
  // One explicitly tested region, matching the reviewed daemon configuration.
  if (region !== 'iad1') throw new Error('This POC is configured only for iad1');
  return {
    databaseUrl: required(env, 'DATABASE_URL'),
    region,
    topic: 'mcp-triage-test',
    consumerGroup: 'triage-v1',
    verifier: {
      path: DESTINATION_PATH,
      projectId: required(env, 'VERCEL_PROJECT_ID'),
      ownerId: required(env, 'VERCEL_ORG_ID'),
      environment: 'production',
    },
  };
}
