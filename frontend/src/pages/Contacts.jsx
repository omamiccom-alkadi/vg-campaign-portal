import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import BackToDashboard from '../components/BackToDashboard';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import {
  CONTACTS_PAGE_SIZE,
  CONTACT_BATCH_SIZE,
  buildHeaderMap,
  chunk,
  dataRowToRowNumber,
  dedupeBatchByEmail,
  humanizeDbError,
  KNOWN_STATUS_VALUES,
  mapRows,
  REJECTION_LABELS,
  rejectedRowsToCsv,
  resolveExternalIdCollisions,
  sanitizeForDiagnostics,
  CONTACT_WARNING_LABELS,
  WARNING_CODE_PREFIX,
} from '../lib/csvImport';
import { downloadCsv, rawRowPreview, safeFilePart } from '../lib/csvDownload';
import { describeWrongFile } from '../lib/fileKind';

const isWarningCode = (code) => String(code ?? '').startsWith(WARNING_CODE_PREFIX);

function historyLabel(code) {
  if (isWarningCode(code)) {
    const bare = String(code).slice(WARNING_CODE_PREFIX.length);
    return CONTACT_WARNING_LABELS[bare] ?? bare;
  }
  return REJECTION_LABELS[code] ?? code;
}

// Kilele's contacts file is ~11MB. Above this, parsing moves off the main
// thread so the UI keeps responding while it runs.
const WORKER_THRESHOLD_BYTES = 2 * 1024 * 1024;
const REJECTED_PAGE_SIZE = 25;
const HISTORY_PAGE_SIZE = 25;
const BATCH_LIST_LIMIT = 50;
// Export pages through the DB rather than asking for tens of thousands of rows
// in one request.
const EXPORT_CHUNK = 1000;

