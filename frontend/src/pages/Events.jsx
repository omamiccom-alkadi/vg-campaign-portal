import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import BackToDashboard from '../components/BackToDashboard';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { chunk, dataRowToRowNumber, sanitizeForDiagnostics } from '../lib/csvImport';
import {
  EVENTS_BATCH_ATTEMPTS,
  EVENTS_BATCH_SIZE,
  EVENTS_PAGE_SIZE,
  EVENT_REJECTION_LABELS,
  EVENT_WARNING_LABELS,
  buildEventHeaderMap,
  humanizeEventsError,
  mapEventRows,
} from '../lib/eventsImport';
import { downloadCsv, rawRowPreview, safeFilePart } from '../lib/csvDownload';
import { describeWrongFile } from '../lib/fileKind';

const HISTORY_PAGE_SIZE = 25;
const BATCH_LIST_LIMIT = 50;
const REJECTED_PREVIEW_PAGE = 25;

// Same convention as the campaigns importer: warnings describe rows that DID
// import and are therefore excluded from failed_rows.
const WARNING_CODE_PREFIX = 'warning_';
const isWarningCode = (code) => String(code ?? '').startsWith(WARNING_CODE_PREFIX);

function labelForCode(code) {
  if (isWarningCode(code)) {
    const bare = String(code).slice(WARNING_CODE_PREFIX.length);
    return EVENT_WARNING_LABELS[bare] ?? bare;
  }
  return EVENT_REJECTION_LABELS[code] ?? code;
}

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n ?? 0);

