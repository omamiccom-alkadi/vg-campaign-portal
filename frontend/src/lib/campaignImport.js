import {
  dataRowToRowNumber,
  findControlCharacter,
  formatControlChar,
  humanizeDbError,
  normalizeTimestamp,
} from './csvImport.js';

/**
 * Pure CSV -> campaigns mapping. Same contract as csvImport.js: no Supabase, no
 * React, and every parsed row lands in exactly one of `campaigns` or `errors`.
 *
 * Warnings are a third, non-exclusive list. A warning does not stop a row from
 * importing — it records something the file said that we deliberately did not
 * store, so it is visible rather than silently dropped.
 */

// The three campaigns files hold 46, 19 and 6 rows, so these exist to bound a
// pathological file rather than to page a realistic one.
export const CAMPAIGN_BATCH_SIZE = 200;
export const CAMPAIGNS_PAGE_SIZE = 25;

export const CAMPAIGN_COLUMN_ALIASES = {
  external_id: ['external_id', 'campaign_external_id', 'campaign_id'],
  name: ['campaign_name', 'name', 'campaign'],
  channel: ['channel'],
  target_country: ['target_country'],
  reported_sent: ['reported_sent'],
  reported_delivered: ['reported_delivered'],
  reported_bounced: ['reported_bounced'],
  reported_opens: ['reported_opens'],
  reported_clicks: ['reported_clicks'],
  spend: ['spend'],
  sent_at_utc: ['sent_at_utc'],
  send_local_time: ['send_local_time'],
  parent_campaign_id: ['parent_campaign_id', 'parent_campaign_external_id'],
};

// campaigns.channel is plain text with no CHECK, so an unfamiliar value carries
// no database risk and is stored verbatim. It is surfaced as a warning rather
// than rejected: an unexpected token is not an ambiguous one, and throwing away
// a real campaign over it would lose more than it protects.
export const KNOWN_CHANNELS = ['email', 'sms'];

// campaigns.name is `check (length(btrim(name)) between 1 and 160)`.
const NAME_MAX = 160;

// reported_* are `integer`.
const INT4_MAX = 2147483647;

// External ids are brand-prefixed in all three seed files. Used only to explain
// a parent link we could not resolve — never to route a row to a brand.
const EXTERNAL_ID_PREFIX_TO_BRAND = {
  KIL: 'KILELE',
  KAR: 'KAROO',
  MAR: 'MARRAKECH',
};

export const CAMPAIGN_REJECTION_LABELS = {
  csv_parse_error: 'Line could not be read',
  contained_control_characters: 'Corrupted characters in the row',
  missing_name: 'Missing campaign name',
  name_too_long: 'Campaign name too long',
  missing_external_id: 'Missing campaign ID',
  duplicate_external_id: 'Duplicate campaign ID in this file',
  duplicate_name: 'Duplicate campaign name in this file',
  invalid_count: 'Unreadable reported figure',
  invalid_spend: 'Unreadable spend amount',
  ambiguous_spend: 'Ambiguous spend amount',
  invalid_sent_at: 'Unreadable send date',
};

export const CAMPAIGN_WARNING_LABELS = {
  multiple: 'Several warnings on this row',
  parent_cross_brand: 'Parent campaign belongs to another brand',
  parent_not_found: 'Parent campaign not found',
  parent_self: 'Campaign listed as its own parent',
  unknown_channel: 'Unrecognised channel',
  reported_totals_mismatch: 'Reported figures do not add up',
};

