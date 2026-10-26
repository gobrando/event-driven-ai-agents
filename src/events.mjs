import { createHash } from 'node:crypto';

export class EventError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function validateEvent(value) {
  const object = input => input !== null && typeof input === 'object' && !Array.isArray(input);
  const exactKeys = (input, keys) => Object.keys(input).length === keys.length && Object.keys(input).every(key => keys.includes(key));
  if (!object(value) || !exactKeys(value, ['version', 'id', 'source', 'type', 'repository', 'occurredAt', 'data']) ||
      value.version !== 1 || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$/.test(value.id ?? '') ||
      typeof value.id !== 'string' || typeof value.source !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.source) ||
      value.type !== 'ticket.ready' || typeof value.repository !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.repository) ||
      typeof value.occurredAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value.occurredAt) || !Number.isFinite(Date.parse(value.occurredAt)) ||
      !object(value.data) || !exactKeys(value.data, ['title', 'body']) ||
      typeof value.data.title !== 'string' || !value.data.title.trim() || value.data.title.length > 200 ||
      typeof value.data.body !== 'string' || value.data.body.length > 6000) throw new EventError('INVALID_EVENT');
  return structuredClone(value);
}

export function eventFingerprint(input) {
  const event = validateEvent(input);
  // Stable ordering, independent of JSON property order. The complete receipt
  // is bound to its ID; a changed ticket needs an explicit new revision/ID.
  return createHash('sha256').update(JSON.stringify([
    event.version, event.id, event.source, event.type, event.repository,
    event.occurredAt, event.data.title, event.data.body,
  ])).digest('hex');
}
