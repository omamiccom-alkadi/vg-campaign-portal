import Papa from 'papaparse';

/**
 * Pure CSV -> contacts mapping. No Supabase, no React: this module is the part
 * that decides what a row *means*, so it stays independently testable.
 *
 * Nothing here writes to the database. Callers get two disjoint lists back —
 * rows safe to upsert, and rows rejected with a reason — and the two together
 * always account for every parsed row.
 */

// Must stay identical to the CHECK on contacts.email in the initial migration:
//   check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$')
// If this is looser than the DB, a bad address takes down the whole 500-row
// batch with a check violation instead of landing in import_errors.
export const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const CONTACT_BATCH_SIZE = 500;
export const CONTACTS_PAGE_SIZE = 25;

// brand_code is not a contacts column. It is read only to validate the row
// against the signed-in user's own brand, never to route the row anywhere.
export const KNOWN_BRAND_CODES = ['KILELE', 'KAROO', 'MARRAKECH'];

export const COLUMN_ALIASES = {
  full_name: ['full_name', 'name'],
  email: ['email', 'e_mail'],
  phone: ['phone', 'mobile'],
  country: ['country', 'pays'],
  city: ['city'],
  external_id: ['external_id'],
  signup_at: ['signup_at', 'signup_date'],
  status: ['status'],
  consent_marketing: ['consent_marketing'],
  deleted_at: ['deleted_at'],
  suppressed_until: ['suppressed_until'],
  notes: ['notes'],
  brand_code: ['brand_code'],
};

// 't'/'f' are Postgres's own canonical boolean literals and appear in the real
// files. Everything outside these two lists is still an error, never a default.
const CONSENT_TRUE = ['1', 'true', 't', 'y', 'yes'];
const CONSENT_FALSE = ['0', 'false', 'f', 'n', 'no', ''];

// Control characters below 0x20, except the three that are structurally part of
// CSV rather than field content (tab, LF, CR). Postgres rejects these in text
// AND in jsonb — '\u0000 cannot be converted to text' (SQLSTATE 22P05) — so an
// unchecked one fails the entire 500-row batch, not just its own row.
const CONTROL_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/;

// The ones that actually turn up in legacy CRM exports, named so the message is
// readable. Anything else is reported by code point alone.
const CONTROL_CHAR_NAMES = {
  0x00: 'NUL',
  0x01: 'SOH',
  0x02: 'STX',
  0x03: 'ETX',
  0x04: 'EOT',
  0x07: 'BEL',
  0x08: 'BS',
  0x0b: 'VT',
  0x0c: 'FF',
  0x1a: 'SUB',
  0x1b: 'ESC',
};

// Timestamp columns accept ISO-8601, plus one explicitly-parsed legacy shape
// (see LEGACY_DMY_TIMESTAMP_RE). A value is never simply handed to new Date(),
// which interprets '06/02/2026' as 6 February or 2 June depending on locale
// rules: signup_at feeds a per-day dashboard chart, so a guess there moves
// signups between days and presents the result as fact. The legacy shape is
// read day-first because the data proves that ordering, not because a locale
// was assumed.
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

// One legacy export shape is accepted alongside ISO: 'DD/MM/YYYY HH:MM'.
// Read day-first, never month-first. That is established by the data, not
// assumed — of the 1,200 affected rows in kilele-contacts.csv, 748 carry a
// first component above 12, and not one carries a second component above 12.
const LEGACY_DMY_TIMESTAMP_RE =
  /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

// TIMEZONE ASSUMPTION — INFERRED, NOT CONFIRMED BY THE DATA.
//
// Legacy rows carry a bare wall-clock time with no zone marker, unlike every
// ISO row in the same files, which all end in Z. Nothing in the CSV states
// which zone the legacy values were recorded in. Kilele is Kenya-based and all
// affected rows came from a single February export, so reading them as
// Africa/Nairobi is the reasonable inference — but it remains an inference.
// If signup timestamps ever look shifted by a few hours, this is the line to
// revisit. The offset is exact rather than approximate: Kenya has never
// observed DST, so EAT is UTC+3 year-round.
//
// Fail-closed for every other brand. Karoo and Marrakech files are ISO
// throughout, so there is no observed local-time data to infer a zone from,
// and Morocco in particular is not a fixed offset (Casablanca drops to UTC+0
// for Ramadan). A legacy-shaped value under those brands is rejected as a
// format error rather than converted using a guessed offset.
const LEGACY_LOCAL_OFFSET_HOURS = {
  KILELE: 3,
};

