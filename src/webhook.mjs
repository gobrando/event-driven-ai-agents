import { createHmac, timingSafeEqual } from 'node:crypto';

export function assertSecret(secret) {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32) throw new Error('A secret of at least 32 bytes is required');
}

export function signWebhook(body, secret, timestamp = String(Math.floor(Date.now() / 1000))) {
  assertSecret(secret);
  const signature = createHmac('sha256', secret).update(timestamp).update('.').update(body).digest('hex');
  return { 'x-agent-timestamp': timestamp, 'x-agent-signature': `sha256=${signature}` };
}

export function verifyWebhook(body, headers, secret, { now = Date.now() } = {}) {
  assertSecret(secret);
  const timestamp = headers['x-agent-timestamp'];
  const signature = headers['x-agent-signature'];
  if (typeof timestamp !== 'string' || !/^\d{10,11}$/.test(timestamp) ||
      Math.abs(now / 1000 - Number(timestamp)) > 300 ||
      typeof signature !== 'string' || !/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signWebhook(body, secret, timestamp)['x-agent-signature'];
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function verifyBearer(header, token) {
  const actual = typeof header === 'string' ? Buffer.from(header) : Buffer.alloc(0);
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
