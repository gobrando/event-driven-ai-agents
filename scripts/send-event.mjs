import { readFile } from 'node:fs/promises';
import { argument } from '../src/config.mjs';
import { validateEvent } from '../src/events.mjs';
import { signWebhook } from '../src/webhook.mjs';
import { validateBridgeUrl } from '../src/http-store.mjs';

const argv = process.argv.slice(2);
const body = JSON.stringify(validateEvent(JSON.parse(await readFile(argument(argv, '--event', 'examples/fixtures/ticket.json'), 'utf8'))));
if (!argv.includes('--send')) {
  console.log(JSON.stringify({ mode: 'dry-run', action: 'POST signed event', event: JSON.parse(body) }, null, 2));
} else {
  const origin = validateBridgeUrl(argument(argv, '--url', 'http://127.0.0.1:8787'));
  const response = await fetch(`${origin}/events`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    headers: { 'content-type': 'application/json', ...signWebhook(body, process.env.EVENT_WEBHOOK_SECRET) }, body,
  });
  if (!response.ok) throw new Error(`WEBHOOK_HTTP_${response.status}`);
  console.log(JSON.stringify(await response.json()));
}
