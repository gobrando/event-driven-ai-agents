import { createServer } from 'node:http';
import { assertSecret, verifyWebhook, verifyBearer } from './webhook.mjs';

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 65_536) { const error = new Error('BODY_TOO_LARGE'); error.code = 'BODY_TOO_LARGE'; throw error; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createBridge({ store, webhookSecret, workerToken }) {
  assertSecret(webhookSecret);
  assertSecret(workerToken);
  if (webhookSecret === workerToken) throw new Error('Use different webhook and worker credentials');
  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(value === undefined ? undefined : JSON.stringify(value));
    };
    try {
      const url = new URL(request.url, 'http://bridge.invalid');
      if (request.method === 'GET' && url.pathname === '/healthz') return send(200, { ok: true });
      if (url.search) return send(400, { error: 'QUERY_NOT_ALLOWED' });
      if (request.method === 'POST' && url.pathname === '/events') {
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers['content-type'] || '')) return send(415, { error: 'JSON_REQUIRED' });
        const body = await readBody(request);
        if (!verifyWebhook(body, request.headers, webhookSecret)) return send(401, { error: 'INVALID_SIGNATURE' });
        const accepted = store.enqueue(JSON.parse(body));
        return send(accepted.duplicate ? 200 : 202, { id: accepted.job.id, duplicate: accepted.duplicate });
      }
      if (url.pathname.startsWith('/jobs')) {
        if (!verifyBearer(request.headers.authorization, workerToken)) return send(401, { error: 'UNAUTHORIZED' });
        if (request.method === 'POST' && url.pathname === '/jobs/claim') {
          const job = store.claim();
          return send(job ? 200 : 204, job ?? undefined);
        }
        const match = /^\/jobs\/([a-f0-9-]{36})(?:\/(complete|fail|renew))?$/.exec(url.pathname);
        if (!match) return send(404, { error: 'NOT_FOUND' });
        const [, id, action] = match;
        if (request.method === 'GET' && !action) {
          const job = store.get(id);
          return send(job ? 200 : 404, job ?? { error: 'NOT_FOUND' });
        }
        if (request.method === 'POST' && action) {
          const data = JSON.parse(await readBody(request));
          if (!data || typeof data !== 'object' || Array.isArray(data)) return send(400, { error: 'OBJECT_REQUIRED' });
          if (typeof data.leaseToken !== 'string') return send(400, { error: 'LEASE_REQUIRED' });
          if (action === 'renew') { store.renew(id, data.leaseToken); return send(200, { renewed: true }); }
          const job = action === 'complete' ? store.complete(id, data.leaseToken, data.result) : store.fail(id, data.leaseToken, data.error);
          return send(200, job);
        }
      }
      return send(404, { error: 'NOT_FOUND' });
    } catch (error) {
      request.resume();
      const status = ({ INVALID_EVENT: 422, EVENT_CONFLICT: 409, STALE_LEASE: 409, INVALID_RESULT: 422, BODY_TOO_LARGE: 413 })[error.code] ||
        (error instanceof SyntaxError ? 400 : 503);
      return send(status, { error: status === 503 ? 'RETRY_LATER' : error.code || 'INVALID_JSON' });
    }
  });
}