function text(value) {
  const trimmed = String(value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

// Plain digits only. A thousands separator is rejected rather than stripped:
// '1,234' is the same ambiguity as the spend case below, and these feed
// dashboard figures.
const COUNT_RE = /^\d{1,10}$/;

/**
 * reported_* columns. Empty means the file did not say, which is not zero —
 * zero is a claim, NULL is an absence, and the dashboard has to tell them apart.
 */
export function normalizeCount(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return { ok: true, value: null };
  if (!COUNT_RE.test(value)) return { ok: false, token: value, reason: 'format' };
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > INT4_MAX) {
    return { ok: false, token: value, reason: 'range' };
  }
  return { ok: true, value: parsed };
}

// Dot-decimal, at most 2 places: numeric(12,2) holds 10 integer digits + 2.
const SPEND_DOT_RE = /^\d{1,10}(?:\.\d{1,2})?$/;

// Comma-decimal with EXACTLY two places, as written by the fr-FR export in
// marrakech-campaigns.csv ('221,09').
const SPEND_COMMA_RE = /^\d{1,10},\d{2}$/;

/**
 * campaigns.spend is money, so nothing here guesses.
 *
 * '221,09' is unambiguous: a comma followed by exactly two digits is a decimal
 * separator, because no thousands grouping produces a 2-digit final group.
 * '1,234' is genuinely ambiguous — 1234 under fr-FR grouping, 1.234 under a
 * 3dp decimal — and is rejected rather than resolved by assuming the file's
 * locale. parseFloat would return 1 for it, and 221 for '221,09', silently
 * dropping the cents; that is the failure this function exists to prevent.
 */
export function normalizeSpend(raw) {
  const value = String(raw ?? '').trim();
  if (value === '') return { ok: true, value: null };

  if (SPEND_DOT_RE.test(value)) {
    return { ok: true, value: Number(value) };
  }

  if (SPEND_COMMA_RE.test(value)) {
    return { ok: true, value: Number(value.replace(',', '.')), commaDecimal: true };
  }

  // Distinguished from a plain format error so the message can explain the
  // ambiguity instead of just calling the value malformed.
  if (/^\d[\d.,\s]*$/.test(value) && (value.includes(',') || value.includes(' '))) {
    return { ok: false, token: value, reason: 'ambiguous' };
  }

  return { ok: false, token: value, reason: 'format' };
}

/**
 * Describes a parent link we are about to drop, without claiming more than we
 * can prove.
 *
 * RLS makes the cross-brand case unverifiable from the client: a SELECT for
 * another brand's campaign returns nothing, exactly as a typo would. So the
 * brand prefix is reported as an appearance, not a fact.
 */
export function describeUnresolvedParent(parentExternalId, ownCode) {
  const prefix = parentExternalId.split('-')[0]?.toUpperCase() ?? '';
  const prefixBrand = EXTERNAL_ID_PREFIX_TO_BRAND[prefix];

  if (prefixBrand && prefixBrand !== ownCode) {
    return {
      code: 'parent_cross_brand',
      message:
        `parent campaign '${parentExternalId}' appears to belong to ${prefixBrand}, not ${ownCode}. ` +
        'A campaign cannot be linked to another brand\u2019s campaign, so this campaign was imported with no parent.',
    };
  }

  return {
    code: 'parent_not_found',
    message:
      `parent campaign '${parentExternalId}' is not in your brand, so this campaign was imported with no parent. ` +
      'If that campaign is in a file you have not imported yet, re-import this file afterwards to restore the link.',
  };
}

/**
 * Structural brand check for a whole campaigns file.
 *
 * The campaigns CSVs carry no brand_code column, so unlike contacts there is
 * nothing per-row to validate against the signed-in brand. RLS cannot help
 * either: brand_id is derived from the session, so every row of a wrong-brand
 * file is perfectly legitimate to the database and would import silently into
 * the wrong tenant — a quietly wrong result rather than a visible failure.
 *
 * The external_id prefix is the only available signal, and it is used here
 * ONLY to REFUSE a file, never to route a row to a brand. Routing on it would
 * mean letting client input decide tenancy, which is the thing this project
 * forbids outright.
 *
 * Fail-open on absent evidence, fail-closed on contradictory evidence: a file
 * is refused only when it contains recognisable prefixes AND not one of them
 * belongs to the signed-in brand. That keeps karoo-campaigns.csv importable
 * despite its unprefixed CMP-014 row, while stopping a whole foreign file.
 */
export function checkFileBrand({ campaigns, brandSlug }) {
  const ownCode = String(brandSlug ?? '').trim().toUpperCase();
  const knownBrands = new Set(Object.values(EXTERNAL_ID_PREFIX_TO_BRAND));

  // A brand we cannot recognise gives us nothing to compare against, and
  // blocking on a guess would be worse than not checking.
  if (!knownBrands.has(ownCode)) return { ok: true, reason: 'unknown_own_brand' };

  const counts = new Map();
  for (const row of campaigns) {
    const prefix = String(row.externalId ?? '').split('-')[0]?.toUpperCase() ?? '';
    const brand = EXTERNAL_ID_PREFIX_TO_BRAND[prefix];
    if (brand) counts.set(brand, (counts.get(brand) ?? 0) + 1);
  }

  if (counts.size === 0) return { ok: true, reason: 'no_recognisable_prefix' };
  if (counts.has(ownCode)) return { ok: true, reason: 'own_brand_present' };

  const ranked = [...counts].sort((a, b) => b[1] - a[1]);
  return {
    ok: false,
    reason: 'foreign_brand',
    ownCode,
    looksLike: ranked[0][0],
    counts: ranked.map(([brand, count]) => ({ brand, count })),
    matched: ranked.reduce((sum, [, count]) => sum + count, 0),
  };
}

/**
 * @param {Map<number,string>} [parseIssues] row_number -> PapaParse message.
 * @returns {{campaigns: object[], errors: object[], warnings: object[], stats: object}}
 *   Each `campaigns` entry is `{payload, parentExternalId, rowNumber}`.
 *   parentExternalId is deliberately kept outside `payload`: it is a CSV
 *   reference, not a column, and the real parent_campaign_id is a uuid that
 *   cannot be known until every row has been inserted.
 */
export function mapCampaignRows({
  rows,
  headerMap,
  unmapped,
  brandId,
  brandSlug,
  createdBy,
  parseIssues,
}) {
  const campaigns = [];
  const errors = [];
  const warnings = [];
  const issues = parseIssues ?? new Map();

  const externalIdFirstSeen = new Map();
  const nameFirstSeen = new Map();

  const byCode = new Map();
  const unknownChannels = new Map();
  let commaDecimalSpends = 0;

  const has = (field) => Object.prototype.hasOwnProperty.call(headerMap, field);
  const raw = (row, field) => (has(field) ? row[headerMap[field]] : undefined);

  rows.forEach((row, index) => {
    const rowNumber = dataRowToRowNumber(index);
    const reject = (code, message) => {
      errors.push({ rowNumber, rawRow: row, code, message });
      byCode.set(code, (byCode.get(code) ?? 0) + 1);
    };
    const warn = (code, message) => {
      warnings.push({ rowNumber, code, message });
    };

    const parseIssue = issues.get(rowNumber);
    if (parseIssue) {
      reject('csv_parse_error', `this line could not be read: ${parseIssue}`);
      return;
    }

    const control = findControlCharacter(row);
    if (control) {
      const label = formatControlChar(control.code);
      reject(
        'contained_control_characters',
        `column '${control.header}' contains the control character ${label} at position ${control.index + 1}; the value looks corrupted, so the row was not imported`
      );
      return;
    }

    const name = text(raw(row, 'name'));
    if (!name) {
      reject('missing_name', 'missing campaign name');
      return;
    }
    if (name.length > NAME_MAX) {
      reject(
        'name_too_long',
        `campaign name is ${name.length} characters; the limit is ${NAME_MAX}`
      );
      return;
    }

    // Required, unlike on contacts. It is the only key that makes re-importing
    // the same file idempotent, and matching on name instead would merge two
    // genuinely different campaigns that happen to share a title.
    const externalId = text(raw(row, 'external_id'));
    if (!externalId) {
      reject(
        'missing_external_id',
        'missing campaign ID, so this row could not be matched against existing campaigns'
      );
      return;
    }

    const firstIdRow = externalIdFirstSeen.get(externalId);
    if (firstIdRow) {
      reject(
        'duplicate_external_id',
        `campaign ID '${externalId}' also appears on row ${firstIdRow}`
      );
      return;
    }

    // campaigns_brand_name_key is unique on (brand_id, name), so two rows
    // sharing a name would fail the insert and take the whole batch with them.
    const nameKey = name.toLowerCase();
    const firstNameRow = nameFirstSeen.get(nameKey);
    if (firstNameRow) {
      reject(
        'duplicate_name',
        `campaign name '${name}' also appears on row ${firstNameRow}; campaign names must be unique within a brand`
      );
      return;
    }

    const counts = {};
    const countFields = [
      'reported_sent',
      'reported_delivered',
      'reported_bounced',
      'reported_opens',
      'reported_clicks',
    ];
    let countFailed = false;
    for (const field of countFields) {
      const result = normalizeCount(raw(row, field));
      if (!result.ok) {
        reject(
          'invalid_count',
          result.reason === 'range'
            ? `${field} value '${result.token}' is too large`
            : `${field} must be a whole number, got '${result.token}'`
        );
        countFailed = true;
        break;
      }
      counts[field] = result.value;
    }
    if (countFailed) return;

    const spend = normalizeSpend(raw(row, 'spend'));
    if (!spend.ok) {
      if (spend.reason === 'ambiguous') {
        reject(
          'ambiguous_spend',
          `spend '${spend.token}' is ambiguous: a comma or space that is not followed by exactly two digits could be a decimal point or a thousands separator. Because this is a money figure it was not guessed.`
        );
      } else {
        reject('invalid_spend', `spend must be a number, got '${spend.token}'`);
      }
      return;
    }
    if (spend.commaDecimal) commaDecimalSpends += 1;

    // ISO only, and no legacy offset: all three campaigns files write
    // sent_at_utc with an explicit Z.
    const sentAt = normalizeTimestamp(raw(row, 'sent_at_utc'));
    if (!sentAt.ok) {
      reject('invalid_sent_at', `sent_at_utc must be an ISO date, got '${sentAt.token}'`);
      return;
    }

    const channel = text(raw(row, 'channel'));
    if (channel && !KNOWN_CHANNELS.includes(channel.toLowerCase())) {
      const key = channel.toLowerCase();
      unknownChannels.set(key, (unknownChannels.get(key) ?? 0) + 1);
      warn(
        'unknown_channel',
        `channel '${channel}' is not one we recognise (${KNOWN_CHANNELS.join(', ')}). It was stored exactly as written.`
      );
    }

    // Client-reported figures should reconcile as sent = delivered + bounced.
    // Opens and clicks are deliberately excluded: they count events rather than
    // recipients, so opens above delivered is normal, not an error.
    const { reported_sent: rs, reported_delivered: rd, reported_bounced: rb } = counts;
    if (rs !== null && rd !== null && rb !== null && rd + rb !== rs) {
      warn(
        'reported_totals_mismatch',
        `the file reports ${rs} sent but ${rd} delivered + ${rb} bounced = ${rd + rb}. These are the client\u2019s own figures and were stored unchanged.`
      );
    }

    let parentExternalId = text(raw(row, 'parent_campaign_id'));
    if (parentExternalId && parentExternalId === externalId) {
      // campaigns_parent_not_self would reject this outright.
      warn(
        'parent_self',
        `this campaign lists itself as its own parent, which is not possible. It was imported with no parent.`
      );
      parentExternalId = null;
    }

    // Claim both keys only once a row has cleared every other check, so the
    // survivor is whichever row would actually be written. Claiming earlier
    // would let a row rejected for bad spend block a later good row that
    // happens to share its ID.
    externalIdFirstSeen.set(externalId, rowNumber);
    nameFirstSeen.set(name.toLowerCase(), rowNumber);

    campaigns.push({
      rowNumber,
      externalId,
      parentExternalId,
      rawRow: row,
      payload: {
        brand_id: brandId,
        external_id: externalId,
        name,
        channel,
        target_country: text(raw(row, 'target_country')),
        ...counts,
        spend: spend.value,
        sent_at_utc: sentAt.value,
        send_local_time: text(raw(row, 'send_local_time')),
        created_by: createdBy ?? null,
      },
    });
  });

  const byCount = (a, b) => b.count - a.count;

  return {
    campaigns,
    errors,
    warnings,
    stats: {
      total: rows.length,
      valid: campaigns.length,
      invalid: errors.length,
      byCode: Array.from(byCode, ([code, count]) => ({ code, count })).sort(byCount),
      unknownChannels: Array.from(unknownChannels, ([value, count]) => ({ value, count })).sort(
        byCount
      ),
      commaDecimalSpends,
      warnings: warnings.length,
      // Unlike contacts, campaigns has no raw_attrs column, so an unrecognised
      // column genuinely cannot be kept. It is reported rather than written to
      // audience_filter, which means targeting rules and is read by the send
      // flow — parking CSV leftovers there would corrupt a load-bearing column.
      // All three seed files map completely, so this is a guard, not a workaround.
      unmappedColumns: unmapped ?? [],
      // Historical rows arrive already sent. They are inserted as 'draft'
      // because campaigns_insert_own_brand forbids a campaign being born
      // 'sent', then moved to 'sent' by the update pass.
      willBeMarkedSent: campaigns.filter((c) => c.payload.sent_at_utc !== null).length,
      withParent: campaigns.filter((c) => c.parentExternalId !== null).length,
      // File-level verdict. `ok: false` must block the import, not merely warn:
      // there is no per-row brand_code here to catch it later.
      brandCheck: checkFileBrand({ campaigns, brandSlug }),
    },
  };
}

/**
 * Campaign-specific wording for the two codes whose generic contacts message
 * would be actively misleading. Everything else falls through unchanged.
 */
export function humanizeCampaignDbError(error, context) {
  const code = error?.code ?? '';

  if (code === '23505') {
    return 'Some campaigns clash with campaigns that already exist — usually a repeated campaign name. Nothing was saved for this batch.';
  }
  // The composite FK on (parent_campaign_id, brand_id) is the only foreign key
  // an import can realistically trip, and it fires precisely when a parent
  // belongs to another brand.
  if (code === '23503') {
    return 'A campaign referenced a parent campaign that is not in your brand. Nothing was saved for this batch.';
  }

  return humanizeDbError(error, context);
}