export default function Events() {
  const { profile, user } = useAuth();

  const [phase, setPhase] = useState('idle');
  const [fileMeta, setFileMeta] = useState(null);
  const [fileError, setFileError] = useState('');
  const [parsed, setParsed] = useState(null);
  const [showRejected, setShowRejected] = useState(false);
  const [rejectedPage, setRejectedPage] = useState(0);

  // Tracked per batch rather than as one opaque percentage: on a file needing
  // ~600 round trips, "batch 45 of 608" is the difference between knowing where
  // an interruption happened and inferring it from a stored count afterwards.
  const [progress, setProgress] = useState({
    label: '',
    batch: 0,
    batches: 0,
    rows: 0,
    stored: 0,
    skipped: 0,
    retrying: '',
  });
  const [importError, setImportError] = useState('');
  const [result, setResult] = useState(null);

  const [events, setEvents] = useState([]);
  const [eventCount, setEventCount] = useState(0);
  const [page, setPage] = useState(0);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);

  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState('');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);

  const fileInputRef = useRef(null);

  const loadEvents = useCallback(
    async (targetPage) => {
      if (!profile?.brand_id) return;
      setListLoading(true);
      setListError('');
      const from = targetPage * EVENTS_PAGE_SIZE;

      const { data, error, count } = await supabase
        .from('message_events')
        .select('id, provider_event_id, event_type, event_timestamp, contact_id, campaign_id, payload', {
          count: 'exact',
        })
        .eq('brand_id', profile.brand_id)
        // event_timestamp, never received_at: arrival order is not chronological.
        .order('event_timestamp', { ascending: false })
        .order('id', { ascending: true })
        .range(from, from + EVENTS_PAGE_SIZE - 1);

      if (error) {
        // 42703/PGRST204 here means the column list names something the
        // database does not have â€” in practice campaign_id or source_batch_id,
        // i.e. 20260915170000 has not reached this environment. Saying that is
        // the difference between a five-second fix and a hunt.
        setListError(
          error.code === '42703' || error.code === 'PGRST204'
            ? 'This page needs a database update that has not been applied yet ' +
                '(message_events.campaign_id). Run the pending migration, then reload.'
            : 'Could not load events. Try reloading the page.'
        );
        setEvents([]);
      } else {
        setEvents(data ?? []);
        setEventCount(count ?? 0);
      }
      setListLoading(false);
    },
    [profile?.brand_id]
  );

  const loadBatches = useCallback(async () => {
    if (!profile?.brand_id) return;
    const { data, error } = await supabase
      .from('import_batches')
      .select('id, filename, status, total_rows, inserted_rows, failed_rows, created_at')
      .eq('brand_id', profile.brand_id)
      // An import_errors row only means something alongside its batch entity.
      .eq('entity', 'events')
      .order('created_at', { ascending: false })
      .limit(BATCH_LIST_LIMIT);
    if (!error) setBatches(data ?? []);
  }, [profile?.brand_id]);

  const loadHistoryErrors = useCallback(
    async (batchId, targetPage) => {
      if (!profile?.brand_id || !batchId) return;
      setHistoryLoading(true);
      setHistoryError('');
      const from = targetPage * HISTORY_PAGE_SIZE;

      const { data, error, count } = await supabase
        .from('import_errors')
        .select('row_number, error_code, error_message, raw_row', { count: 'exact' })
        .eq('brand_id', profile.brand_id)
        .eq('batch_id', batchId)
        .order('row_number', { ascending: true })
        .range(from, from + HISTORY_PAGE_SIZE - 1);

      if (error) {
        setHistoryError('Could not load the rows from that import.');
        setHistoryRows([]);
      } else {
        setHistoryRows(data ?? []);
        setHistoryCount(count ?? 0);
      }
      setHistoryLoading(false);
    },
    [profile?.brand_id]
  );

  useEffect(() => {
    void loadEvents(page);
  }, [loadEvents, page]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    if (selectedBatch) void loadHistoryErrors(selectedBatch, historyPage);
  }, [selectedBatch, historyPage, loadHistoryErrors]);

  function resetImport() {
    setPhase('idle');
    setFileMeta(null);
    setFileError('');
    setParsed(null);
    setShowRejected(false);
    setRejectedPage(0);
    setProgress({ label: '', batch: 0, batches: 0, rows: 0, stored: 0, skipped: 0, retrying: '' });
    setImportError('');
    setResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  function handleFile(file) {
    if (!file) return;
    resetImport();

    if (!/\.csv$/i.test(file.name)) {
      setFileError('That file is not a .csv. Please choose a CSV file.');
      return;
    }

    setFileMeta({ name: file.name, size: file.size });
    setPhase('parsing');

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      delimitersToGuess: [',', ';', '\t'],
      // The events files are the largest by far; parsing 21 MB on the main
      // thread would freeze the page for seconds.
      worker: true,
      complete: (results) => {
        const fields = results.meta?.fields ?? [];
        const { map, unmapped } = buildEventHeaderMap(fields);

        if (!map.event_id || !map.event_type || !map.occurred_at) {
          setPhase('idle');
          const mismatch = describeWrongFile({ fields, expected: 'events' });
          setFileError(
            (mismatch ? `${mismatch} ` : '') +
              'An events file needs an event ID, an event type and an event time. ' +
              `Columns found: ${fields.join(', ') || 'none'}.`
          );
          return;
        }

        const parseIssues = new Map();
        for (const err of results.errors ?? []) {
          if (typeof err.row !== 'number') continue;
          parseIssues.set(dataRowToRowNumber(err.row), err.message ?? 'malformed CSV');
        }

        const mapped = mapEventRows({
          rows: results.data ?? [],
          headerMap: map,
          unmapped,
          brandSlug: profile?.brand?.slug ?? '',
          parseIssues,
        });

        setParsed({ mapped, fileParseErrors: (results.errors ?? []).filter((e) => typeof e.row !== 'number') });
        setPhase('preview');
      },
      error: (error) => {
        setPhase('idle');
        setFileError(`This file could not be read: ${error.message}`);
      },
    });
  }

  const rejected = useMemo(() => {
    if (!parsed) return [];
    return parsed.mapped.errors.map((row) => ({
      ...row,
      rawRow: sanitizeForDiagnostics(row.rawRow ?? {}),
    }));
  }, [parsed]);

  function downloadRejected() {
    const csv = Papa.unparse([
      ['row_number', 'reason', 'detail', 'raw_row'],
      ...rejected.map((r) => [
        r.rowNumber,
        EVENT_REJECTION_LABELS[r.code] ?? r.code,
        r.message,
        JSON.stringify(r.rawRow),
      ]),
    ]);
    downloadCsv(`${safeFilePart(fileMeta?.name ?? 'events')}-rejected.csv`, csv);
  }

  const handleConfirm = async () => {
    if (!parsed || !profile?.brand_id || !user?.id) return;
    // Re-checked here because a disabled button is presentation, not a
    // guarantee, and this is the only path that writes.
    if (parsed.mapped.stats.brandCheck.ok === false) return;

    const { events: validRows, errors: clientErrors, stats } = parsed.mapped;

    setPhase('importing');
    setImportError('');

    const requestChunks = chunk(validRows, EVENTS_BATCH_SIZE);
    const errorGroups = chunk(clientErrors, 500);
    setProgress({
      label: 'Starting',
      batch: 0,
      batches: requestChunks.length,
      rows: validRows.length,
      stored: 0,
      skipped: 0,
      retrying: '',
    });

    // file_checksum left null: import_batches_brand_checksum_idx is unique on
    // (brand_id, file_checksum) for completed batches, so recording it would
    // make a legitimate re-import fail.
    const { data: batchRow, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        brand_id: profile.brand_id,
        uploaded_by: user.id,
        filename: (fileMeta?.name ?? 'events.csv').slice(0, 255),
        entity: 'events',
        status: 'processing',
        total_rows: stats.total,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (batchError || !batchRow) {
      setPhase('preview');
      setImportError('Could not start the import. Nothing was saved.');
      return;
    }

    const batchId = batchRow.id;
    setProgress((p) => ({ ...p, label: 'Recording rejected rows' }));

    const failBatch = async (message) => {
      await supabase
        .from('import_batches')
        .update({ status: 'failed', completed_at: new Date().toISOString() })
        .eq('id', batchId)
        .eq('brand_id', profile.brand_id);
      setPhase('preview');
      setImportError(message);
      void loadBatches();
    };

    // Recording rejected rows is a diagnostic side-channel: failing to write it
    // must never stop events that would otherwise import.
    let errorRowsStored = 0;
    const errorLogFailures = [];

    for (let i = 0; i < errorGroups.length; i += 1) {
      const rows = errorGroups[i].map((row) => ({
        brand_id: profile.brand_id,
        batch_id: batchId,
        row_number: row.rowNumber,
        error_code: row.code,
        error_message: row.message,
        raw_row: sanitizeForDiagnostics(row.rawRow ?? {}),
      }));
      const { error } = await supabase.from('import_errors').insert(rows);
      if (error) {
        errorLogFailures.push(i + 1);
        // eslint-disable-next-line no-console
        console.warn(`[events import] could not record rejected rows (group ${i + 1})`, error);
      } else {
        errorRowsStored += rows.length;
      }
      setProgress((p) => ({
        ...p,
        label: `Recording rejected rows (group ${i + 1} of ${errorGroups.length})`,
      }));
    }

    // ---- send to the Edge Function ------------------------------------------
    // The browser never resolves an external id to a UUID. Both lookups happen
    // inside the function against a brand_id derived from the session, because
    // 12,407 contact ids exist in more than one brand.
    let inserted = 0;
    let duplicates = 0;
    const serverRejected = [];
    const serverWarnings = [];

    for (let i = 0; i < requestChunks.length; i += 1) {
      const body = {
        batchId,
        rows: requestChunks[i].map((row) => ({
          rowNumber: row.rowNumber,
          eventId: row.eventId,
          contactExternalId: row.contactExternalId,
          campaignExternalId: row.campaignExternalId,
          eventType: row.eventType,
          channel: row.channel,
          occurredAt: row.occurredAt,
        })),
      };

      setProgress((p) => ({
        ...p,
        label: 'Sending events',
        batch: i + 1,
        retrying: '',
      }));

      // Retried rather than fatal. A dropped worker part-way through ~600
      // requests is an infrastructure hiccup, not bad data, and the insert is
      // ON CONFLICT DO NOTHING so a batch that half-succeeded before dropping
      // re-sends as duplicates instead of doubling anything up.
      let data = null;
      let lastStatus = 0;
      let lastPayload = null;

      for (let attempt = 1; attempt <= EVENTS_BATCH_ATTEMPTS; attempt += 1) {
        const response = await supabase.functions.invoke('import-events', { body });

        if (!response.error) {
          data = response.data;
          break;
        }

        lastStatus = 0;
        lastPayload = null;
        if (response.error.context && typeof response.error.context.json === 'function') {
          lastStatus = response.error.context.status ?? 0;
          try {
            lastPayload = await response.error.context.json();
          } catch {
            lastPayload = null;
          }
        }

        // A refusal is a decision, not a hiccup â€” retrying it would only
        // repeat the same answer more slowly.
        if (lastStatus === 401 || lastStatus === 403 || lastStatus === 413) break;

        if (attempt < EVENTS_BATCH_ATTEMPTS) {
          setProgress((p) => ({
            ...p,
            retrying: `Batch ${i + 1} did not complete. Retrying (attempt ${attempt + 1} of ${EVENTS_BATCH_ATTEMPTS})\u2026`,
          }));
          await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
        }
      }

      if (!data) {
        await failBatch(
          `${humanizeEventsError(lastStatus, lastPayload)} This was batch ${i + 1} of ` +
            `${requestChunks.length}. ${fmt(inserted)} events were stored before it and are kept. ` +
            'Re-running this file is safe: events already stored are skipped, not duplicated.'
        );
        return;
      }

      inserted += data?.inserted ?? 0;
      duplicates += data?.duplicates ?? 0;
      for (const row of data?.rejected ?? []) serverRejected.push(row);
      for (const row of data?.warnings ?? []) serverWarnings.push(row);

      setProgress((p) => ({
        ...p,
        batch: i + 1,
        stored: inserted,
        skipped: duplicates,
        retrying: '',
      }));
    }

    // ---- record what the server reported ------------------------------------
    // One import_errors slot per source row (unique on batch_id, row_number),
    // so several warnings on one row are combined rather than inserted twice.
    const byRow = new Map();
    for (const row of serverWarnings) {
      const group = byRow.get(row.rowNumber);
      if (group) group.push(row);
      else byRow.set(row.rowNumber, [row]);
    }

    const serverPayload = [
      ...serverRejected.map((row) => ({
        brand_id: profile.brand_id,
        batch_id: batchId,
        row_number: row.rowNumber,
        error_code: row.code,
        error_message: row.message,
        raw_row: {},
      })),
      ...Array.from(byRow, ([rowNumber, group]) => ({
        brand_id: profile.brand_id,
        batch_id: batchId,
        row_number: rowNumber,
        error_code:
          group.length === 1
            ? `${WARNING_CODE_PREFIX}${group[0].code}`
            : `${WARNING_CODE_PREFIX}multiple`,
        error_message: group
          .map((w) => `${EVENT_WARNING_LABELS[w.code] ?? w.code}: ${w.message}`)
          .join(' | '),
        raw_row: {},
      })),
    ];

    for (const group of chunk(serverPayload, 500)) {
      const { error } = await supabase.from('import_errors').insert(group);
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[events import] could not record server-reported rows', error);
      }
    }

    const failedRows = clientErrors.length + serverRejected.length;

    const { error: finalizeError } = await supabase
      .from('import_batches')
      .update({
        status: 'completed',
        inserted_rows: inserted,
        // message_events is append-only: a repeat is skipped, never updated.
        updated_rows: 0,
        failed_rows: failedRows,
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId)
      .eq('brand_id', profile.brand_id);

    setResult({
      batchId,
      total: stats.total,
      inserted,
      duplicates,
      collapsed: stats.duplicatesCollapsed,
      failed: failedRows,
      warnings: serverWarnings.length,
      unresolvedContacts: serverWarnings.filter((w) => w.code === 'unresolved_contact').length,
      unresolvedCampaigns: serverWarnings.filter((w) => w.code === 'unresolved_campaign').length,
      errorLogWarning:
        errorLogFailures.length > 0
          ? `${fmt(clientErrors.length - errorRowsStored)} rejected rows could not be recorded for later review.`
          : '',
      finalizeWarning: finalizeError
        ? 'The events were saved, but the import summary could not be recorded.'
        : '',
    });

    setPhase('done');
    setPage(0);
    void loadEvents(0);
    void loadBatches();
  };

  const stats = parsed?.mapped.stats;
  const brandCheck = stats?.brandCheck;
  const rejectedPageRows = rejected.slice(
    rejectedPage * REJECTED_PREVIEW_PAGE,
    rejectedPage * REJECTED_PREVIEW_PAGE + REJECTED_PREVIEW_PAGE
  );

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <BackToDashboard />
        <h1 className="text-2xl font-semibold text-slate-900">Events</h1>
        <p className="mt-1 text-sm text-slate-600">
          Historical engagement receipts. Opens, clicks, bounces, complaints and unsubscribes,
          loaded from the provider&rsquo;s export.
        </p>
      </header>

      {/* ---------------- upload ---------------- */}
      {(phase === 'idle' || phase === 'parsing') && (
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <label
            htmlFor="events-file"
            className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-slate-400"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="text-sm font-medium text-slate-700">
              Drop an events CSV here, or click to choose one
            </span>
            <span className="mt-1 text-xs text-slate-500">
              Large files are expected â€” these are the biggest exports.
            </span>
            <input
              ref={fileInputRef}
              id="events-file"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => handleFile(e.target.files?.[0])}
            />
          </label>

          {phase === 'parsing' && (
            <p className="mt-4 text-sm text-slate-600">Reading {fileMeta?.name}&hellip;</p>
          )}
          {fileError && (
            <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {fileError}
            </p>
          )}
        </section>
      )}

      {/* ---------------- preview ---------------- */}
      {phase === 'preview' && stats && (
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-medium text-slate-900">
            {fileMeta?.name} &mdash; ready to import
          </h2>

          {brandCheck?.ok === false && (
            <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-3 text-sm text-red-900">
              <p className="font-medium">
                This file looks like it belongs to {brandCheck.looksLike}, not {brandCheck.ownCode}.
              </p>
              <p className="mt-1">
                {fmt(brandCheck.matched)} of its campaign references are numbered for{' '}
                {brandCheck.counts.map((c) => `${c.brand} (${fmt(c.count)})`).join(', ')}, and none
                for your brand. Event IDs and contact IDs are shared across brands, so importing
                this here would file another brand&rsquo;s engagement history under yours. It has
                been blocked.
              </p>
              <p className="mt-1 text-xs text-red-800">
                If you meant to import this, sign in as {brandCheck.looksLike} and upload it there.
              </p>
            </div>
          )}

          <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Rows read</dt>
              <dd className="text-xl font-semibold text-slate-900">{fmt(stats.total)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">To import</dt>
              <dd className="text-xl font-semibold text-emerald-700">{fmt(stats.valid)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Repeats collapsed</dt>
              <dd className="text-xl font-semibold text-slate-700">{fmt(stats.duplicatesCollapsed)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Rejected</dt>
              <dd className="text-xl font-semibold text-red-700">{fmt(stats.invalid)}</dd>
            </div>
          </dl>

          {stats.duplicatesCollapsed > 0 && (
            <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {fmt(stats.duplicatesCollapsed)} rows repeat an event ID that appears earlier in the
              file with byte-identical details. These are provider redeliveries, so the first copy
              is kept and the repeats are skipped &mdash; nothing is lost. A repeat whose details
              differ is rejected instead, and none were found here.
            </p>
          )}

          {stats.unmapped.length > 0 && (
            <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              These columns are not recognised and will not be stored:{' '}
              <span className="font-mono text-xs">{stats.unmapped.join(', ')}</span>
            </p>
          )}

          {stats.byCode.length > 0 && (
            <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              <p className="font-medium">Why rows were rejected</p>
              <ul className="mt-1 space-y-0.5">
                {stats.byCode.map((entry) => (
                  <li key={entry.code}>
                    {fmt(entry.count)} &times; {EVENT_REJECTION_LABELS[entry.code] ?? entry.code}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {rejected.length > 0 && (
            <div className="mb-4">
              <button
                type="button"
                onClick={() => setShowRejected((v) => !v)}
                className="text-sm font-medium text-slate-700 underline hover:text-slate-900"
              >
                {showRejected ? 'Hide' : 'View'} rejected rows ({fmt(rejected.length)})
              </button>

              {showRejected && (
                <div className="mt-3 rounded-md border border-slate-200">
                  <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2">
                    <span className="text-xs text-slate-600">
                      Showing {fmt(rejectedPage * REJECTED_PREVIEW_PAGE + 1)}&ndash;
                      {fmt(Math.min((rejectedPage + 1) * REJECTED_PREVIEW_PAGE, rejected.length))} of{' '}
                      {fmt(rejected.length)}
                    </span>
                    <button
                      type="button"
                      onClick={downloadRejected}
                      className="text-xs font-medium text-slate-700 underline hover:text-slate-900"
                    >
                      Download all as CSV
                    </button>
                  </div>
                  <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5">Row</th>
                        <th className="px-2 py-1.5">Reason</th>
                        <th className="px-2 py-1.5">Source row</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rejectedPageRows.map((row) => (
                        <tr key={row.rowNumber} className="border-t border-slate-100">
                          <td className="px-2 py-1.5 align-top">{row.rowNumber}</td>
                          <td className="px-2 py-1.5 align-top">
                            <span className="font-medium">
                              {EVENT_REJECTION_LABELS[row.code] ?? row.code}
                            </span>
                            <span className="block text-slate-600">{row.message}</span>
                          </td>
                          <td className="px-2 py-1.5 align-top font-mono text-slate-500">
                            {rawRowPreview(row.rawRow)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                  <div className="flex justify-between border-t border-slate-200 px-3 py-2">
                    <button
                      type="button"
                      disabled={rejectedPage === 0}
                      onClick={() => setRejectedPage((p) => p - 1)}
                      className="text-xs text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={(rejectedPage + 1) * REJECTED_PREVIEW_PAGE >= rejected.length}
                      onClick={() => setRejectedPage((p) => p + 1)}
                      className="text-xs text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {importError && (
            <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {importError}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => void handleConfirm()}
              disabled={stats.valid === 0 || brandCheck?.ok === false}
              className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
            >
              Import {fmt(stats.valid)} events
            </button>
            <button
              type="button"
              onClick={resetImport}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {/* ---------------- importing ---------------- */}
      {phase === 'importing' && (
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-2 text-lg font-medium text-slate-900">Importing&hellip;</h2>
          <p className="mb-1 text-sm font-medium text-slate-800">
            {progress.label}
            {progress.batches > 0 && (
              <>
                {' '}
                &mdash; batch {fmt(progress.batch)} of {fmt(progress.batches)}
              </>
            )}
          </p>
          {progress.batches > 0 && (
            <p className="mb-3 text-sm text-slate-600">
              {fmt(progress.stored)} stored, {fmt(progress.skipped)} already present, out of{' '}
              {fmt(progress.rows)} to send
            </p>
          )}
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{
                width: `${progress.batches ? (progress.batch / progress.batches) * 100 : 0}%`,
              }}
            />
          </div>
          {progress.retrying && (
            <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {progress.retrying}
            </p>
          )}
          <p className="mt-3 text-xs text-slate-500">
            Please keep this tab open. Events already stored are kept even if something fails
            later, and re-running the file skips them rather than duplicating them.
          </p>
        </section>
      )}

      {/* ---------------- summary ---------------- */}
      {phase === 'done' && result && (
        <section className="mb-8 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
          <h2 className="mb-3 text-lg font-medium text-emerald-900">Import finished</h2>
          <dl className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Rows read</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.total)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Stored</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.inserted)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Already present</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.duplicates)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Repeats collapsed</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.collapsed)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Rejected</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.failed)}</dd>
            </div>
          </dl>

          {result.warnings > 0 && (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {fmt(result.warnings)} events were stored with something missing:{' '}
              {fmt(result.unresolvedContacts)} named a contact and{' '}
              {fmt(result.unresolvedCampaigns)} named a campaign that this brand does not hold.
              The events were kept, because they happened and discarding them would understate
              engagement. The unmatched IDs are recorded against this import.
            </p>
          )}

          {result.errorLogWarning && (
            <p className="mb-2 text-sm text-amber-900">{result.errorLogWarning}</p>
          )}
          {result.finalizeWarning && (
            <p className="mb-2 text-sm text-amber-900">{result.finalizeWarning}</p>
          )}

          <button
            type="button"
            onClick={resetImport}
            className="rounded-md bg-emerald-700 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-800"
          >
            Import another file
          </button>
        </section>
      )}

      {/* ---------------- past imports ---------------- */}
      <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium text-slate-900">Past event imports</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-slate-600">No events have been imported yet.</p>
        ) : (
          <>
            <label htmlFor="batch-select" className="block text-xs text-slate-600">
              Choose an import to see the rows it could not store
            </label>
            <select
              id="batch-select"
              value={selectedBatch}
              onChange={(e) => {
                setSelectedBatch(e.target.value);
                setHistoryPage(0);
              }}
              className="mt-1 box-border w-full max-w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:max-w-xl"
            >
              <option value="">Select an import&hellip;</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {new Date(batch.created_at).toLocaleString()} &mdash; {batch.filename} (
                  {fmt(batch.inserted_rows)} stored, {fmt(batch.failed_rows)} rejected)
                </option>
              ))}
            </select>

            {selectedBatch && (
              <div className="mt-4">
                {historyLoading && <p className="text-sm text-slate-600">Loading&hellip;</p>}
                {historyError && (
                  <p role="alert" className="text-sm text-red-800">
                    {historyError}
                  </p>
                )}
                {!historyLoading && !historyError && historyRows.length === 0 && (
                  <p className="text-sm text-slate-600">
                    Every row in that import was stored. Nothing to review.
                  </p>
                )}
                {historyRows.length > 0 && (
                  <>
                    <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-2 py-1.5">Row</th>
                          <th className="px-2 py-1.5">Outcome</th>
                          <th className="px-2 py-1.5">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyRows.map((row) => (
                          <tr key={row.row_number} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 align-top">{row.row_number}</td>
                            <td className="px-2 py-1.5 align-top">
                              {isWarningCode(row.error_code) ? (
                                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                                  stored
                                </span>
                              ) : (
                                <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-900">
                                  rejected
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 align-top">
                              <span className="font-medium">{labelForCode(row.error_code)}</span>
                              <span className="block text-slate-600">{row.error_message}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs">
                      <span className="text-slate-600">
                        {fmt(historyPage * HISTORY_PAGE_SIZE + 1)}&ndash;
                        {fmt(Math.min((historyPage + 1) * HISTORY_PAGE_SIZE, historyCount))} of{' '}
                        {fmt(historyCount)}
                      </span>
                      <span className="flex gap-3">
                        <button
                          type="button"
                          disabled={historyPage === 0}
                          onClick={() => setHistoryPage((p) => p - 1)}
                          className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          disabled={(historyPage + 1) * HISTORY_PAGE_SIZE >= historyCount}
                          onClick={() => setHistoryPage((p) => p + 1)}
                          className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                        >
                          Next
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------------- stored events ---------------- */}
      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium text-slate-900">
          Stored events {eventCount > 0 && <span className="text-sm font-normal text-slate-500">({fmt(eventCount)})</span>}
        </h2>

        {listError && (
          <p role="alert" className="text-sm text-red-800">
            {listError}
          </p>
        )}
        {listLoading && <p className="text-sm text-slate-600">Loading&hellip;</p>}
        {!listLoading && !listError && events.length === 0 && (
          <p className="text-sm text-slate-600">
            No events yet. Import an events CSV to see engagement here.
          </p>
        )}

        {events.length > 0 && (
          <>
            <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-2 py-2">Event ID</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Channel</th>
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Linked to</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t border-slate-100">
                    <td className="px-2 py-2 font-mono text-xs">{event.provider_event_id}</td>
                    <td className="px-2 py-2">{event.event_type}</td>
                    <td className="px-2 py-2">{event.payload?.channel ?? '\u2014'}</td>
                    <td className="px-2 py-2">{new Date(event.event_timestamp).toLocaleString()}</td>
                    <td className="px-2 py-2 text-xs text-slate-600">
                      {event.contact_id ? 'contact' : null}
                      {event.contact_id && event.campaign_id ? ' + ' : null}
                      {event.campaign_id ? 'campaign' : null}
                      {!event.contact_id && !event.campaign_id ? 'nothing matched' : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-slate-600">
                {fmt(page * EVENTS_PAGE_SIZE + 1)}&ndash;
                {fmt(Math.min((page + 1) * EVENTS_PAGE_SIZE, eventCount))} of {fmt(eventCount)}
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={(page + 1) * EVENTS_PAGE_SIZE >= eventCount}
                  onClick={() => setPage((p) => p + 1)}
                  className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                >
                  Next
                </button>
              </span>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
