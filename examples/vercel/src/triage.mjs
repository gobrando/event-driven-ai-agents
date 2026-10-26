export const TEST_EVENT_NAME = 'synthetic.issue.created';

// Application-owned synthetic schema, never asserted to be a provider schema.
export function validateDeliveryData(delivery) {
  if (!delivery.event) return;
  const { name, data } = delivery.event;
  if (name !== TEST_EVENT_NAME || !data || Array.isArray(data) ||
      Object.keys(data).some(key => !['id', 'title', 'body'].includes(key)) ||
      typeof data.id !== 'string' || !/^[A-Z0-9-]{1,40}$/.test(data.id) ||
      typeof data.title !== 'string' || !data.title.trim() || data.title.length > 200 ||
      typeof data.body !== 'string' || data.body.length > 4000) {
    throw new Error('Unsupported event or synthetic issue schema');
  }
}

export function summarize(delivery) {
  validateDeliveryData(delivery);
  if (delivery.control?.type === 'gap') return 'Event gap: source reconciliation is required; subscription paused.';
  if (delivery.control?.type === 'terminated') return 'Subscription terminated: no further triage work will start.';
  const { id, title, body } = delivery.event.data;
  const clean = value => value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  const priority = /\b(outage|data loss|security)\b/i.test(`${title} ${body}`) ? 'review promptly' : 'normal review';
  return `${id}: ${clean(title)} — ${priority}. ${clean(body).slice(0, 160)}${clean(body).length > 160 ? '…' : ''} Next: confirm reproduction and scope.`;
}