/**
 * Returns an ISO string, or null when the value is not a well-formed
 * day-first legacy timestamp.
 */
function parseLegacyDayFirst(value, offsetHours) {
  const match = LEGACY_DMY_TIMESTAMP_RE.exec(value);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;

  // Date.UTC rolls overflow silently forward, turning 31/02 into 3 March. Check
  // the calendar date survives a round trip before trusting it.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;

  // Subtracting the offset inside Date.UTC handles the day rollover that a
  // pre-03:00 local time produces.
  const parsed = new Date(Date.UTC(year, month - 1, day, hour - offsetHours, minute, second));
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// contacts has no `status` column. Everything except 'active' collapses to
// is_subscribed=false, so the original token is also preserved in
// raw_attrs.source_status — otherwise the reason a contact is unsubscribed is
// destroyed at import time and unrecoverable.
//
// 'pending' is double opt-in awaiting confirmation: not yet confirmed, so not
// yet contactable, matching the fail-closed stance of is_contactable.
const STATUS_SUBSCRIBED = {
  active: true,
  bounced: false,
  unsubscribed: false,
  inactive: false,
  pending: false,
};

export const KNOWN_STATUS_VALUES = Object.keys(STATUS_SUBSCRIBED);

/** Human labels for rejection codes, for the preview breakdown. */
// Warnings describe rows that DID import. They share import_errors with
// rejections, told apart by this prefix, and are excluded from failed_rows.
export const WARNING_CODE_PREFIX = 'warning_';

export const CONTACT_WARNING_LABELS = {
  external_id_collision_dropped: 'external_id already used by another contact',
};

export const REJECTION_LABELS = {
  csv_parse_error: 'Line could not be read',
  missing_email: 'Missing email',
  invalid_email: 'Invalid email format',
  unrecognized_brand_code: 'Unrecognised brand_code',
  brand_mismatch: 'brand_code belongs to another brand',
  invalid_consent_marketing: 'Unrecognised consent_marketing value',
  invalid_status: 'Unrecognised status value',
  invalid_suppressed_until: 'Unreadable suppressed_until date',
  invalid_deleted_at: 'Unreadable deleted_at date',
  invalid_signup_at: 'Unreadable signup_at date',
  duplicate_external_id: 'Duplicate external_id',
  contained_control_characters: 'Contained control characters',
};

export function formatControlChar(code) {
  const hex = `U+${code.toString(16).toUpperCase().padStart(4, '0')}`;
  return CONTROL_CHAR_NAMES[code] ? `${hex} (${CONTROL_CHAR_NAMES[code]})` : hex;
}

const CONTROL_CHAR_GLOBAL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function controlCharPlaceholder(code) {
  const name = CONTROL_CHAR_NAMES[code];
  return name ? `<${name}>` : `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * Makes a rejected row storable and readable for human review.
 *
 * Sanitising is correct HERE and wrong for contacts: import_errors.raw_row is a
 * diagnostic copy, not the authoritative customer record. jsonb rejects these
 * bytes exactly as text does, so without this the error log cannot record the
 * very rows it exists to report. The offending byte is replaced by a visible
 * marker (<NUL>, <SUB>, <U+0010>) so a reviewer sees that something was there
 * and what it was, rather than a silently shortened value.
 *
 * Keys are sanitised too — a corrupted CSV header would otherwise break the
 * write just as a corrupted value does.
 */
export function sanitizeForDiagnostics(value) {
  if (typeof value === 'string') {
    return value.replace(CONTROL_CHAR_GLOBAL_RE, (ch) =>
      controlCharPlaceholder(ch.codePointAt(0))
    );
  }
  if (Array.isArray(value)) return value.map(sanitizeForDiagnostics);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[sanitizeForDiagnostics(key)] = sanitizeForDiagnostics(val);
    }
    return out;
  }
  return value;
}

/**
 * First control character anywhere in the row, with the column it came from.
 *
 * Scans every column, not just the mapped ones: an unmapped column still gets
 * persisted into raw_attrs, and jsonb rejects these bytes exactly as text does.
 * PapaParse preserves header order, so the reported column is deterministic.
 *
 * @returns {{header: string, code: number, index: number}|null}
 */
export function findControlCharacter(row) {
  for (const [header, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    const match = CONTROL_CHAR_RE.exec(value);
    if (match) {
      return { header, code: match[0].codePointAt(0), index: match.index };
    }
  }
  return null;
}

/** "Full Name" -> "full_name", " E_Mail " -> "e_mail". */
export function normalizeHeader(header) {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

/**
 * Resolves PapaParse's `meta.fields` to canonical names.
 * Returns the original header string per canonical field (PapaParse keys each
 * row by the original header, not the normalized one), plus every header that
 * matched no alias — those go to raw_attrs rather than being dropped.
 */
export function buildHeaderMap(fields, aliases = COLUMN_ALIASES) {
  const map = {};
  const unmapped = [];
  const claimed = new Set();

  for (const original of fields ?? []) {
    const normalized = normalizeHeader(original);
    const canonical = Object.keys(aliases).find(
      (key) => aliases[key].includes(normalized) && !claimed.has(key)
    );

    if (canonical) {
      map[canonical] = original;
      claimed.add(canonical);
    } else {
      unmapped.push(original);
    }
  }

  return { map, unmapped };
}

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

export function normalizeConsent(raw) {
  const token = String(raw ?? '').trim().toLowerCase();
  if (CONSENT_TRUE.includes(token)) return { ok: true, value: true };
  if (CONSENT_FALSE.includes(token)) return { ok: true, value: false };
  return { ok: false, token: String(raw ?? '').trim() };
}

export function normalizeStatus(raw) {
  const token = String(raw ?? '').trim().toLowerCase();
  // Blank is "not stated", not "unsubscribe them". Falls back to the column's
  // own default (true) rather than guessing a suppression the file never said.
  if (token === '') return { ok: true, value: true, token: '' };
  if (token in STATUS_SUBSCRIBED) return { ok: true, value: STATUS_SUBSCRIBED[token], token };
  return { ok: false, token: String(raw ?? '').trim() };
}

/**
 * Timestamps go to timestamptz columns. Rejected here rather than handed to
 * Postgres, where a bad value would fail the entire batch.
 *
 * @param {number} [legacyOffsetHours] when supplied, 'DD/MM/YYYY HH:MM' is also
 *   accepted and converted from that UTC offset. Omitted means ISO-only.
 * @returns {{ok: boolean, value?: string|null, legacy?: boolean, token?: string, reason?: string}}
 */
export function normalizeTimestamp(raw, legacyOffsetHours) {
  const value = String(raw ?? '').trim();
  if (value === '') return { ok: true, value: null };

  if (ISO_TIMESTAMP_RE.test(value)) {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return { ok: false, token: value, reason: 'invalid' };
    return { ok: true, value: parsed.toISOString() };
  }

  if (typeof legacyOffsetHours === 'number' && LEGACY_DMY_TIMESTAMP_RE.test(value)) {
    const iso = parseLegacyDayFirst(value, legacyOffsetHours);
    // Shape matched but the calendar did not, e.g. 31/02/2026. That is a
    // corrupt value, not an unsupported format.
    if (!iso) return { ok: false, token: value, reason: 'invalid' };
    return { ok: true, value: iso, legacy: true };
  }

  return { ok: false, token: value, reason: 'format' };
}

function timestampErrorMessage(column, result) {
  return result.reason === 'format'
    ? `${column} must be an ISO date like 2026-02-06 or 2026-02-06T15:39:07Z, got '${result.token}'`
    : `unreadable ${column} date: '${result.token}'`;
}

export function chunk(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Collapses repeats of the same email inside one batch, last occurrence winning.
 *
 * Required, not an optimisation: a single INSERT ... ON CONFLICT DO UPDATE
 * cannot touch the same conflict target twice ("command cannot affect row a
 * second time"). The key is lowercased because contacts.email is citext, so
 * 'A@x.com' and 'a@x.com' are the same row to the DB but different JS strings.
 */
export function dedupeBatchByEmail(rows) {
  const byEmail = new Map();
  for (const row of rows) byEmail.set(String(row.email).toLowerCase(), row);
  return { rows: Array.from(byEmail.values()), collapsed: rows.length - byEmail.size };
}

/**
 * row_number semantics: the header is row 1, so the first data row is 2 —
 * matching what a spreadsheet shows. skipEmptyLines means blank lines are not
 * counted, so in a file containing blank lines this can sit above the physical
 * line number. Surfaced in the UI rather than left for someone to discover.
 *
 * Exported because PapaParse reports its own errors by data-row index, and both
 * numbers have to land in the same coordinate system.
 */
export function dataRowToRowNumber(index) {
  return index + 2;
}

/**
 * @param {Map<number,string>} [parseIssues] row_number -> PapaParse message, for
 *   lines the CSV reader itself could not read. Such a line is rejected outright
 *   and never becomes a contact: without this it could pass validation, get
 *   upserted, AND be recorded as a failure — counted twice, imported once.
 * @returns {{contacts: object[], errors: object[], stats: object}}
 * Every input row appears in exactly one of `contacts` or `errors`, so
 * stats.valid + stats.invalid always equals stats.total.
 */
export function mapRows({ rows, headerMap, unmapped, brandId, brandSlug, parseIssues }) {
  const contacts = [];
  // Aligned with `contacts` by index. Kept alongside rather than inside the
  // row objects because every key in a contact object is sent to PostgREST as
  // a column, and row_number is not one.
  const contactRowNumbers = [];
  const errors = [];
  const externalIdFirstSeen = new Map();
  const ownCode = String(brandSlug ?? '').trim().toUpperCase();
  // undefined for brands with no observed legacy data, which keeps those files
  // ISO-only. See LEGACY_LOCAL_OFFSET_HOURS.
  const legacyOffset = LEGACY_LOCAL_OFFSET_HOURS[ownCode];
  const issues = parseIssues ?? new Map();
  // Converted from local wall-clock rather than read from an explicit zone, so
  // the count is surfaced instead of the conversion happening silently.
  let legacyTimestamps = 0;
  // Aggregates, so a systematic cause (one unknown status across 9,000 rows)
  // reads as a pattern instead of having to be found by searching individual
  // rejection reasons.
  const byCode = new Map();
  const unknownStatuses = new Map();
  const controlCharColumns = new Map();
  const controlCharRows = [];
  const has = (field) => Object.prototype.hasOwnProperty.call(headerMap, field);
  const raw = (row, field) => (has(field) ? row[headerMap[field]] : undefined);

  rows.forEach((row, index) => {
    const rowNumber = dataRowToRowNumber(index);
    const reject = (code, message) => {
      errors.push({ rowNumber, rawRow: row, code, message });
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    };

    const parseIssue = issues.get(rowNumber);
    if (parseIssue) {
      reject('csv_parse_error', `this line could not be read: ${parseIssue}`);
      return;
    }

    // Rejected, never stripped. A row carrying corrupted bytes is suspect data,
    // not a formatting nuisance — the same stance taken on ambiguous dates.
    // Cleaning is especially wrong for external_id: it is half of the unique
    // (brand_id, external_id) index, so two values that differ only by a
    // control character would silently become one contact after stripping.
    const control = findControlCharacter(row);
    if (control) {
      const label = formatControlChar(control.code);
      controlCharColumns.set(
        `${control.header} ${label}`,
        (controlCharColumns.get(`${control.header} ${label}`) ?? 0) + 1
      );
      controlCharRows.push(rowNumber);
      reject(
        'contained_control_characters',
        `column '${control.header}' contains the control character ${label} at position ${control.index + 1}; the value looks corrupted, so the row was not imported`
      );
      return;
    }

    const email = text(raw(row, 'email'));
    if (!email) {
      reject('missing_email', 'missing email');
      return;
    }
    if (!EMAIL_RE.test(email)) {
      reject('invalid_email', `invalid email format: '${email}'`);
      return;
    }

    if (has('brand_code')) {
      const code = String(raw(row, 'brand_code') ?? '').trim().toUpperCase();
      if (code !== '') {
        if (!KNOWN_BRAND_CODES.includes(code)) {
          reject('unrecognized_brand_code', `unrecognized brand_code: '${code}'`);
          return;
        }
        if (code !== ownCode) {
          reject(
            'brand_mismatch',
            `brand_code ${code} does not match your brand ${brandSlug}`
          );
          return;
        }
      }
    }

    let consent = false;
    if (has('consent_marketing')) {
      const result = normalizeConsent(raw(row, 'consent_marketing'));
      if (!result.ok) {
        reject(
          'invalid_consent_marketing',
          `invalid consent_marketing value: '${result.token}'`
        );
        return;
      }
      consent = result.value;
    }

    let isSubscribed = true;
    let sourceStatus = null;
    if (has('status')) {
      const result = normalizeStatus(raw(row, 'status'));
      if (!result.ok) {
        const key = result.token.toLowerCase();
        unknownStatuses.set(key, (unknownStatuses.get(key) ?? 0) + 1);
        reject('invalid_status', `unrecognized status value: '${result.token}'`);
        return;
      }
      isSubscribed = result.value;
      sourceStatus = result.token === '' ? null : result.token;
    }

    const suppressedUntil = normalizeTimestamp(raw(row, 'suppressed_until'), legacyOffset);
    if (!suppressedUntil.ok) {
      reject('invalid_suppressed_until', timestampErrorMessage('suppressed_until', suppressedUntil));
      return;
    }

    const deletedAt = normalizeTimestamp(raw(row, 'deleted_at'), legacyOffset);
    if (!deletedAt.ok) {
      reject('invalid_deleted_at', timestampErrorMessage('deleted_at', deletedAt));
      return;
    }

    // Real column as of 20260915080800, no longer a raw_attrs passenger.
    const signupAt = normalizeTimestamp(raw(row, 'signup_at'), legacyOffset);
    if (!signupAt.ok) {
      reject('invalid_signup_at', timestampErrorMessage('signup_at', signupAt));
      return;
    }

    if (suppressedUntil.legacy || deletedAt.legacy || signupAt.legacy) legacyTimestamps += 1;

    // '' must become NULL: contacts_brand_external_id_idx is unique on
    // (brand_id, external_id) WHERE external_id is not null, so a file full of
    // blank external_ids would collide on the empty string.
    const externalId = text(raw(row, 'external_id'));
    if (externalId) {
      const firstRow = externalIdFirstSeen.get(externalId);
      if (firstRow) {
        reject(
          'duplicate_external_id',
          `external_id '${externalId}' also appears on row ${firstRow}; only one contact per external_id is allowed`
        );
        return;
      }
      externalIdFirstSeen.set(externalId, rowNumber);
    }

    // Everything the alias table did not claim, verbatim. Plus the three values
    // that have no column of their own, so nothing the file said is lost.
    const rawAttrs = {};
    for (const header of unmapped) rawAttrs[header] = row[header] ?? null;
    if (sourceStatus) rawAttrs.source_status = sourceStatus;
    if (has('brand_code')) {
      const code = text(raw(row, 'brand_code'));
      if (code) rawAttrs.brand_code = code;
    }

    // Fixed key set on every row: PostgREST rejects an upsert whose objects do
    // not all share the same keys.
    contacts.push({
      brand_id: brandId,
      email,
      full_name: text(raw(row, 'full_name')),
      phone: text(raw(row, 'phone')),
      country: text(raw(row, 'country')),
      city: text(raw(row, 'city')),
      external_id: externalId,
      consent_marketing: consent,
      is_subscribed: isSubscribed,
      signup_at: signupAt.value,
      suppressed_until: suppressedUntil.value,
      deleted_at: deletedAt.value,
      notes: text(raw(row, 'notes')),
      raw_attrs: rawAttrs,
    });
    contactRowNumbers.push(rowNumber);
  });

  const byCount = (a, b) => b.count - a.count;
  const unknownStatusList = Array.from(unknownStatuses, ([value, count]) => ({
    value,
    count,
  })).sort(byCount);

  const controlCharList = Array.from(controlCharColumns, ([value, count]) => ({
    value,
    count,
  })).sort(byCount);

  if (unknownStatusList.length > 0 && import.meta.env.DEV) {
    const total = unknownStatusList.reduce((sum, s) => sum + s.count, 0);
    // eslint-disable-next-line no-console
    console.warn(
      `[import] ${total} rows rejected due to unrecognized status values: ` +
        unknownStatusList.map((s) => `'${s.value}' (${s.count})`).join(', ') +
        `. Known values: ${KNOWN_STATUS_VALUES.join(', ')}.`
    );
  }

  if (legacyTimestamps > 0 && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[import] ${legacyTimestamps} rows had DD/MM/YYYY timestamps with no timezone, ` +
        `read day-first and converted from UTC+${legacyOffset} to UTC. ` +
        'That offset is an inference from the brand location, not stated by the file.'
    );
  }

  if (controlCharRows.length > 0 && import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.warn(
      `[import] ${controlCharRows.length} rows rejected for control characters: ` +
        controlCharList.map((c) => `${c.value} x${c.count}`).join(', ') +
        `. Row numbers: ${controlCharRows.slice(0, 50).join(', ')}` +
        (controlCharRows.length > 50 ? `, … (${controlCharRows.length - 50} more)` : '')
    );
  }

  return {
    contacts,
    contactRowNumbers,
    errors,
    stats: {
      total: rows.length,
      valid: contacts.length,
      invalid: errors.length,
      byCode: Array.from(byCode, ([code, count]) => ({ code, count })).sort(byCount),
      unknownStatuses: unknownStatusList,
      controlChars: controlCharList,
      controlCharRows,
      legacyTimestamps,
      legacyOffsetHours: legacyOffset ?? null,
    },
  };
}

