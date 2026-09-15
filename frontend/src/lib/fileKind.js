import { normalizeHeader } from './csvImport';

/**
 * Which family of source file is this?
 *
 * Each importer is entity-specific, but the four file families overlap —
 * external_id appears in both contacts and campaigns — so "required column
 * missing" is an ambiguous symptom. It can mean a malformed file, or a
 * perfectly good file uploaded on the wrong page. Reporting only the missing
 * column sends someone to inspect their CSV when the fix is to click a
 * different tab.
 *
 * This is advisory only: it decides the WORDING of an error, never where a
 * file gets written. Routing on header shape would mean letting file contents
 * choose an importer, which is the same mistake as routing a row to a brand
 * by its external_id prefix.
 */

// Columns that only appear in one family. external_id, channel, status and
// city are deliberately absent: they are shared, so they carry no signal.
const SIGNATURES = {
  contacts: ['email', 'e_mail', 'consent_marketing', 'brand_code', 'full_name'],
  campaigns: ['campaign_name', 'reported_sent', 'spend', 'parent_campaign_id', 'sent_at_utc'],
  events: ['event_id', 'event_type', 'occurred_at_utc', 'external_contact_id'],
  sends: ['batch_key', 'recipient_count', 'queued_at_utc'],
};

// null would mean the entity is real but has no importer yet, which is a
// different answer from "wrong page" and must not be phrased as one. All four
// now have a page.
const PAGE_FOR_KIND = {
  contacts: 'Contacts',
  campaigns: 'Campaigns',
  events: 'Events',
  sends: 'Sends',
};

const KIND_NOUN = {
  contacts: 'contacts',
  campaigns: 'campaigns',
  events: 'events',
  sends: 'send-log',
};

export function identifyFileKind(fields) {
  const present = new Set((fields ?? []).map(normalizeHeader));

  const ranked = Object.entries(SIGNATURES)
    .map(([kind, columns]) => ({
      kind,
      score: columns.filter((column) => present.has(column)).length,
    }))
    .sort((a, b) => b.score - a.score);

  const [best, runnerUp] = ranked;

  // Two signature columns is the floor for making a claim, and the winner has
  // to beat the runner-up outright. A tie or a single match is a shrug, and
  // guessing out loud there would just replace one misleading message with
  // another.
  if (best.score < 2 || best.score === runnerUp.score) {
    return { kind: null, score: best.score };
  }

  return { kind: best.kind, score: best.score };
}

/**
 * Returns a sentence naming the mismatch, or null when the file is either the
 * expected kind or too unclear to label.
 */
export function describeWrongFile({ fields, expected }) {
  const { kind } = identifyFileKind(fields);
  if (!kind || kind === expected) return null;

  const noun = KIND_NOUN[kind];
  const page = PAGE_FOR_KIND[kind];
  const article = /^[aeiou]/.test(noun) ? 'an' : 'a';

  return page
    ? `This looks like ${article} ${noun} file, not ${KIND_NOUN[expected]}. Import it on the ${page} page instead.`
    : `This looks like ${article} ${noun} file, not ${KIND_NOUN[expected]}. There is no ${noun} importer yet.`;
}
