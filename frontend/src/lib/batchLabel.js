// Labels for the import-history <select> on Contacts, Campaigns, Events and
// Sends.
//
// A native select's open option list is drawn by the operating system, outside
// the document, and it sizes itself to the longest option's text. That is why
// neither max-width on the select nor text-overflow on the option bounds it:
// there is no element in the page to constrain. Shortening the text is the only
// thing that reliably keeps the list on a 375px screen.
//
// Nothing is lost by shortening. Each page renders the selected import's full
// detail as ordinary text beside the control, where it can wrap, and carries
// the same string in a title attribute on each option.

const NAME_BUDGET = 18;

// Truncates the middle so the extension survives: a list of ".csv" imports is
// easier to scan than a list of names cut off before it.
export function shortFileName(name, max = NAME_BUDGET) {
  const full = String(name ?? '').trim();
  if (!full) return 'unnamed file';
  if (full.length <= max) return full;

  const dot = full.lastIndexOf('.');
  const hasExt = dot > 0 && full.length - dot <= 6;
  const ext = hasExt ? full.slice(dot) : '';
  const stem = hasExt ? full.slice(0, dot) : full;
  const keep = Math.max(4, max - ext.length - 1);

  return `${stem.slice(0, keep)}\u2026${ext}`;
}

// Day and month only. The year and the clock time are the bulk of a
// toLocaleString() and the least useful part when picking a recent import.
export function shortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function fullDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown date';
  return date.toLocaleString();
}

// Roughly 30 characters for a typical name, against the ~76 the long form
// produced. "rej" is abbreviated because this string sets the popup's width.
export function batchOptionLabel(batch) {
  const rejected = Number(batch?.failed_rows ?? 0);
  return `${shortFileName(batch?.filename)} \u00b7 ${shortDate(batch?.created_at)} \u00b7 ${rejected} rej`;
}
