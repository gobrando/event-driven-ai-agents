import assert from 'node:assert/strict';
import test from 'node:test';
import { liveConfig } from '../src/config.mjs';

const configured = {
  POC_LIVE_ENABLED: 'true',
  POC_TEST_DATA_ONLY: 'true',
  DATABASE_URL: 'postgresql://synthetic.invalid/test',
  VERCEL_PROJECT_ID: 'prj_synthetic',
  VERCEL_ORG_ID: 'team_synthetic',
};

test('live runtime is unavailable until explicitly enabled', () => {
  assert.throws(() => liveConfig({}), /Live mode is disabled/);
  assert.throws(() => liveConfig({ ...configured, POC_LIVE_ENABLED: 'false' }), /Live mode is disabled/);
});

test('live runtime requires the independent synthetic/public test-data guard', () => {
  assert.throws(() => liveConfig({ ...configured, POC_TEST_DATA_ONLY: 'false' }), /test data/);
});

test('the unimplemented model lane cannot spend money when its flag is enabled', () => {
  assert.throws(() => liveConfig({ ...configured, LLM_ENABLED: 'true' }), /\$0 model budget/);
  assert.equal(liveConfig({ ...configured, LLM_ENABLED: 'false' }).region, 'iad1');
});

test('live runtime fails closed when identity or configured region is missing or changed', () => {
  assert.throws(() => liveConfig({ ...configured, VERCEL_PROJECT_ID: '' }), /Missing VERCEL_PROJECT_ID/);
  assert.throws(() => liveConfig({ ...configured, VERCEL_ORG_ID: '' }), /Missing VERCEL_ORG_ID/);
  assert.throws(() => liveConfig({ ...configured, QUEUE_REGION: 'sfo1' }), /only for iad1/);
});
