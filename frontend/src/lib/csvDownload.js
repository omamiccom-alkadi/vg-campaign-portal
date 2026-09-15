/**
 * Browser-side CSV download helpers, shared by the contacts and campaigns
 * importers. Kept out of csvImport.js so that module stays free of DOM access
 * and remains testable in isolation.
 */

export function downloadCsv(filename, csv) {
  // Leading BOM so Excel opens accented names (Marrakech, Karoo) correctly
  // instead of mojibake.
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function safeFilePart(name) {
  return String(name ?? 'import').replace(/[^a-z0-9._-]+/gi, '-').slice(0, 60);
}

export function rawRowPreview(value, limit = 140) {
  const json = JSON.stringify(value ?? {});
  return json.length > limit ? `${json.slice(0, limit)}…` : json;
}
