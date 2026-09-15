import { normalizeHeader } from './csvImport';
import { checkFileBrand } from './campaignImport';

// Send logs are tiny compared with events, but the function caps requests at
// 500 and the batching keeps one code path for both.
export const SEND_LOG_BATCH_SIZE = 200;
export const SENDS_PAGE_SIZE = 25;

export const SEND_LOG_COLUMN_ALIASES = {
  batch_key: 'batch_key',
  batch: 'batch_key',
  campaign_external_id: 'campaign_external_id',
  campaign_id: 'campaign_external_id',
  queued_at_utc: 'queued_at',
  queued_at: 'queued_at',
  recipient_count: 'recipient_count',
  recipients: 'recipient_count',
  status: 'status',
};

// A historical send cannot still be in progress. Mirrors the function.
export const HISTORICAL_SEND_STATUSES = ['sent', 'failed', 'canceled'];
export const LIVE_ONLY_SEND_STATUSES = ['pending', 'in_flight'];

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

const INT4_MAX = 2147483647;

export const SEND_LOG_REJECTION_LABELS = {
  unreadable_row: 'Row could not be read',
  missing_batch_key: 'Missing batch key',
  batch_key_too_long: 'Batch key too long',
  contained_control_characters: 'Corrupted characters in the row',
  missing_campaign: 'No campaign named',
  unresolved_campaign: 'Campaign not found in this brand',
  live_status_in_backfill: 'Status describes a send still in progress',
  unknown_status: 'Unrecognised status',
  invalid_queued_at: 'Unreadable queued time',
  invalid_recipient_count: 'Unreadable recipient count',
  recipient_count_too_large: 'Recipient count too large',
  conflicting_duplicate_batch_key: 'Same batch key, different details',
};

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function buildSendLogHeaderMap(fields) {
  const map = {};
  const unmapped = [];
  for (const field of fields ?? []) {
    const internal = SEND_LOG_COLUMN_ALIASES[normalizeHeader(field)];
    if (internal) map[internal] = field;
    else unmapped.push(field);
  }
  return { map, unmapped };
}

export function checkSendLogFileBrand({ sends, brandSlug }) {
  return checkFileBrand({
    campaigns: sends.map((send) => ({ externalId: send.campaignExternalId ?? '' })),
    brandSlug,
  });
}

/**
 * Validates and shapes rows for the import-send-log function.
 *
 * Does not resolve the campaign: that happens server-side against a brand_id
 * derived from the session, because campaign ids are only unique within a
 * brand and this table records money.
 */
export function mapSendLogRows({ rows, headerMap, unmapped, brandSlug, parseIssues }) {
  const issues = parseIssues ?? new Map();
  const sends = [];
  const errors = [];
  const byCode = new Map();

  // batch_key -> { rowNumber, signature }. The seed file repeats a batch_key
  // deliberately; identical repeats collapse, differing ones are rejected
  // rather than resolved by guessing which copy is right.
  const firstSeen = new Map();
  let duplicatesCollapsed = 0;

  const raw = (row, internal) => {
    const source = headerMap[internal];
    return source ? row[source] : null;
  };

  rows.forEach((row, index) => {
    const rowNumber = index + 2;

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

    const batchKey = text(raw(row, 'batch_key'));
    if (!batchKey) {
      reject('missing_batch_key', 'missing batch key, which is what makes re-importing this file safe');
      return;
    }

    const campaignExternalId = text(raw(row, 'campaign_external_id'));
    if (!campaignExternalId) {
      reject('missing_campaign', 'no campaign named, and a send must belong to a campaign');
      return;
    }

    const status = (text(raw(row, 'status')) ?? '').toLowerCase();
    if (LIVE_ONLY_SEND_STATUSES.includes(status)) {
      reject(
        'live_status_in_backfill',
        `status '${status}' describes a send still in progress, which cannot be true of imported history`
      );
      return;
    }
    if (!HISTORICAL_SEND_STATUSES.includes(status)) {
      reject(
        'unknown_status',
        `status '${status}' is not one the schema allows (${HISTORICAL_SEND_STATUSES.join(', ')})`
      );
      return;
    }

    const queuedAt = text(raw(row, 'queued_at'));
    if (!queuedAt || !ISO_TIMESTAMP_RE.test(queuedAt) || Number.isNaN(Date.parse(queuedAt))) {
      reject('invalid_queued_at', `'${queuedAt ?? ''}' is not an ISO-8601 timestamp with a timezone`);
      return;
    }

    const rawCount = text(raw(row, 'recipient_count')) ?? '';
    if (!/^\d+$/.test(rawCount)) {
      reject('invalid_recipient_count', `'${rawCount}' is not a whole number of recipients`);
      return;
    }
    const recipientCount = Number(rawCount);
    if (recipientCount > INT4_MAX) {
      reject('recipient_count_too_large', `${rawCount} exceeds the largest value this column can hold`);
      return;
    }

    const signature = JSON.stringify([campaignExternalId, queuedAt, recipientCount, status]);
    const previous = firstSeen.get(batchKey);
    if (previous) {
      if (previous.signature === signature) {
        duplicatesCollapsed += 1;
      } else {
        reject(
          'conflicting_duplicate_batch_key',
          `batch key '${batchKey}' also appears on row ${previous.rowNumber} with different details, so one of the two is wrong`
        );
      }
      return;
    }
    firstSeen.set(batchKey, { rowNumber, signature });

    sends.push({
      rowNumber,
      batchKey,
      campaignExternalId,
      queuedAt,
      recipientCount,
      status,
      rawRow: row,
    });
  });

  const byCount = (a, b) => b.count - a.count;

  return {
    sends,
    errors,
    stats: {
      total: rows.length,
      valid: sends.length,
      invalid: errors.length,
      duplicatesCollapsed,
      unmapped,
      totalRecipients: sends.reduce((sum, send) => sum + send.recipientCount, 0),
      byCode: Array.from(byCode, ([code, count]) => ({ code, count })).sort(byCount),
      brandCheck: checkSendLogFileBrand({ sends, brandSlug }),
    },
  };
}

export function humanizeSendLogError(status, body) {
  if (status === 401) return 'Your session has expired. Sign in again and retry.';
  if (status === 403) {
    return body?.error ?? 'You do not have permission to import a send log. Only an owner can.';
  }
  if (status === 0) {
    return 'Could not reach the server. Check your connection — sends already imported are kept, so retrying is safe.';
  }
  if (body?.code === '23505') {
    return 'The database refused a send that duplicates one already recorded. Nothing was imported from this chunk.';
  }
  if (body?.code === '23514' || String(body?.detail ?? '').includes('frozen')) {
    return 'The database refused a send because its recipient figures could not be stored as given. Nothing was imported from this chunk.';
  }
  return body?.error ?? 'Something went wrong storing these sends.';
}
