import { createHash } from 'node:crypto';
import { validateEvent } from '../events.mjs';

export const DEFAULT_AIRTABLE_MAPPING = Object.freeze({
  repository: 'demo',
  sourceKey: 'fixture',
  readyField: 'Ready',
  revisionField: 'Run revision',
  titleField: 'Title',
  bodyField: 'Body',
});

function revisionValue(value) {
  if ((typeof value === 'string' && value.trim()) ||
      (Number.isSafeInteger(value) && value >= 1)) return String(value);
  throw new Error('Ready Airtable records require a nonempty Run revision string or positive integer.');
}

/** Fields and repository routing are operator configuration, never instructions from a record. */
export function airtableRecordToEvent(record, options = {}) {
  const config = { ...DEFAULT_AIRTABLE_MAPPING, ...options };
  if (!record || !record.fields || typeof record.fields !== 'object' || Array.isArray(record.fields)) {
    throw new Error('Invalid Airtable record fields.');
  }
  // Airtable omits false/empty fields. Only an actual checked checkbox starts work.
  if (record.fields[config.readyField] !== true) return null;
  if (typeof record.id !== 'string' || !record.id) throw new Error('Ready Airtable record needs an id.');
  const revision = revisionValue(record.fields[config.revisionField]);
  const identity = JSON.stringify([config.repository, config.sourceKey, record.id, revision]);
  return validateEvent({
    version: 1,
    id: `airtable:${createHash('sha256').update(identity).digest('hex')}`,
    source: 'airtable',
    type: 'ticket.ready',
    repository: config.repository,
    occurredAt: record.createdTime,
    data: {
      title: record.fields[config.titleField],
      body: record.fields[config.bodyField] ?? '',
    },
  });
}

/** Read-only Airtable REST pagination. No token or remote response body appears in errors. */
export async function listAirtableRecords({ token, baseId, tableId, view, fetchImpl = fetch, signal }) {
  if (![token, baseId, tableId].every(value => typeof value === 'string' && value.trim())) {
    throw new Error('AIRTABLE_TOKEN, AIRTABLE_BASE_ID, and AIRTABLE_TABLE_ID are required.');
  }
  const records = [];
  const seen = new Set();
  let offset;
  do {
    const url = new URL(`https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`);
    url.searchParams.set('pageSize', '100');
    if (view) url.searchParams.set('view', view);
    if (offset) url.searchParams.set('offset', offset);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('Airtable request failed; no further pages were fetched.');
    }
    if (!response.ok) throw new Error(`Airtable list request failed with HTTP ${response.status}.`);
    let page;
    try {
      page = await response.json();
    } catch {
      throw new Error('Airtable returned invalid JSON.');
    }
    if (!page || !Array.isArray(page.records) ||
        (page.offset !== undefined && (typeof page.offset !== 'string' || !page.offset))) {
      throw new Error('Airtable returned an invalid records page.');
    }
    records.push(...page.records);
    offset = page.offset;
    if (offset && seen.has(offset)) throw new Error('Airtable returned a repeated pagination offset.');
    if (offset) seen.add(offset);
  } while (offset);
  return records;
}

export async function enqueueAirtableRecords(records, { store, ...mapping }) {
  if (!Array.isArray(records)) throw new Error('Expected an Airtable records array.');
  const result = { records: records.length, ready: 0, enqueued: 0, duplicates: 0 };
  for (const record of records) {
    const event = airtableRecordToEvent(record, mapping);
    if (!event) continue;
    result.ready += 1;
    const accepted = await store.enqueue(event);
    if (accepted.duplicate) result.duplicates += 1;
    else result.enqueued += 1;
  }
  return result;
}