/**
 * Rejected rows -> CSV text, for a marketer to hand to whoever owns the source
 * data. Callers pass one normalised shape regardless of whether the rows came
 * from client-side parsing or from a historical import_errors query.
 *
 * @param {{rowNumber: number, reason: string, rawRow: object}[]} rows
 */
/**
 * Drops an external_id that another contact in this brand already owns.
 *
 * The upsert conflicts on (brand_id, email), so a row whose email is new gets
 * INSERTed — and then tries to claim an external_id belonging to a different
 * contact, which contacts_brand_external_id_idx refuses with 23505 and takes
 * the whole batch down with it.
 *
 * Verified against kilele-contacts-delta-2026-09-01.csv, where 2,394 rows reuse
 * ids from the main export while carrying entirely different names, phones,
 * cities and signup dates: not one shares a phone or a full name with the
 * contact already holding the id. They are a reused id block, not corrections,
 * so the contact is kept and only the disputed id is released.
 *
 * NULL is safe to write as many times as needed: the unique index is partial
 * (WHERE external_id IS NOT NULL), so NULL rows are not in the index at all.
 *
 * The original value is not discarded. It is preserved on the contact itself in
 * raw_attrs.collided_external_id, so it stays queryable after the import log
 * has scrolled away.
 *
 * @param {object[]} contacts        from mapRows, mutated in place
 * @param {number[]} rowNumbers      mapRows' contactRowNumbers, aligned by index
 * @param {Map<string,string>} owners external_id -> email of the contact that
 *   already holds it, lowercased
 * @returns {{collisions: object[]}}
 */
