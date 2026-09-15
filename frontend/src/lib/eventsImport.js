import { normalizeHeader } from './csvImport';
import { checkFileBrand } from './campaignImport';

// Per request to the import-events function.
//
// Was 2000, which the platform killed with reason "EarlyDrop" partway through
// the 312,000-row Kilele file: one invocation had to run two 1000-id lookups
// plus a 2000-row insert, and exceeded the worker's budget. 500 keeps a single
// invocation to one contact lookup, one campaign lookup and one insert, and
// keeps a retry cheap. It costs more round trips, which is the right trade
// when the alternative is losing a five-minute import.
export const EVENTS_BATCH_SIZE = 500;

// Transient failures over ~600 sequential requests are expected. Retrying is
// safe because the insert is ON CONFLICT DO NOTHING, so a batch that partly
// succeeded before dropping re-sends as duplicates rather than doubling up.
export const EVENTS_BATCH_ATTEMPTS = 3;
export const EVENTS_PAGE_SIZE = 25;

export const EVENT_COLUMN_ALIASES = {
  event_id: 'event_id',
  provider_event_id: 'event_id',
  external_contact_id: 'contact_external_id',
  contact_external_id: 'contact_external_id',
  external_id: 'contact_external_id',
  campaign_external_id: 'campaign_external_id',
  campaign_id: 'campaign_external_id',
  event_type: 'event_type',
  type: 'event_type',
  channel: 'channel',
  occurred_at_utc: 'occurred_at',
  occurred_at: 'occurred_at',
  event_timestamp: 'occurred_at',
};

// Mirrors message_events_event_type_check. Two vocabularies coexist by design:
// the historical CSVs and the live dispatcher name the same things differently.
export const HISTORICAL_EVENT_TYPES = ['open', 'click', 'bounce', 'complaint', 'unsubscribe'];
export const LIVE_EVENT_TYPES = ['delivered', 'bounced', 'opened', 'unsubscribed'];
const ALLOWED_EVENT_TYPES = new Set([...HISTORICAL_EVENT_TYPES, ...LIVE_EVENT_TYPES]);

// provider_event_id is `check (length(btrim(provider_event_id)) between 1 and 200)`.
const EVENT_ID_MAX = 200;

// event_timestamp decides ordering and therefore every derived figure, so only
// an explicit offset is accepted. A lenient parse would move engagement
// between days and quietly change the dashboard.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

export const EVENT_REJECTION_LABELS = {
  unreadable_row: 'Row could not be read',
  missing_event_id: 'Missing event ID',
  event_id_too_long: 'Event ID too long',
  contained_control_characters: 'Corrupted characters in the row',
  unknown_event_type: 'Unrecognised event type',
  invalid_occurred_at: 'Unreadable event time',
  missing_references: 'No contact or campaign named',
  conflicting_duplicate_event_id: 'Same event ID, different details',
};

export const EVENT_WARNING_LABELS = {
  duplicate_in_request: 'Repeated event ID',
  unresolved_contact: 'Contact not found in this brand',
  unresolved_campaign: 'Campaign not found in this brand',
};

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function buildEventHeaderMap(fields) {
  const map = {};
  const unmapped = [];
  for (const field of fields ?? []) {
    const internal = EVENT_COLUMN_ALIASES[normalizeHeader(field)];
    if (internal) map[internal] = field;
    else unmapped.push(field);
  }
  return { map, unmapped };
}

/**
 * Which brand does this events file belong to?
 *
 * The events files carry no brand_code, so the campaign id prefix is the only
 * signal — and it matters more here than anywhere else, because event_id and
 * external_contact_id are shared across all three brands. Delegates to the
 * campaigns guard so the rule is defined once: refuse only when recognisable
 * prefixes exist and none belong to the signed-in brand, and never route a row
 * to a brand on the strength of its prefix.
 */
export function checkEventsFileBrand({ events, brandSlug }) {
  return checkFileBrand({
    campaigns: events.map((event) => ({ externalId: event.campaignExternalId ?? '' })),
    brandSlug,
  });
}

/**
 * Validates and shapes rows for the import-events function.
 *
 * Deliberately does NOT resolve external ids to UUIDs. Resolution is scoped by
 * brand_id derived from the caller's session inside the function, because a
 * browser-resolved id would mean trusting the client to decide which brand's
 * contact an event belongs to.
 *
 * @param {Map<number,string>} [parseIssues] row_number -> PapaParse message.
 */
