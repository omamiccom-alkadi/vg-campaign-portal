import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import BackToDashboard from '../components/BackToDashboard';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { chunk, dataRowToRowNumber, sanitizeForDiagnostics } from '../lib/csvImport';
import {
  SENDS_PAGE_SIZE,
  SEND_LOG_BATCH_SIZE,
  SEND_LOG_REJECTION_LABELS,
  buildSendLogHeaderMap,
  humanizeSendLogError,
  mapSendLogRows,
} from '../lib/sendLogImport';
import { downloadCsv, rawRowPreview, safeFilePart } from '../lib/csvDownload';
import { describeWrongFile } from '../lib/fileKind';

const HISTORY_PAGE_SIZE = 25;
const BATCH_LIST_LIMIT = 50;

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n ?? 0);

export default function Sends() {
  const { profile, user } = useAuth();

  const [phase, setPhase] = useState('idle');
  const [fileMeta, setFileMeta] = useState(null);
  const [fileError, setFileError] = useState('');
  const [parsed, setParsed] = useState(null);
  const [showRejected, setShowRejected] = useState(false);

  const [progress, setProgress] = useState({ label: '', batch: 0, batches: 0 });
  const [importError, setImportError] = useState('');
  const [result, setResult] = useState(null);

  const [sends, setSends] = useState([]);
  const [sendCount, setSendCount] = useState(0);
  const [page, setPage] = useState(0);
  const [listError, setListError] = useState('');
  const [listLoading, setListLoading] = useState(true);

  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState('');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyCount, setHistoryCount] = useState(0);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyError, setHistoryError] = useState('');

  const fileInputRef = useRef(null);

  const loadSends = useCallback(
    async (targetPage) => {
      if (!profile?.brand_id) return;
      setListLoading(true);
      setListError('');
      const from = targetPage * SENDS_PAGE_SIZE;

      const { data, error, count } = await supabase
        .from('campaign_sends')
        .select(
          'id, batch_key, status, is_backfill, recipient_count, dispatched_at, created_at, campaign_id',
          { count: 'exact' }
        )
        .eq('brand_id', profile.brand_id)
        .order('dispatched_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, from + SENDS_PAGE_SIZE - 1);

      if (error) {
        setListError('Could not load sends. Try reloading the page.');
        setSends([]);
      } else {
        setSends(data ?? []);
        setSendCount(count ?? 0);
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
      .eq('entity', 'sends')
      .order('created_at', { ascending: false })
      .limit(BATCH_LIST_LIMIT);
    if (!error) setBatches(data ?? []);
  }, [profile?.brand_id]);

  const loadHistoryErrors = useCallback(
    async (batchId, targetPage) => {
      if (!profile?.brand_id || !batchId) return;
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
    },
    [profile?.brand_id]
  );

  useEffect(() => {
    void loadSends(page);
  }, [loadSends, page]);

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
    setProgress({ label: '', batch: 0, batches: 0 });
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
      complete: (results) => {
        const fields = results.meta?.fields ?? [];
        const { map, unmapped } = buildSendLogHeaderMap(fields);

        if (!map.batch_key || !map.recipient_count) {
          setPhase('idle');
          const mismatch = describeWrongFile({ fields, expected: 'sends' });
          setFileError(
            (mismatch ? `${mismatch} ` : '') +
              'A send log needs a batch key column and a recipient count column. ' +
              `Columns found: ${fields.join(', ') || 'none'}.`
          );
          return;
        }

        const parseIssues = new Map();
        for (const err of results.errors ?? []) {
          if (typeof err.row !== 'number') continue;
          parseIssues.set(dataRowToRowNumber(err.row), err.message ?? 'malformed CSV');
        }

        const mapped = mapSendLogRows({
          rows: results.data ?? [],
          headerMap: map,
          unmapped,
          brandSlug: profile?.brand?.slug ?? '',
          parseIssues,
        });

        setParsed({ mapped });
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
        SEND_LOG_REJECTION_LABELS[r.code] ?? r.code,
        r.message,
        JSON.stringify(r.rawRow),
      ]),
    ]);
    downloadCsv(`${safeFilePart(fileMeta?.name ?? 'send-log')}-rejected.csv`, csv);
  }

  const handleConfirm = async () => {
    if (!parsed || !profile?.brand_id || !user?.id) return;
    if (parsed.mapped.stats.brandCheck.ok === false) return;

    const { sends: validRows, errors: clientErrors, stats } = parsed.mapped;

    setPhase('importing');
    setImportError('');

    const requestChunks = chunk(validRows, SEND_LOG_BATCH_SIZE);
    setProgress({ label: 'Starting', batch: 0, batches: requestChunks.length });

    const { data: batchRow, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        brand_id: profile.brand_id,
        uploaded_by: user.id,
        filename: (fileMeta?.name ?? 'send-log.csv').slice(0, 255),
        entity: 'sends',
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

    let errorRowsStored = 0;
    let errorLogFailed = false;

    for (const group of chunk(clientErrors, 200)) {
      const rows = group.map((row) => ({
        brand_id: profile.brand_id,
        batch_id: batchId,
        row_number: row.rowNumber,
        error_code: row.code,
        error_message: row.message,
        raw_row: sanitizeForDiagnostics(row.rawRow ?? {}),
      }));
      const { error } = await supabase.from('import_errors').insert(rows);
      if (error) {
        errorLogFailed = true;
        // eslint-disable-next-line no-console
        console.warn('[send log import] could not record rejected rows', error);
      } else {
        errorRowsStored += rows.length;
      }
    }

    let inserted = 0;
    let duplicates = 0;
    let collapsedServerSide = 0;
    const serverRejected = [];

    for (let i = 0; i < requestChunks.length; i += 1) {
      setProgress({ label: 'Recording sends', batch: i + 1, batches: requestChunks.length });

      const body = {
        batchId,
        rows: requestChunks[i].map((row) => ({
          rowNumber: row.rowNumber,
          batchKey: row.batchKey,
          campaignExternalId: row.campaignExternalId,
          queuedAt: row.queuedAt,
          recipientCount: row.recipientCount,
          status: row.status,
        })),
      };

      const { data, error } = await supabase.functions.invoke('import-send-log', { body });

      if (error) {
        let status = 0;
        let payload = null;
        if (error.context && typeof error.context.json === 'function') {
          status = error.context.status ?? 0;
          try {
            payload = await error.context.json();
          } catch {
            payload = null;
          }
        }
        await failBatch(
          `${humanizeSendLogError(status, payload)} This was batch ${i + 1} of ` +
            `${requestChunks.length}. ${fmt(inserted)} sends were recorded before it and are kept. ` +
            'Re-running this file is safe: sends already recorded are skipped, not duplicated.'
        );
        return;
      }

      inserted += data?.inserted ?? 0;
      duplicates += data?.duplicates ?? 0;
      collapsedServerSide += data?.collapsed ?? 0;
      for (const row of data?.rejected ?? []) serverRejected.push(row);
    }

    if (serverRejected.length > 0) {
      const payload = serverRejected.map((row) => ({
        brand_id: profile.brand_id,
        batch_id: batchId,
        row_number: row.rowNumber,
        error_code: row.code,
        error_message: row.message,
        raw_row: {},
      }));
      const { error } = await supabase.from('import_errors').insert(payload);
      if (error) {
        // eslint-disable-next-line no-console
        console.warn('[send log import] could not record server-rejected rows', error);
      }
    }

    const failedRows = clientErrors.length + serverRejected.length;

    const { error: finalizeError } = await supabase
      .from('import_batches')
      .update({
        status: 'completed',
        inserted_rows: inserted,
        // ON CONFLICT DO NOTHING: an existing send is skipped, never rewritten.
        updated_rows: 0,
        failed_rows: failedRows,
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId)
      .eq('brand_id', profile.brand_id);

    setResult({
      total: stats.total,
      inserted,
      duplicates,
      collapsed: stats.duplicatesCollapsed + collapsedServerSide,
      failed: failedRows,
      recipients: stats.totalRecipients,
      errorLogWarning:
        errorLogFailed && clientErrors.length > errorRowsStored
          ? `${fmt(clientErrors.length - errorRowsStored)} rejected rows could not be recorded for later review.`
          : '',
      finalizeWarning: finalizeError
        ? 'The sends were recorded, but the import summary could not be saved.'
        : '',
    });

    setPhase('done');
    setPage(0);
    void loadSends(0);
    void loadBatches();
  };

  const stats = parsed?.mapped.stats;
  const brandCheck = stats?.brandCheck;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6">
        <BackToDashboard />
        <h1 className="text-2xl font-semibold text-slate-900">Sends</h1>
        <p className="mt-1 text-sm text-slate-600">
          Historical send batches, imported from the provider&rsquo;s log. These are records of
          sends that already happened &mdash; importing them never contacts anyone.
        </p>
      </header>

      {(phase === 'idle' || phase === 'parsing') && (
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            This is the backfill path, not the send flow. Rows land marked as historical, so they
            can never occupy the slot that stops a live campaign being sent twice.
          </div>

          <label
            htmlFor="sendlog-file"
            className="flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed border-slate-300 px-6 py-10 text-center hover:border-slate-400"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="text-sm font-medium text-slate-700">
              Drop a send log CSV here, or click to choose one
            </span>
            <input
              ref={fileInputRef}
              id="sendlog-file"
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
                Its campaign references are numbered for{' '}
                {brandCheck.counts.map((c) => `${c.brand} (${fmt(c.count)})`).join(', ')}, and none
                for your brand. Importing it here would record another brand&rsquo;s spend against
                your campaigns, so it has been blocked.
              </p>
            </div>
          )}

          <dl className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Rows read</dt>
              <dd className="text-xl font-semibold text-slate-900">{fmt(stats.total)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Batches to record</dt>
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

          <p className="mb-4 text-sm text-slate-600">
            Total recipients across these batches: {fmt(stats.totalRecipients)}. This is the
            provider&rsquo;s own figure, recorded as given &mdash; it is not derived from events and
            may not agree with the totals on the campaigns themselves.
          </p>

          {stats.duplicatesCollapsed > 0 && (
            <p className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {fmt(stats.duplicatesCollapsed)} row{stats.duplicatesCollapsed === 1 ? '' : 's'} repeat
              a batch key that appears earlier in the file with identical details, so the first copy
              is kept. A repeat whose details differed would be rejected instead, because there
              would be no way to tell which copy is right.
            </p>
          )}

          {stats.unmapped.length > 0 && (
            <p className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              These columns are not recognised and will not be stored:{' '}
              <span className="font-mono text-xs">{stats.unmapped.join(', ')}</span>
            </p>
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
                  <div className="flex items-center justify-end border-b border-slate-200 px-3 py-2">
                    <button
                      type="button"
                      onClick={downloadRejected}
                      className="text-xs font-medium text-slate-700 underline hover:text-slate-900"
                    >
                      Download as CSV
                    </button>
                  </div>
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-2 py-1.5">Row</th>
                        <th className="px-2 py-1.5">Reason</th>
                        <th className="px-2 py-1.5">Source row</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rejected.map((row) => (
                        <tr key={row.rowNumber} className="border-t border-slate-100">
                          <td className="px-2 py-1.5 align-top">{row.rowNumber}</td>
                          <td className="px-2 py-1.5 align-top">
                            <span className="font-medium">
                              {SEND_LOG_REJECTION_LABELS[row.code] ?? row.code}
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
              Record {fmt(stats.valid)} historical send{stats.valid === 1 ? '' : 's'}
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

      {phase === 'importing' && (
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-2 text-lg font-medium text-slate-900">Importing&hellip;</h2>
          <p className="mb-3 text-sm text-slate-600">
            {progress.label}
            {progress.batches > 0 && ` — batch ${progress.batch} of ${progress.batches}`}
          </p>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
            <div
              className="h-full bg-slate-900 transition-all"
              style={{ width: `${progress.batches ? (progress.batch / progress.batches) * 100 : 0}%` }}
            />
          </div>
        </section>
      )}

      {phase === 'done' && result && (
        <section className="mb-8 rounded-lg border border-emerald-200 bg-emerald-50 p-6">
          <h2 className="mb-3 text-lg font-medium text-emerald-900">Import finished</h2>
          <dl className="mb-3 grid grid-cols-2 gap-4 sm:grid-cols-5">
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Rows read</dt>
              <dd className="text-xl font-semibold text-emerald-900">{fmt(result.total)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-emerald-800">Recorded</dt>
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

      <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium text-slate-900">Past send-log imports</h2>
        {batches.length === 0 ? (
          <p className="text-sm text-slate-600">No send logs have been imported yet.</p>
        ) : (
          <>
            <select
              value={selectedBatch}
              onChange={(e) => {
                setSelectedBatch(e.target.value);
                setHistoryPage(0);
              }}
              className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:max-w-xl"
              aria-label="Choose an import to review"
            >
              <option value="">Select an import&hellip;</option>
              {batches.map((batch) => (
                <option key={batch.id} value={batch.id}>
                  {new Date(batch.created_at).toLocaleString()} &mdash; {batch.filename} (
                  {fmt(batch.inserted_rows)} recorded, {fmt(batch.failed_rows)} rejected)
                </option>
              ))}
            </select>

            {selectedBatch && (
              <div className="mt-4">
                {historyError && (
                  <p role="alert" className="text-sm text-red-800">
                    {historyError}
                  </p>
                )}
                {!historyError && historyRows.length === 0 && (
                  <p className="text-sm text-slate-600">
                    Every row in that import was recorded. Nothing to review.
                  </p>
                )}
                {historyRows.length > 0 && (
                  <>
                    <table className="w-full text-left text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="px-2 py-1.5">Row</th>
                          <th className="px-2 py-1.5">Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyRows.map((row) => (
                          <tr key={row.row_number} className="border-t border-slate-100">
                            <td className="px-2 py-1.5 align-top">{row.row_number}</td>
                            <td className="px-2 py-1.5 align-top">
                              <span className="font-medium">
                                {SEND_LOG_REJECTION_LABELS[row.error_code] ?? row.error_code}
                              </span>
                              <span className="block text-slate-600">{row.error_message}</span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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

      <section className="rounded-lg border border-slate-200 bg-white p-6">
        <h2 className="mb-3 text-lg font-medium text-slate-900">
          Recorded sends{' '}
          {sendCount > 0 && <span className="text-sm font-normal text-slate-500">({fmt(sendCount)})</span>}
        </h2>

        {listError && (
          <p role="alert" className="text-sm text-red-800">
            {listError}
          </p>
        )}
        {listLoading && <p className="text-sm text-slate-600">Loading&hellip;</p>}
        {!listLoading && !listError && sends.length === 0 && (
          <p className="text-sm text-slate-600">
            No sends recorded yet. Import a send log to see historical batches here.
          </p>
        )}

        {sends.length > 0 && (
          <>
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
                <tr>
                  <th className="px-2 py-2">Batch</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Origin</th>
                  <th className="px-2 py-2 text-right">Recipients</th>
                  <th className="px-2 py-2">Dispatched</th>
                </tr>
              </thead>
              <tbody>
                {sends.map((send) => (
                  <tr key={send.id} className="border-t border-slate-100">
                    <td className="px-2 py-2 font-mono text-xs">{send.batch_key ?? '\u2014'}</td>
                    <td className="px-2 py-2">{send.status}</td>
                    <td className="px-2 py-2">
                      {send.is_backfill ? (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-700">
                          imported history
                        </span>
                      ) : (
                        <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs text-emerald-900">
                          live send
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-right">{fmt(send.recipient_count)}</td>
                    <td className="px-2 py-2">
                      {send.dispatched_at ? new Date(send.dispatched_at).toLocaleString() : '\u2014'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 flex items-center justify-between text-sm">
              <span className="text-slate-600">
                {fmt(page * SENDS_PAGE_SIZE + 1)}&ndash;
                {fmt(Math.min((page + 1) * SENDS_PAGE_SIZE, sendCount))} of {fmt(sendCount)}
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
                  disabled={(page + 1) * SENDS_PAGE_SIZE >= sendCount}
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