export function resolveExternalIdCollisions({ contacts, rowNumbers, owners }) {
  const collisions = [];

  contacts.forEach((contact, index) => {
    if (!contact.external_id) return;

    const ownerEmail = owners.get(contact.external_id);
    // Absent means the id is free. Equal means this row IS that contact, so the
    // upsert updates it in place and there is nothing to resolve.
    if (!ownerEmail || ownerEmail === String(contact.email).toLowerCase()) return;

    const released = contact.external_id;
    contact.external_id = null;
    contact.raw_attrs = { ...contact.raw_attrs, collided_external_id: released };

    collisions.push({
      rowNumber: rowNumbers?.[index] ?? null,
      email: contact.email,
      externalId: released,
      ownerEmail,
    });
  });

  return { collisions };
}

export function rejectedRowsToCsv(rows) {
  return Papa.unparse(
    rows.map((row) => ({
      row_number: row.rowNumber,
      reason: row.reason,
      raw_row: JSON.stringify(row.rawRow ?? {}),
    })),
    { columns: ['row_number', 'reason', 'raw_row'] }
  );
}

/**
 * Supabase/Postgres errors never reach the screen raw. The original is logged
 * for whoever is debugging; the user gets a sentence.
 */
export function humanizeDbError(error, context) {
  if (import.meta.env.DEV) {
    // eslint-disable-next-line no-console
    console.error(`[import] ${context}`, error);
  }

  const code = error?.code ?? '';

  if (code === '42501' || code === 'PGRST301') {
    return 'You do not have permission to do that. Try signing out and back in.';
  }
  // Raised when the database has not caught up with the code — most likely the
  // signup_at migration has not been applied to this project yet.
  if (code === 'PGRST204' || code === '42703') {
    return 'This database is missing a field the importer expects. A pending database update needs to be applied first.';
  }
  if (code === '23505') {
    return 'Some rows clash with contacts that already exist. Nothing was saved for this batch.';
  }
  if (code === '23514') {
    return 'Some rows were rejected by a data rule in the database. Nothing was saved for this batch.';
  }
  if (code === '23503') {
    return 'This import could not be linked to your brand. Nothing was saved.';
  }
  if (code === '21000' || code === '42P10') {
    return 'The import hit a duplicate-row conflict. Nothing was saved for this batch.';
  }
  if (error?.message && /fetch|network|failed to fetch/i.test(error.message)) {
    return 'We could not reach the server. Check your connection and try again.';
  }
  return 'Something went wrong while saving. Nothing was saved for this batch.';
}