export function mapEventRows({ rows, headerMap, unmapped, brandSlug, parseIssues }) {
  const issues = parseIssues ?? new Map();
  const events = [];
  const errors = [];
  const byCode = new Map();
  const unknownTypes = new Map();
  const channels = new Map();

  // event_id -> [rowNumber, signature]. First occurrence wins, which is only
  // safe while the repeat is identical; a repeat that differs is rejected
  // rather than silently discarded.
  const firstSeen = new Map();
  let duplicatesCollapsed = 0;

  const raw = (row, internal) => {
    const source = headerMap[internal];
    return source ? row[source] : null;
  };

  rows.forEach((row, index) => {
    const rowNumber = index + 2; // 1-indexed, plus the header line.

    const reject = (code, message) => {
      errors.push({ rowNumber, code, message, rawRow: row });
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    };

    const parseIssue = issues.get(rowNumber);
    if (parseIssue) {
      reject('unreadable_row', parseIssue);
      return;
    }

    for (const value of Object.values(row)) {
      if (CONTROL_CHAR_RE.test(String(value ?? ''))) {
        reject(
          'contained_control_characters',
          'the row contains control characters that Postgres cannot store as text'
        );
        return;
      }
    }

    const eventId = text(raw(row, 'event_id'));
    if (!eventId) {
      reject('missing_event_id', 'missing event ID, which is what deduplicates redelivered events');
      return;
    }
    if (eventId.length > EVENT_ID_MAX) {
      reject('event_id_too_long', `event ID is ${eventId.length} characters; the limit is ${EVENT_ID_MAX}`);
      return;
    }

    const eventType = (text(raw(row, 'event_type')) ?? '').toLowerCase();
    if (!ALLOWED_EVENT_TYPES.has(eventType)) {
      unknownTypes.set(eventType, (unknownTypes.get(eventType) ?? 0) + 1);
      reject(
        'unknown_event_type',
        `event type '${eventType}' is not one the schema allows (${[...ALLOWED_EVENT_TYPES].join(', ')})`
      );
      return;
    }

    const occurredAt = text(raw(row, 'occurred_at'));
    if (!occurredAt || !ISO_TIMESTAMP_RE.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
      reject(
        'invalid_occurred_at',
        `'${occurredAt ?? ''}' is not an ISO-8601 timestamp with a timezone, and the event time decides ordering`
      );
      return;
    }

    const contactExternalId = text(raw(row, 'contact_external_id'));
    const campaignExternalId = text(raw(row, 'campaign_external_id'));
    if (!contactExternalId && !campaignExternalId) {
      reject(
        'missing_references',
        'the row names neither a contact nor a campaign, so the event could not be attributed to anything'
      );
      return;
    }

    const channel = text(raw(row, 'channel'));
    channels.set(channel ?? '(blank)', (channels.get(channel ?? '(blank)') ?? 0) + 1);

    // Compared on the fields that carry meaning, so a repeat differing only in
    // column order or whitespace still counts as identical.
    const signature = JSON.stringify([
      contactExternalId,
      campaignExternalId,
      eventType,
      channel,
      occurredAt,
    ]);

    const previous = firstSeen.get(eventId);
    if (previous) {
      if (previous.signature === signature) {
        duplicatesCollapsed += 1;
      } else {
        reject(
          'conflicting_duplicate_event_id',
          `event ID '${eventId}' also appears on row ${previous.rowNumber} with different details, so one of the two is wrong`
        );
      }
      return;
    }
    firstSeen.set(eventId, { rowNumber, signature });

    events.push({
      rowNumber,
      eventId,
      contactExternalId,
      campaignExternalId,
      eventType,
      channel,
      occurredAt,
      rawRow: row,
    });
  });

  const byCount = (a, b) => b.count - a.count;

  return {
    events,
    errors,
    stats: {
      total: rows.length,
      valid: events.length,
      invalid: errors.length,
      duplicatesCollapsed,
      unmapped,
      byCode: Array.from(byCode, ([code, count]) => ({ code, count })).sort(byCount),
      unknownTypes: Array.from(unknownTypes, ([token, count]) => ({ token, count })).sort(byCount),
      channels: Array.from(channels, ([token, count]) => ({ token, count })).sort(byCount),
      brandCheck: checkEventsFileBrand({ events, brandSlug }),
    },
  };
}

/** Rows the function refused, or that never reached it, as CSV. */
export function eventRowsToCsv(rows, labels) {
  const header = ['row_number', 'reason', 'detail', 'raw_row'];
  const body = rows.map((row) => [
    row.rowNumber ?? '',
    labels?.[row.code] ?? row.code ?? '',
    row.message ?? '',
    JSON.stringify(row.rawRow ?? {}),
  ]);
  return [header, ...body];
}

/**
 * The function returns plain messages, but the failure modes worth naming
 * separately are the ones a marketer can act on.
 */
export function humanizeEventsError(status, body) {
  if (status === 401) return 'Your session has expired. Sign in again and retry.';
  if (status === 403) {
    return body?.error ?? 'You do not have permission to import events. Only an owner can.';
  }
  if (status === 413) return 'That upload chunk was too large. This is a bug, not a data problem.';
  if (status === 0) {
    return 'Could not reach the server. Check your connection — already-imported events are kept, so retrying is safe.';
  }
  if (body?.code === '23503') {
    return 'The server refused an event that pointed at another brand\u2019s record. Nothing was imported from this chunk.';
  }
  return body?.error ?? 'Something went wrong storing these events.';
}