export default function Contacts() {
  const { user, profile } = useAuth();

  // ---------------------------------------------------------------------------
  // Pre-import state. Lives in client memory only: there is no batch row yet,
  // so nothing here may ever be read back from import_errors.
  // ---------------------------------------------------------------------------
  const [phase, setPhase] = useState('idle'); // idle | parsing | preview | importing | done
  const [fileMeta, setFileMeta] = useState(null);
  const [fileError, setFileError] = useState('');
  const [parsed, setParsed] = useState(null);
  const [ackParseErrors, setAckParseErrors] = useState(false);
  const [showRejected, setShowRejected] = useState(false);
  const [rejectedQuery, setRejectedQuery] = useState('');
  const [rejectedPage, setRejectedPage] = useState(0);

  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [importError, setImportError] = useState('');
  const [result, setResult] = useState(null);

  // ---------------------------------------------------------------------------
  // Post-import state. Comes from the database only, so it survives a reload
  // and never depends on parse state that a new file selection would wipe.
  // ---------------------------------------------------------------------------
  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyCount, setHistoryCount] = useState(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [exporting, setExporting] = useState(false);

  const [contacts, setContacts] = useState([]);
  const [contactCount, setContactCount] = useState(null);
  const [page, setPage] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');

  const inputRef = useRef(null);

  /**
   * Real database-level paging: .range() plus an exact count, so the query cost
   * is the same for 50 contacts and 50,000. The id tiebreaker keeps the order
   * total — created_at alone can tie inside one import and silently drop or
   * repeat rows across pages.
   *
   * brand_id is also passed explicitly. RLS is what enforces isolation; this is
   * belt-and-braces and lets the planner use contacts_brand_created_idx.
   */
  const loadContacts = useCallback(
    async (targetPage) => {
      if (!profile?.brand_id) return;
      setListLoading(true);
      setListError('');

      const from = targetPage * CONTACTS_PAGE_SIZE;
      const { data, count, error } = await supabase
        .from('contacts')
        .select('id, email, full_name', { count: 'exact' })
        .eq('brand_id', profile.brand_id)
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .range(from, from + CONTACTS_PAGE_SIZE - 1);

      if (error) {
        setListError(humanizeDbError(error, 'load contacts'));
        setContacts([]);
        setListLoading(false);
        return;
      }

      setContacts(data ?? []);
      setContactCount(count ?? 0);
      setListLoading(false);
    },
    [profile?.brand_id]
  );

  const loadBatches = useCallback(async () => {
    if (!profile?.brand_id) return;
    const { data, error } = await supabase
      .from('import_batches')
      .select('id, filename, status, total_rows, inserted_rows, updated_rows, failed_rows, created_at')
      .eq('brand_id', profile.brand_id)
      // Campaign and event imports share these tables. Their rejected rows are
      // shaped differently, so listing them here would misrepresent them.
      .eq('entity', 'contacts')
      .order('created_at', { ascending: false })
      .range(0, BATCH_LIST_LIMIT - 1);

    if (error) {
      setHistoryError(humanizeDbError(error, 'load import history'));
      return;
    }
    setBatches(data ?? []);
  }, [profile?.brand_id]);

  const loadHistoryErrors = useCallback(
    async (batchId, targetPage) => {
      if (!batchId || !profile?.brand_id) return;
      setHistoryLoading(true);
      setHistoryError('');

      const from = targetPage * HISTORY_PAGE_SIZE;
      const { data, count, error } = await supabase
        .from('import_errors')
        .select('row_number, error_code, error_message, raw_row', { count: 'exact' })
        .eq('batch_id', batchId)
        .eq('brand_id', profile.brand_id)
        .order('row_number', { ascending: true })
        .range(from, from + HISTORY_PAGE_SIZE - 1);

      if (error) {
        setHistoryError(humanizeDbError(error, 'load rejected rows'));
        setHistoryRows([]);
        setHistoryLoading(false);
        return;
      }

      setHistoryRows(data ?? []);
      setHistoryCount(count ?? 0);
      setHistoryLoading(false);
    },
    [profile?.brand_id]
  );

  useEffect(() => {
    void loadContacts(page);
  }, [loadContacts, page]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    if (selectedBatchId) void loadHistoryErrors(selectedBatchId, historyPage);
  }, [loadHistoryErrors, selectedBatchId, historyPage]);

  // A new search term starts from the first page of results, not page 40 of the
  // previous term.
  useEffect(() => {
    setRejectedPage(0);
  }, [rejectedQuery]);

  function resetImport() {
    setPhase('idle');
    setFileMeta(null);
    setFileError('');
    setParsed(null);
    setAckParseErrors(false);
    setShowRejected(false);
    setRejectedQuery('');
    setRejectedPage(0);
    setProgress({ done: 0, total: 0 });
    setImportError('');
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
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
      worker: file.size > WORKER_THRESHOLD_BYTES,
      complete: (results) => {
        const fields = results.meta?.fields ?? [];
        const { map, unmapped } = buildHeaderMap(fields);

        if (!map.email) {
          setPhase('idle');
          // A campaigns file has no email column either, so naming the missing
          // column alone reads as "bad file" when the real answer is "wrong
          // page". Lead with the mismatch when the headers identify one.
          const mismatch = describeWrongFile({ fields, expected: 'contacts' });
          setFileError(
            mismatch
              ? `${mismatch} A contacts file is identified by its email column, which this one ` +
                  `does not have. Columns found: ${fields.join(', ') || 'none'}.`
              : 'No email column found. This file needs a column named email or e_mail — ' +
                  `email is what identifies a contact. Columns found: ${fields.join(', ') || 'none'}.`
          );
          return;
        }

        // Row-scoped reader failures are handed to mapRows so such a line is
        // rejected instead of being half-imported. Anything without a row index
        // is a whole-file complaint and is shown separately.
        const allParseErrors = results.errors ?? [];
        const parseIssues = new Map();
        for (const err of allParseErrors) {
          if (typeof err.row !== 'number') continue;
          parseIssues.set(dataRowToRowNumber(err.row), err.message ?? 'malformed CSV');
        }

        const rows = results.data ?? [];
        const mapped = mapRows({
          rows,
          headerMap: map,
          unmapped,
          brandId: profile.brand_id,
          brandSlug: profile.brand?.slug ?? '',
          parseIssues,
        });

        setParsed({
          headerMap: map,
          unmapped,
          delimiter: results.meta?.delimiter ?? '',
          fileWideParseErrors: allParseErrors.filter((e) => typeof e.row !== 'number'),
          rowParseErrorCount: parseIssues.size,
          mapped,
        });
        setPhase('preview');
      },
      error: (err) => {
        setPhase('idle');
        setFileError(
          `We could not read that file${err?.message ? `: ${err.message}` : '.'}`
        );
      },
    });
  }

  async function handleConfirm() {
    if (!parsed) return;

    setPhase('importing');
    setImportError('');

    const { contacts: validRows, contactRowNumbers, errors: rejectedRows, stats } = parsed.mapped;

    const errorPayload = rejectedRows.map((row) => ({
      row_number: row.rowNumber,
      raw_row: sanitizeForDiagnostics(row.rawRow ?? {}),
      error_code: row.code,
      error_message: row.message,
    }));

    const contactBatches = chunk(validRows, CONTACT_BATCH_SIZE);
    const errorBatches = chunk(errorPayload, CONTACT_BATCH_SIZE);
    // Distinct, because the same id cannot appear twice — mapRows already
    // rejects a repeated external_id within one file.
    const externalIdLookups = chunk(
      validRows.map((row) => row.external_id).filter(Boolean),
      CONTACT_BATCH_SIZE
    );
    setProgress({
      done: 0,
      total: contactBatches.length + errorBatches.length + externalIdLookups.length,
    });

    // file_checksum is deliberately left null. import_batches_brand_checksum_idx
    // is unique on (brand_id, file_checksum) where status='completed', so
    // recording it would make a legitimate second import of the same file fail
    // at the moment it completes — after the contacts were already written.
    const { data: batchRow, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        brand_id: profile.brand_id,
        uploaded_by: user.id,
        filename: fileMeta.name.slice(0, 255),
        entity: 'contacts',
        status: 'processing',
        total_rows: stats.total,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (batchError || !batchRow) {
      setPhase('preview');
      setImportError(humanizeDbError(batchError, 'create import batch'));
      return;
    }

    const batchId = batchRow.id;
    let done = 0;

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

    // An external_id already held by a DIFFERENT contact in this brand cannot be
    // written: contacts_brand_external_id_idx would refuse it with 23505 and
    // fail the whole batch. Ask the database who owns each id, then release the
    // disputed ones. Done here rather than at preview time so the answer is
    // current at the moment of writing.
    const owners = new Map();
    for (const idChunk of externalIdLookups) {
      const { data, error } = await supabase
        .from('contacts')
        .select('external_id, email')
        .eq('brand_id', profile.brand_id)
        .in('external_id', idChunk);

      if (error) {
        await failBatch(
          `${humanizeDbError(error, 'check existing contact IDs')} Nothing was imported.`
        );
        return;
      }
      for (const row of data ?? []) {
        owners.set(row.external_id, String(row.email).toLowerCase());
      }
      done += 1;
      setProgress((prev) => ({ ...prev, done }));
    }

    // Mutates validRows in place; contactBatches holds the same objects.
    const { collisions } = resolveExternalIdCollisions({
      contacts: validRows,
      rowNumbers: contactRowNumbers,
      owners,
    });

    if (collisions.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(
        `[import] ${collisions.length} contacts were imported without their external_id ` +
          'because another contact in this brand already holds it. The original value is ' +
          'kept in raw_attrs.collided_external_id.',
        collisions.slice(0, 20)
      );
    }

    // Defence in depth, NOT a substitute for sanitizing raw_row above: recording
    // rejected rows is a diagnostic side-channel, so a failure here must never
    // block contacts that would otherwise import cleanly. Failures are counted
    // and surfaced in the summary rather than swallowed.
    let errorRowsStored = 0;
    const errorLogFailures = [];

    for (let i = 0; i < errorBatches.length; i += 1) {
      const rows = errorBatches[i].map((row) => ({
        ...row,
        batch_id: batchId,
        brand_id: profile.brand_id,
      }));
      const { error } = await supabase.from('import_errors').insert(rows);
      if (error) {
        errorLogFailures.push({ group: i + 1, rows: rows.length });
        // eslint-disable-next-line no-console
        console.warn(
          `[import] could not record rejected rows (group ${i + 1} of ${errorBatches.length}, ` +
            `${rows.length} rows). Continuing with the contacts import.`,
          error
        );
      } else {
        errorRowsStored += rows.length;
      }
      done += 1;
      setProgress((prev) => ({ ...prev, done }));
    }

    let insertedRows = 0;
    let updatedRows = 0;
    let collapsedDuplicates = 0;

    for (let i = 0; i < contactBatches.length; i += 1) {
      const { rows, collapsed } = dedupeBatchByEmail(contactBatches[i]);
      collapsedDuplicates += collapsed;

      const payload = rows.map((row) => ({ ...row, source_batch_id: batchId }));
      const { data, error } = await supabase
        .from('contacts')
        .upsert(payload, { onConflict: 'brand_id,email' })
        .select('id, created_at, updated_at');

      if (error) {
        await failBatch(
          `${humanizeDbError(error, 'upsert contacts')} ` +
            `Import stopped at batch ${i + 1} of ${contactBatches.length}. ` +
            `${insertedRows + updatedRows} contacts were saved by the earlier batches; ` +
            'the rest were not. Re-running this file is safe — existing contacts are updated, not duplicated.'
        );
        return;
      }

      // A freshly inserted row has updated_at exactly equal to created_at (both
      // default to now(), one transaction timestamp). contacts_set_updated_at
      // only fires BEFORE UPDATE, so a row that already existed comes back with
      // updated_at strictly later. That is the only way to tell insert from
      // update through PostgREST, which reports both the same way.
      for (const row of data ?? []) {
        if (row.created_at === row.updated_at) insertedRows += 1;
        else updatedRows += 1;
      }

      done += 1;
      setProgress((prev) => ({ ...prev, done }));
    }

    // Released ids are recorded as warnings, not failures: these rows imported.
    // Excluded from failed_rows so import_batches_rows_balance keeps meaning
    // what it says. One row per row_number, per import_errors_batch_row_key.
    let collisionsLogged = 0;
    if (collisions.length > 0) {
      const collisionPayload = collisions
        .filter((collision) => collision.rowNumber !== null)
        .map((collision) => ({
          row_number: collision.rowNumber,
          raw_row: sanitizeForDiagnostics({
            email: collision.email,
            external_id_from_file: collision.externalId,
            already_held_by: collision.ownerEmail,
          }),
          error_code: `${WARNING_CODE_PREFIX}external_id_collision_dropped`,
          error_message:
            `external_id '${collision.externalId}' is already held by ${collision.ownerEmail}, ` +
            'so this contact was imported without it. The original value is kept in ' +
            'raw_attrs.collided_external_id.',
          batch_id: batchId,
          brand_id: profile.brand_id,
        }));

      for (const group of chunk(collisionPayload, CONTACT_BATCH_SIZE)) {
        const { error } = await supabase.from('import_errors').insert(group);
        if (error) {
          // eslint-disable-next-line no-console
          console.warn('[import] could not record external_id collisions', error);
        } else {
          collisionsLogged += group.length;
        }
      }
    }

    const { error: finalizeError } = await supabase
      .from('import_batches')
      .update({
        status: 'completed',
        inserted_rows: insertedRows,
        updated_rows: updatedRows,
        failed_rows: errorPayload.length,
        completed_at: new Date().toISOString(),
      })
      .eq('id', batchId)
      .eq('brand_id', profile.brand_id);

    setResult({
      batchId,
      total: stats.total,
      inserted: insertedRows,
      updated: updatedRows,
      failed: errorPayload.length,
      collapsed: collapsedDuplicates,
      collisions: collisions.length,
      collisionsLogged,
      finalizeWarning: finalizeError
        ? 'Your contacts were saved, but we could not record the final import summary.'
        : '',
      // failed_rows records every row excluded from the import, which is the
      // honest figure. If some of those rows could not be written to the error
      // log, say so instead of letting the two quietly disagree.
      errorLogWarning:
        errorLogFailures.length > 0
          ? `${errorPayload.length - errorRowsStored} of the ${errorPayload.length} rejected rows could not be saved for later review, so the list below is incomplete. They were still excluded from the import — no bad data was stored.`
          : '',
    });
    setPhase('done');
    setPage(0);
    void loadContacts(0);
    void loadBatches();
  }

  /**
   * Historical export pages through import_errors so the whole batch lands in
   * the file, not just the 25 rows currently on screen.
   */
  async function exportBatchErrors(batch) {
    setExporting(true);
    setHistoryError('');
    const all = [];
    let from = 0;

    for (;;) {
      const { data, error } = await supabase
        .from('import_errors')
        .select('row_number, error_message, raw_row')
        .eq('batch_id', batch.id)
        .eq('brand_id', profile.brand_id)
        .order('row_number', { ascending: true })
        .range(from, from + EXPORT_CHUNK - 1);

      if (error) {
        setHistoryError(humanizeDbError(error, 'export rejected rows'));
        setExporting(false);
        return;
      }

      all.push(...(data ?? []));
      if (!data || data.length < EXPORT_CHUNK) break;
      from += EXPORT_CHUNK;
    }

    downloadCsv(
      `rejected-${safeFilePart(batch.filename)}.csv`,
      rejectedRowsToCsv(
        all.map((row) => ({
          rowNumber: row.row_number,
          reason: row.error_message,
          rawRow: row.raw_row,
        }))
      )
    );
    setExporting(false);
  }

  // --- derived: pre-import rejected rows ------------------------------------
  // Search text is built once per parse, not per keystroke: a real file can
  // reject 9,000+ rows and re-stringifying them on every character typed would
  // stall the page.
  const rejected = useMemo(() => {
    const errors = parsed?.mapped.errors ?? [];
    return errors.map((err) => {
      // Same treatment as the database copy, so the on-screen table and the
      // downloaded CSV show <NUL> rather than an invisible byte.
      const rawRow = sanitizeForDiagnostics(err.rawRow ?? {});
      const rawJson = JSON.stringify(rawRow);
      return {
        rowNumber: err.rowNumber,
        reason: err.message,
        rawRow,
        rawJson,
        haystack: `${err.rowNumber} ${err.message} ${rawJson}`.toLowerCase(),
      };
    });
  }, [parsed]);

  const filteredRejected = useMemo(() => {
    const query = rejectedQuery.trim().toLowerCase();
    if (!query) return rejected;
    return rejected.filter((row) => row.haystack.includes(query));
  }, [rejected, rejectedQuery]);

  const rejectedPageRows = filteredRejected.slice(
    rejectedPage * REJECTED_PAGE_SIZE,
    rejectedPage * REJECTED_PAGE_SIZE + REJECTED_PAGE_SIZE
  );
  const rejectedTotalPages = Math.ceil(filteredRejected.length / REJECTED_PAGE_SIZE);

  const preview = parsed?.mapped.contacts.slice(0, 5) ?? [];
  const totalPages = contactCount === null ? 0 : Math.ceil(contactCount / CONTACTS_PAGE_SIZE);
  const historyTotalPages =
    historyCount === null ? 0 : Math.ceil(historyCount / HISTORY_PAGE_SIZE);
  const selectedBatch = batches.find((b) => b.id === selectedBatchId) ?? null;

  const rowNumberNote =
    'Row numbers count the header as row 1, so the first contact is row 2. Blank lines are skipped, so in a file with blank lines this can differ from the physical line number.';

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <BackToDashboard />
            <p className="text-sm font-medium text-slate-900">Contacts</p>
            <p className="text-xs text-slate-500">
              {profile?.brand?.name ?? 'Unknown brand'} · {profile?.role}
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        {/* ---------- upload ---------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-medium text-slate-900">Import contacts from CSV</h2>
          <p className="mb-4 text-xs text-slate-500">
            Comma, semicolon and tab separated files are all handled. Re-importing the same
            file is safe: contacts are matched on email and updated, never duplicated.
          </p>

          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              handleFile(e.dataTransfer.files?.[0]);
            }}
            className="rounded-lg border-2 border-dashed border-slate-300 bg-slate-50 px-4 py-8 text-center"
          >
            <p className="mb-3 text-sm text-slate-600">Drag a .csv file here, or</p>
            <label className="inline-block cursor-pointer rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800">
              Browse files
              <input
                ref={inputRef}
                type="file"
                accept=".csv,text/csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
            </label>
            {fileMeta && (
              <p className="mt-3 text-xs text-slate-500">
                {fileMeta.name} · {(fileMeta.size / 1024 / 1024).toFixed(2)} MB
                {fileMeta.size > WORKER_THRESHOLD_BYTES && ' · parsing in background'}
              </p>
            )}
          </div>

          {fileError && (
            <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {fileError}
            </p>
          )}

          {phase === 'parsing' && (
            <p className="mt-4 text-sm text-slate-600">Reading your file…</p>
          )}
        </section>

        {/* ---------- preview ---------- */}
        {parsed && (phase === 'preview' || phase === 'importing') && (
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="mb-3 text-sm font-medium text-slate-900">Check before importing</h2>

            <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Rows read</dt>
                <dd className="font-medium text-slate-900">{parsed.mapped.stats.total}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Ready to import</dt>
                <dd className="font-medium text-slate-900">{parsed.mapped.stats.valid}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Will be rejected</dt>
                <dd className="font-medium text-slate-900">{parsed.mapped.stats.invalid}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Separator detected</dt>
                <dd className="font-medium text-slate-900">
                  {parsed.delimiter === '\t' ? 'tab' : parsed.delimiter || 'unknown'}
                </dd>
              </div>
            </dl>

            <p className="mb-4 text-xs text-slate-500">
              Columns recognised: {Object.keys(parsed.headerMap).join(', ')}.
              {parsed.unmapped.length > 0 && (
                <>
                  {' '}
                  Kept as extra attributes (not dropped): {parsed.unmapped.join(', ')}.
                </>
              )}
            </p>

            {/* The offset is an inference, so it is stated on screen rather than
                applied quietly — the chart these dates feed is read as fact. */}
            {parsed.mapped.stats.legacyTimestamps > 0 && (
              <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                <p>
                  <span className="font-medium">
                    {parsed.mapped.stats.legacyTimestamps} row
                    {parsed.mapped.stats.legacyTimestamps === 1 ? '' : 's'}
                  </span>{' '}
                  use the older <code>DD/MM/YYYY</code> date format with no timezone. These were
                  read day-first and treated as local time (UTC+
                  {parsed.mapped.stats.legacyOffsetHours}), then stored as UTC.
                </p>
                <p className="mt-1 text-xs text-sky-800">
                  The file does not say which timezone these dates were recorded in, so this is
                  based on the brand&rsquo;s location. Signup times for these rows could be off by
                  a few hours if that assumption is wrong.
                </p>
              </div>
            )}

            {parsed.fileWideParseErrors.length > 0 && (
              <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="font-medium">This file has formatting problems:</p>
                <ul className="mt-1 list-inside list-disc">
                  {parsed.fileWideParseErrors.slice(0, 5).map((e, i) => (
                    <li key={i}>{e.message}</li>
                  ))}
                </ul>
              </div>
            )}

            {parsed.rowParseErrorCount > 0 && (
              <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p>
                  {parsed.rowParseErrorCount} line
                  {parsed.rowParseErrorCount === 1 ? '' : 's'} could not be read properly.
                  They are listed below as rejected rows and will be recorded as failures,
                  not skipped silently.
                </p>
                <label className="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={ackParseErrors}
                    onChange={(e) => setAckParseErrors(e.target.checked)}
                  />
                  I have reviewed these before importing
                </label>
              </div>
            )}

            {preview.length > 0 && (
              <div className="mb-4 overflow-x-auto">
                <p className="mb-2 text-xs text-slate-500">
                  First {preview.length} mapped row{preview.length === 1 ? '' : 's'} — check the
                  columns landed in the right place:
                </p>
                <table className="min-w-full border border-slate-200 text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">email</th>
                      <th className="px-2 py-1.5 font-medium">full_name</th>
                      <th className="px-2 py-1.5 font-medium">phone</th>
                      <th className="px-2 py-1.5 font-medium">country</th>
                      <th className="px-2 py-1.5 font-medium">city</th>
                      <th className="px-2 py-1.5 font-medium">signup_at</th>
                      <th className="px-2 py-1.5 font-medium">consent</th>
                      <th className="px-2 py-1.5 font-medium">subscribed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((row) => (
                      <tr key={row.email} className="border-t border-slate-100">
                        <td className="px-2 py-1.5">{row.email}</td>
                        <td className="px-2 py-1.5">{row.full_name ?? '—'}</td>
                        <td className="px-2 py-1.5">{row.phone ?? '—'}</td>
                        <td className="px-2 py-1.5">{row.country ?? '—'}</td>
                        <td className="px-2 py-1.5">{row.city ?? '—'}</td>
                        <td className="px-2 py-1.5">{row.signup_at ?? '—'}</td>
                        <td className="px-2 py-1.5">{String(row.consent_marketing)}</td>
                        <td className="px-2 py-1.5">{String(row.is_subscribed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* ----- why rows were rejected, as a pattern rather than 9,000
                     individual reasons to search through ----- */}
            {parsed.mapped.stats.byCode.length > 0 && (
              <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-3">
                <p className="mb-2 text-xs font-medium text-slate-700">
                  Why rows were rejected
                </p>
                <ul className="space-y-1 text-xs text-slate-600">
                  {parsed.mapped.stats.byCode.map(({ code, count }) => (
                    <li key={code} className="flex justify-between gap-4">
                      <span>{REJECTION_LABELS[code] ?? code}</span>
                      <span className="font-medium text-slate-900">{count}</span>
                    </li>
                  ))}
                </ul>

                {parsed.mapped.stats.unknownStatuses.length > 0 && (
                  <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Unrecognised status values found:{' '}
                    {parsed.mapped.stats.unknownStatuses
                      .map((s) => `'${s.value}' (${s.count} row${s.count === 1 ? '' : 's'})`)
                      .join(', ')}
                    . Known values are {KNOWN_STATUS_VALUES.join(', ')}. If one of these is
                    legitimate, it needs a deliberate mapping rather than a guess.
                  </p>
                )}

                {parsed.mapped.stats.controlChars.length > 0 && (
                  <p role="alert" className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    Control characters found in{' '}
                    {parsed.mapped.stats.controlCharRows.length} row
                    {parsed.mapped.stats.controlCharRows.length === 1 ? '' : 's'}:{' '}
                    {parsed.mapped.stats.controlChars
                      .map((c) => `${c.value} x${c.count}`)
                      .join(', ')}
                    . These bytes cannot be stored at all, so the rows were rejected rather
                    than cleaned. Row numbers:{' '}
                    {parsed.mapped.stats.controlCharRows.slice(0, 20).join(', ')}
                    {parsed.mapped.stats.controlCharRows.length > 20 &&
                      ` and ${parsed.mapped.stats.controlCharRows.length - 20} more — use the search box below for the full list.`}
                  </p>
                )}
              </div>
            )}

            {/* ----- rejected rows, still client-side only ----- */}
            {rejected.length > 0 && (
              <div className="mb-4 rounded-md border border-slate-200">
                <button
                  type="button"
                  onClick={() => setShowRejected((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm font-medium text-slate-800 hover:bg-slate-50"
                >
                  <span>
                    View {rejected.length} rejected row{rejected.length === 1 ? '' : 's'}
                  </span>
                  <span className="text-xs text-slate-500">{showRejected ? 'Hide' : 'Show'}</span>
                </button>

                {showRejected && (
                  <div className="border-t border-slate-200 px-3 py-3">
                    <p className="mb-3 text-xs text-slate-500">
                      Nothing here has been saved — these rows are from reading your file and
                      will be excluded from the import. {rowNumberNote}
                    </p>

                    <div className="mb-3 flex flex-wrap items-center gap-2">
                      <input
                        type="search"
                        value={rejectedQuery}
                        onChange={(e) => setRejectedQuery(e.target.value)}
                        placeholder="Search by email, reason or any value…"
                        className="min-w-[240px] flex-1 rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
                      />
                      <button
                        type="button"
                        onClick={() =>
                          downloadCsv(
                            `rejected-${safeFilePart(fileMeta?.name)}.csv`,
                            rejectedRowsToCsv(filteredRejected)
                          )
                        }
                        disabled={filteredRejected.length === 0}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        Download {filteredRejected.length} as CSV
                      </button>
                    </div>

                    {rejectedQuery && (
                      <p className="mb-2 text-xs text-slate-500">
                        {filteredRejected.length} of {rejected.length} rejected rows match
                        “{rejectedQuery}”. The download covers the matching rows only.
                      </p>
                    )}

                    {filteredRejected.length === 0 ? (
                      <p className="text-sm text-slate-500">No rejected rows match that search.</p>
                    ) : (
                      <>
                        <div className="overflow-x-auto">
                          <table className="min-w-full border border-slate-200 text-left text-xs">
                            <thead className="bg-slate-50 text-slate-600">
                              <tr>
                                <th className="px-2 py-1.5 font-medium">Row</th>
                                <th className="px-2 py-1.5 font-medium">Why it was rejected</th>
                                <th className="px-2 py-1.5 font-medium">Original row</th>
                              </tr>
                            </thead>
                            <tbody>
                              {rejectedPageRows.map((row) => (
                                <tr key={row.rowNumber} className="border-t border-slate-100">
                                  <td className="px-2 py-1.5 align-top">{row.rowNumber}</td>
                                  <td className="px-2 py-1.5 align-top">{row.reason}</td>
                                  <td className="px-2 py-1.5 align-top font-mono text-[11px] text-slate-500">
                                    {rawRowPreview(row.rawRow)}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
                          <span>
                            Page {rejectedPage + 1} of {Math.max(rejectedTotalPages, 1)}
                          </span>
                          <div className="flex gap-2">
                            <button
                              type="button"
                              onClick={() => setRejectedPage((p) => Math.max(p - 1, 0))}
                              disabled={rejectedPage === 0}
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Previous
                            </button>
                            <button
                              type="button"
                              onClick={() => setRejectedPage((p) => p + 1)}
                              disabled={rejectedPage + 1 >= rejectedTotalPages}
                              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              Next
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {importError && (
              <p role="alert" className="mb-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                {importError}
              </p>
            )}

            {phase === 'importing' ? (
              <p className="text-sm text-slate-600">
                Importing… {progress.done} of {progress.total} batches done. Please keep this
                page open.
              </p>
            ) : (
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => {
                    void handleConfirm();
                  }}
                  disabled={
                    parsed.mapped.stats.valid === 0 ||
                    (parsed.rowParseErrorCount > 0 && !ackParseErrors)
                  }
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Import {parsed.mapped.stats.valid} contacts
                </button>
                <button
                  type="button"
                  onClick={resetImport}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
              </div>
            )}
          </section>
        )}

        {/* ---------- summary ---------- */}
        {phase === 'done' && result && (
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="mb-3 text-sm font-medium text-slate-900">Import finished</h2>

            {result.finalizeWarning && (
              <p role="alert" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.finalizeWarning}
              </p>
            )}

            {result.errorLogWarning && (
              <p role="alert" className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.errorLogWarning}
              </p>
            )}

            <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Rows read</dt>
                <dd className="font-medium text-slate-900">{result.total}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">New contacts</dt>
                <dd className="font-medium text-slate-900">{result.inserted}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Existing updated</dt>
                <dd className="font-medium text-slate-900">{result.updated}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Rejected</dt>
                <dd className="font-medium text-slate-900">{result.failed}</dd>
              </div>
            </dl>

            {/* The four figures above do not have to sum to "rows read", and this
                says why rather than leaving the arithmetic looking broken. */}
            {result.collapsed > 0 && (
              <p className="mb-4 text-xs text-slate-500">
                {result.collapsed} row{result.collapsed === 1 ? '' : 's'} repeated an email
                already present in the same batch. The last version in the file was kept, so
                those rows produced no separate result.
              </p>
            )}

            {result.collisions > 0 && (
              <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p>
                  <span className="font-medium">{result.collisions} contact
                  {result.collisions === 1 ? '' : 's'}</span> were imported without the
                  external_id given in the file, because another contact in your brand already
                  uses that ID. These are counted as imported, not rejected.
                </p>
                <p className="mt-1 text-xs text-amber-800">
                  The ID from the file is kept on each contact for reference, and every case is
                  listed in the import history below.
                  {result.collisionsLogged < result.collisions &&
                    ` ${result.collisions - result.collisionsLogged} could not be written to that list.`}
                </p>
              </div>
            )}

            <div className="flex items-center gap-3">
              {result.failed > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedBatchId(result.batchId);
                    setHistoryPage(0);
                  }}
                  className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm text-slate-700 hover:bg-slate-50"
                >
                  View {result.failed} rejected row{result.failed === 1 ? '' : 's'}
                </button>
              )}
              <button
                type="button"
                onClick={resetImport}
                className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              >
                Import another file
              </button>
            </div>
          </section>
        )}

        {/* ---------- import history (database-backed) ---------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-1 text-sm font-medium text-slate-900">Import history</h2>
          <p className="mb-4 text-xs text-slate-500">
            Past imports for this brand. Pick one to see which rows were rejected and why —
            this is read back from the database, so it stays available after a reload.
          </p>

          {batches.length === 0 ? (
            <p className="text-sm text-slate-500">No imports yet.</p>
          ) : (
            <>
              <select
                value={selectedBatchId}
                onChange={(e) => {
                  setSelectedBatchId(e.target.value);
                  setHistoryPage(0);
                  setHistoryCount(null);
                  setHistoryRows([]);
                }}
                className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-1 focus:ring-slate-500"
              >
                <option value="">Select an import…</option>
                {batches.map((batch) => (
                  <option key={batch.id} value={batch.id}>
                    {new Date(batch.created_at).toLocaleString()} · {batch.filename} ·{' '}
                    {batch.status} · {batch.failed_rows} rejected of {batch.total_rows}
                  </option>
                ))}
              </select>

              {historyError && (
                <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
                  {historyError}
                </p>
              )}

              {selectedBatch && (
                <div className="mt-4">
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-slate-500">
                      {selectedBatch.inserted_rows} new · {selectedBatch.updated_rows} updated ·{' '}
                      {selectedBatch.failed_rows} rejected of {selectedBatch.total_rows} rows read
                    </p>
                    {historyCount > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          void exportBatchErrors(selectedBatch);
                        }}
                        disabled={exporting}
                        className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {exporting
                          ? 'Preparing download…'
                          : `Download all ${historyCount} rejected rows as CSV`}
                      </button>
                    )}
                  </div>

                  {historyLoading || historyCount === null ? (
                    <p className="text-sm text-slate-500">Loading rejected rows…</p>
                  ) : historyCount === 0 ? (
                    <p className="text-sm text-slate-500">
                      No rows were rejected in this import.
                    </p>
                  ) : (
                    <>
                      <p className="mb-2 text-xs text-slate-500">{rowNumberNote}</p>
                      <div className="overflow-x-auto">
                        <table className="min-w-full border border-slate-200 text-left text-xs">
                          <thead className="bg-slate-50 text-slate-600">
                            <tr>
                              <th className="px-2 py-1.5 font-medium">Row</th>
                              <th className="px-2 py-1.5 font-medium">Outcome</th>
                              <th className="px-2 py-1.5 font-medium">What happened</th>
                              <th className="px-2 py-1.5 font-medium">Original row</th>
                            </tr>
                          </thead>
                          <tbody>
                            {historyRows.map((row) => (
                              <tr key={row.row_number} className="border-t border-slate-100">
                                <td className="px-2 py-1.5 align-top">{row.row_number}</td>
                                {/* Not every row here is a failure: a warning
                                    records a row that imported with something
                                    dropped. Saying "rejected" for those would be
                                    a quietly wrong screen. */}
                                <td className="px-2 py-1.5 align-top">
                                  {isWarningCode(row.error_code) ? (
                                    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900">
                                      imported
                                    </span>
                                  ) : (
                                    <span className="rounded bg-red-100 px-1.5 py-0.5 text-red-900">
                                      rejected
                                    </span>
                                  )}
                                </td>
                                <td className="px-2 py-1.5 align-top">
                                  <span className="font-medium">{historyLabel(row.error_code)}</span>
                                  <span className="block text-slate-600">{row.error_message}</span>
                                </td>
                                <td className="px-2 py-1.5 align-top font-mono text-[11px] text-slate-500">
                                  {rawRowPreview(row.raw_row)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
                        <span>
                          Page {historyPage + 1} of {Math.max(historyTotalPages, 1)}
                        </span>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => setHistoryPage((p) => Math.max(p - 1, 0))}
                            disabled={historyPage === 0}
                            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Previous
                          </button>
                          <button
                            type="button"
                            onClick={() => setHistoryPage((p) => p + 1)}
                            disabled={historyPage + 1 >= historyTotalPages}
                            className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </section>

        {/* ---------- existing contacts ---------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-sm font-medium text-slate-900">Your contacts</h2>
            {contactCount !== null && (
              <p className="text-xs text-slate-500">
                {contactCount} total · excludes deleted
              </p>
            )}
          </div>

          {listError && (
            <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
              {listError}
            </p>
          )}

          {listLoading ? (
            <p className="text-sm text-slate-500">Loading contacts…</p>
          ) : contacts.length === 0 ? (
            <p className="text-sm text-slate-500">
              No contacts yet. Import a CSV above to get started.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full border border-slate-200 text-left text-xs">
                  <thead className="bg-slate-50 text-slate-600">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Email</th>
                      <th className="px-2 py-1.5 font-medium">Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contacts.map((row) => (
                      <tr key={row.id} className="border-t border-slate-100">
                        <td className="px-2 py-1.5">{row.email}</td>
                        <td className="px-2 py-1.5">{row.full_name ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="mt-3 flex items-center justify-between text-xs text-slate-600">
                <span>
                  Page {page + 1} of {Math.max(totalPages, 1)}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((p) => Math.max(p - 1, 0))}
                    disabled={page === 0}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((p) => p + 1)}
                    disabled={page + 1 >= totalPages}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </main>
    </div>
  );
}
