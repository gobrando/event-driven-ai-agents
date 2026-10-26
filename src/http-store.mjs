import { assertSecret } from './webhook.mjs';

export function validateBridgeUrl(input) {
  const url = new URL(input);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Bridge URL must be an HTTPS origin, or localhost HTTP');
  }
  return url.origin;
}

export class HttpJobStore {
  constructor(url, workerToken) { this.url = validateBridgeUrl(url); assertSecret(workerToken); this.token = workerToken; }
  async request(path, body, method = 'POST') {
    const response = await fetch(`${this.url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      ...(method !== 'GET' ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    if (response.status === 204) return null;
    if (!response.ok) throw new Error(`BRIDGE_HTTP_${response.status}`);
    return response.json();
  }
  claim() { return this.request('/jobs/claim'); }
  renew(id, leaseToken) { return this.request(`/jobs/${id}/renew`, { leaseToken }); }
  complete(id, leaseToken, result) { return this.request(`/jobs/${id}/complete`, { leaseToken, result }); }
  fail(id, leaseToken, error) { return this.request(`/jobs/${id}/fail`, { leaseToken, error }); }
  get(id) { return this.request(`/jobs/${id}`, undefined, 'GET'); }
  close() {}
}
