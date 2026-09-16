import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Papa from 'papaparse';
import BackToDashboard from '../components/BackToDashboard';
import { batchOptionLabel, fullDate } from '../lib/batchLabel';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { buildHeaderMap, chunk, dataRowToRowNumber, sanitizeForDiagnostics } from '../lib/csvImport';
import {
  CAMPAIGNS_PAGE_SIZE,
  CAMPAIGN_BATCH_SIZE,
  CAMPAIGN_COLUMN_ALIASES,
  CAMPAIGN_REJECTION_LABELS,
  CAMPAIGN_WARNING_LABELS,
  describeUnresolvedParent,
  humanizeCampaignDbError,
  mapCampaignRows,
} from '../lib/campaignImport';
import { downloadCsv, rawRowPreview, safeFilePart } from '../lib/csvDownload';
import { describeWrongFile } from '../lib/fileKind';

const HISTORY_PAGE_SIZE = 25;
const BATCH_LIST_LIMIT = 50;

// Warnings live in import_errors alongside rejections, distinguished by this
// prefix. They describe rows that DID import, so they are excluded from
// failed_rows — a dropped parent link is not a failed row. The alternative was
// keeping them in client memory, where the KIL-0007 cross-brand link would
// vanish on reload and leave no audit trail of a reference we refused.
const WARNING_CODE_PREFIX = 'warning_';

const isWarningCode = (code) => String(code ?? '').startsWith(WARNING_CODE_PREFIX);

function labelForCode(code) {
  if (isWarningCode(code)) {
    const bare = String(code).slice(WARNING_CODE_PREFIX.length);
    return CAMPAIGN_WARNING_LABELS[bare] ?? bare;
  }
  return CAMPAIGN_REJECTION_LABELS[code] ?? code;
}

function formatMoney(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toFixed(2);
}

function formatCount(value) {
  // NULL is an absence, 0 is a claim. Never render one as the other.
  return value === null || value === undefined ? '—' : Number(value).toLocaleString();
}

export default function Campaigns() {
  const { user, profile } = useAuth();

  const [phase, setPhase] = useState('idle'); // idle | parsing | preview | importing | done
  const [fileMeta, setFileMeta] = useState(null);
  const [fileError, setFileError] = useState('');
  const [parsed, setParsed] = useState(null);
  const [showRejected, setShowRejected] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);

  const [progress, setProgress] = useState({ done: 0, total: 0, label: '' });
  const [importError, setImportError] = useState('');
  const [result, setResult] = useState(null);

  const [batches, setBatches] = useState([]);
  const [selectedBatchId, setSelectedBatchId] = useState('');
  const [historyRows, setHistoryRows] = useState([]);
  const [historyCount, setHistoryCount] = useState(null);
  const [historyPage, setHistoryPage] = useState(0);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');

  const [campaigns, setCampaigns] = useState([]);
  const [campaignCount, setCampaignCount] = useState(null);
  const [page, setPage] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');

  const [sharing, setSharing] = useState('');
  const [share, setShare] = useState(null);
  const [shareError, setShareError] = useState('');
  const [copied, setCopied] = useState('');

  // Only owners get the control. create_shared_link is security invoker, so an
  // analyst's own RLS decides whether it can run — this is presentation, not
  // the protection.
  const isOwner = profile?.role === 'owner';

  // Generated in the browser with the platform CSPRNG, handed straight to
  // create_shared_link, and never stored anywhere locally. The database keeps
  // only a bcrypt hash, which is why this is the one and only time the
  // password can be read: nothing can recover it afterwards, not even us.
  // Ambiguous glyphs (0/O, 1/l/I) are left out because this gets read aloud
  // and retyped by people.
  function generatePassword() {
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = new Uint32Array(20);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
  }

  const shareCampaign = async (campaign) => {
    setSharing(campaign.id);
    setShareError('');
    setShare(null);
    setCopied('');

    const password = generatePassword();

    const { data: token, error } = await supabase.rpc('create_shared_link', {
      p_campaign_id: campaign.id,
      p_password: password,
    });

    if (error || !token) {
      setShareError(
        'Could not create a shareable link for this campaign. Nothing was shared.'
      );
      setSharing('');
      return;
    }

    setShare({
      campaignName: campaign.name,
      url: `${window.location.origin}/shared/${token}`,
      password,
    });
    setSharing('');
  };

  const copy = async (value, which) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(which);
    } catch {
      setCopied('');
    }
  };

  const inputRef = useRef(null);

  const loadCampaigns = useCallback(
    async (targetPage) => {
      if (!profile?.brand_id) return;
      setListLoading(true);
      setListError('');

      const from = targetPage * CAMPAIGNS_PAGE_SIZE;
      const { data, error, count } = await supabase
        .from('campaigns')
        .select(
          'id, external_id, name, channel, status, spend, reported_sent, reported_delivered, sent_at_utc, parent_campaign_id',
          { count: 'exact' }
        )
        .eq('brand_id', profile.brand_id)
        .order('sent_at_utc', { ascending: false, nullsFirst: false })
        .order('id', { ascending: true })
        .range(from, from + CAMPAIGNS_PAGE_SIZE - 1);

      if (error) {
        setListError(humanizeCampaignDbError(error, 'load campaigns'));
        setCampaigns([]);
      } else {
        setCampaigns(data ?? []);
        setCampaignCount(count ?? 0);
      }
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
      // Without this filter the dropdown would offer contacts imports and
      // render their rejected rows as though they were campaigns.
      .eq('entity', 'campaigns')
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
        setHistoryError(humanizeCampaignDbError(error, 'load rejected rows'));
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
    void loadCampaigns(page);
  }, [loadCampaigns, page]);

  useEffect(() => {
    void loadBatches();
  }, [loadBatches]);

  useEffect(() => {
    if (selectedBatchId) void loadHistoryErrors(selectedBatchId, historyPage);
  }, [selectedBatchId, historyPage, loadHistoryErrors]);

  const resetImport = () => {
    setPhase('idle');
    setFileMeta(null);
    setFileError('');
    setParsed(null);
    setShowRejected(false);
    setShowWarnings(false);
    setProgress({ done: 0, total: 0, label: '' });
    setImportError('');
    setResult(null);
    if (inputRef.current) inputRef.current.value = '';
  };

  const handleFile = (file) => {
    if (!file) return;
    resetImport();
    setFileMeta({ name: file.name, size: file.size });
    setPhase('parsing');

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      delimitersToGuess: [',', ';', '\t'],
      complete: (results) => {
        const fields = results.meta?.fields ?? [];
        const { map: headerMap, unmapped } = buildHeaderMap(fields, CAMPAIGN_COLUMN_ALIASES);

        if (!headerMap.external_id || !headerMap.name) {
          setPhase('idle');
          const mismatch = describeWrongFile({ fields, expected: 'campaigns' });
          setFileError(
            (mismatch ? `${mismatch} ` : '') +
              'This file needs at least a campaign ID column and a campaign name column. ' +
              `Columns found: ${fields.join(', ') || 'none'}.`
          );
          return;
        }

        const parseIssues = new Map();
        const fileWideParseErrors = [];
        for (const issue of results.errors ?? []) {
          if (typeof issue.row === 'number') {
            parseIssues.set(dataRowToRowNumber(issue.row), issue.message);
          } else {
            fileWideParseErrors.push(issue.message);
          }
        }

        const mapped = mapCampaignRows({
          rows: results.data ?? [],
          headerMap,
          unmapped,
          brandId: profile?.brand_id,
          brandSlug: profile?.brand?.slug ?? '',
          createdBy: user?.id ?? null,
          parseIssues,
        });

        setParsed({
          headerMap,
          unmapped,
          delimiter: results.meta?.delimiter ?? '',
          fileWideParseErrors,
          mapped,
        });
        setPhase('preview');
      },
      error: (error) => {
        setPhase('idle');
        setFileError(`This file could not be read: ${error.message}`);
      },
    });
  };

  /**
   * Three passes, in this order for reasons the schema forces:
   *
   *  1. Write campaigns. Rows are split into inserts and updates by looking up
   *     existing external_ids first, rather than upserting on
   *     (brand_id, external_id) — that index is PARTIAL (where external_id is
   *     not null) and PostgREST cannot express the matching ON CONFLICT WHERE
   *     clause, so the inference would fail. Inserts go in as 'draft' because
   *     campaigns_insert_own_brand forbids a campaign being born 'sent'.
   *  2. Resolve parents. parent_campaign_id is a uuid but the CSV names parents
   *     by external_id, and a parent can appear after its child, so this cannot
   *     happen until every row exists.
   *  3. Mark historical campaigns 'sent', which only the UPDATE policy allows.
   */
  const handleConfirm = async () => {
    if (!parsed || !profile?.brand_id || !user?.id) return;
    // A disabled button is presentation, not a guarantee. The refusal is
    // re-checked here so the only path to a write enforces it too.
    if (parsed.mapped.stats.brandCheck.ok === false) return;

    setPhase('importing');
    setImportError('');

    const { campaigns: validRows, errors: rejectedRows, warnings, stats } = parsed.mapped;

    const errorPayload = rejectedRows.map((row) => ({
      row_number: row.rowNumber,
      raw_row: sanitizeForDiagnostics(row.rawRow ?? {}),
      error_code: row.code,
      error_message: row.message,
    }));

    const errorBatches = chunk(errorPayload, CAMPAIGN_BATCH_SIZE);
    // An upper bound until the existence lookup says how many rows are new; it
    // is corrected below. The three fixed steps are the lookup, the parent pass
    // and the sent pass.
    setProgress({
      done: 0,
      total: errorBatches.length + chunk(validRows, CAMPAIGN_BATCH_SIZE).length + 3,
      label: 'Starting',
    });

    // file_checksum left null on purpose: import_batches_brand_checksum_idx is
    // unique on (brand_id, file_checksum) for completed batches, so recording it
    // would make a legitimate re-import fail after the campaigns were written.
    const { data: batchRow, error: batchError } = await supabase
      .from('import_batches')
      .insert({
        brand_id: profile.brand_id,
        uploaded_by: user.id,
        filename: fileMeta.name.slice(0, 255),
        entity: 'campaigns',
        status: 'processing',
        total_rows: stats.total,
        started_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (batchError || !batchRow) {
      setPhase('preview');
      setImportError(humanizeCampaignDbError(batchError, 'create import batch'));
      return;
    }

    const batchId = batchRow.id;
    let done = 0;
    const step = (label) => {
      done += 1;
      setProgress((prev) => ({ ...prev, done, label }));
    };

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

    // Diagnostic side-channel: a failure to record rejected rows must never
    // block campaigns that would otherwise import cleanly.
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
        errorLogFailures.push(i + 1);
        // eslint-disable-next-line no-console
        console.warn(`[campaign import] could not record rejected rows (group ${i + 1})`, error);
      } else {
        errorRowsStored += rows.length;
      }
      step('Recording rejected rows');
    }

    // ---- pass 1: which external_ids already exist? -------------------------
    const externalIds = validRows.map((row) => row.externalId);
    const existingByExternalId = new Map();

    for (const idChunk of chunk(externalIds, CAMPAIGN_BATCH_SIZE)) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('id, external_id')
        .eq('brand_id', profile.brand_id)
        .in('external_id', idChunk);

      if (error) {
        await failBatch(
          `${humanizeCampaignDbError(error, 'look up existing campaigns')} Nothing was saved.`
        );
        return;
      }
      for (const row of data ?? []) existingByExternalId.set(row.external_id, row.id);
    }
    step('Checking existing campaigns');

    const toInsert = validRows.filter((row) => !existingByExternalId.has(row.externalId));
    const toUpdate = validRows.filter((row) => existingByExternalId.has(row.externalId));

    setProgress((prev) => ({
      ...prev,
      total: errorBatches.length + chunk(toInsert, CAMPAIGN_BATCH_SIZE).length + 3,
    }));

    let insertedRows = 0;
    for (const group of chunk(toInsert, CAMPAIGN_BATCH_SIZE)) {
      const payload = group.map((row) => ({
        ...row.payload,
        status: 'draft',
        source_batch_id: batchId,
      }));
      const { data, error } = await supabase.from('campaigns').insert(payload).select('id, external_id');

      if (error) {
        await failBatch(
          `${humanizeCampaignDbError(error, 'insert campaigns')} ` +
            `${insertedRows} campaigns were saved before this point; the rest were not. ` +
            'Re-running this file is safe — campaigns already saved are updated, not duplicated.'
        );
        return;
      }
      for (const row of data ?? []) existingByExternalId.set(row.external_id, row.id);
      insertedRows += data?.length ?? 0;
      step('Saving new campaigns');
    }

    // Updated one row at a time: each carries different values, and 46 rows is
    // the largest real file. A bulk upsert on the primary key would re-run the
    // INSERT policy's status='draft' check against rows that are already 'sent'.
    let updatedRows = 0;
    for (const row of toUpdate) {
      const { error } = await supabase
        .from('campaigns')
        .update({ ...row.payload, source_batch_id: batchId })
        .eq('id', existingByExternalId.get(row.externalId))
        .eq('brand_id', profile.brand_id);

      if (error) {
        await failBatch(
          `${humanizeCampaignDbError(error, 'update campaigns')} ` +
            `${insertedRows} new and ${updatedRows} updated campaigns were saved before this point.`
        );
        return;
      }
      updatedRows += 1;
    }

    // ---- pass 2: parents ----------------------------------------------------
    const parentWarnings = [];
    let parentsLinked = 0;

    for (const row of validRows) {
      if (!row.parentExternalId) continue;

      const parentId = existingByExternalId.get(row.parentExternalId);
      if (!parentId) {
        // Unresolvable from this brand. RLS makes a cross-brand id and a typo
        // look identical from the client, so the message says "appears to"
        // rather than asserting which it was.
        const described = describeUnresolvedParent(
          row.parentExternalId,
          String(profile?.brand?.slug ?? '').toUpperCase()
        );
        parentWarnings.push({
          rowNumber: row.rowNumber,
          code: described.code,
          message: described.message,
          rawRow: row.rawRow,
        });
        continue;
      }

      const { error } = await supabase
        .from('campaigns')
        .update({ parent_campaign_id: parentId })
        .eq('id', existingByExternalId.get(row.externalId))
        .eq('brand_id', profile.brand_id);

      if (error) {
        // The composite FK refused the link. The campaign itself is already
        // saved and stays saved: only the optional parent reference is dropped.
        parentWarnings.push({
          rowNumber: row.rowNumber,
          code: 'parent_cross_brand',
          message:
            `the link to parent campaign '${row.parentExternalId}' was refused by the database, ` +
            'so this campaign was saved with no parent.',
          rawRow: row.rawRow,
        });
      } else {
        parentsLinked += 1;
      }
    }
    step('Linking parent campaigns');

    // ---- pass 3: historical campaigns are 'sent', not 'draft' --------------
    const sentIds = validRows
      .filter((row) => row.payload.sent_at_utc !== null)
      .map((row) => existingByExternalId.get(row.externalId))
      .filter(Boolean);

    let markedSent = 0;
    let markSentWarning = '';
    if (sentIds.length > 0) {
      const { error } = await supabase
        .from('campaigns')
        .update({ status: 'sent' })
        .eq('brand_id', profile.brand_id)
        .in('id', sentIds);

      if (error) {
        markSentWarning =
          'The campaigns were saved, but they could not be marked as already sent, so they still ' +
          'show as drafts. Re-running this file will fix that.';
        // eslint-disable-next-line no-console
        console.warn('[campaign import] could not mark campaigns as sent', error);
      } else {
        markedSent = sentIds.length;
      }
    }
    step('Marking campaigns as sent');

    // Warnings persisted so a refused parent link stays auditable. Prefixed and
    // excluded from failed_rows: these rows imported successfully.
    const allWarnings = [...warnings, ...parentWarnings];
    if (allWarnings.length > 0) {
      // import_errors_batch_row_key is unique on (batch_id, row_number), so a
      // source row gets exactly one slot. Warnings for the same row are combined
      // instead of inserted separately, which would fail with 23505 and lose the
      // whole group. Rejections never contend for the same slot: a warning is
      // only ever attached to a row that passed every rejection check.
      const byRow = new Map();
      for (const warning of allWarnings) {
        const group = byRow.get(warning.rowNumber);
        if (group) group.push(warning);
        else byRow.set(warning.rowNumber, [warning]);
      }

      const warningPayload = Array.from(byRow, ([rowNumber, group]) => ({
        row_number: rowNumber,
        raw_row: sanitizeForDiagnostics(group[0].rawRow ?? {}),
        error_code:
          group.length === 1
            ? `${WARNING_CODE_PREFIX}${group[0].code}`
            : `${WARNING_CODE_PREFIX}multiple`,
        error_message: group
          .map((warning) => `${CAMPAIGN_WARNING_LABELS[warning.code] ?? warning.code}: ${warning.message}`)
          .join(' | '),
        batch_id: batchId,
        brand_id: profile.brand_id,
      }));
      for (const group of chunk(warningPayload, CAMPAIGN_BATCH_SIZE)) {
        const { error } = await supabase.from('import_errors').insert(group);
        if (error) {
          // eslint-disable-next-line no-console
          console.warn('[campaign import] could not record warnings', error);
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
      parentsLinked,
      parentWarnings: parentWarnings.length,
      warnings: allWarnings.length,
      markedSent,
      markSentWarning,
      finalizeWarning: finalizeError
        ? 'Your campaigns were saved, but we could not record the final import summary.'
        : '',
      errorLogWarning:
        errorLogFailures.length > 0
          ? `${errorPayload.length - errorRowsStored} of the ${errorPayload.length} rejected rows could not be saved for later review, so the list below is incomplete. They were still excluded from the import.`
          : '',
    });
    setPhase('done');
    setPage(0);
    void loadCampaigns(0);
    void loadBatches();
  };

  const rejectedPreview = useMemo(() => {
    if (!parsed) return [];
    return parsed.mapped.errors.map((row) => ({
      rowNumber: row.rowNumber,
      reason: row.message,
      code: row.code,
      rawRow: sanitizeForDiagnostics(row.rawRow ?? {}),
    }));
  }, [parsed]);

  const totalPages = campaignCount === null ? 1 : Math.max(1, Math.ceil(campaignCount / CAMPAIGNS_PAGE_SIZE));
  const historyTotalPages =
    historyCount === null ? 1 : Math.max(1, Math.ceil(historyCount / HISTORY_PAGE_SIZE));

  const selectedBatch = batches.find((item) => item.id === selectedBatchId) ?? null;
  // Everything the option label drops, shown in full beside the control.
  const batchDetail = (batch) =>
    `${batch.filename} · ${fullDate(batch.created_at)} · ${batch.failed_rows ?? 0} rejected`;

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
        <header>
          <BackToDashboard />
          <h1 className="text-xl font-semibold text-slate-900">Campaigns</h1>
          <p className="mt-1 text-sm text-slate-600">
            Import historical campaign data from a CSV. Figures marked “reported” are the
            client&rsquo;s own numbers and are stored exactly as the file gives them.
          </p>
        </header>

        {/* ---------- upload ---------- */}
        {phase === 'idle' && (
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <label htmlFor="campaign-csv" className="block text-sm font-medium text-slate-900">
              Campaigns CSV
            </label>
            <input
              id="campaign-csv"
              ref={inputRef}
              type="file"
              accept=".csv,text/csv"
              onChange={(event) => handleFile(event.target.files?.[0])}
              className="mt-2 block w-full cursor-pointer rounded-md border border-slate-300 px-3 py-2 text-sm"
            />
            <p className="mt-2 text-xs text-slate-500">
              Comma, semicolon and tab separated files are all detected automatically.
            </p>
            {fileError && (
              <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {fileError}
              </p>
            )}
          </section>
        )}

        {phase === 'parsing' && (
          <section className="rounded-lg border border-slate-200 bg-white p-6 text-sm text-slate-600">
            Reading {fileMeta?.name}…
          </section>
        )}

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
            </p>

            {/* Refusal, not a warning. Nothing downstream would catch a
                wrong-brand campaigns file: brand_id comes from the session, so
                every row would be valid to the database and land in the wrong
                tenant without a single error. */}
            {parsed.mapped.stats.brandCheck.ok === false && (
              <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-3 text-sm text-red-900">
                <p className="font-medium">
                  This file looks like it belongs to {parsed.mapped.stats.brandCheck.looksLike}, not{' '}
                  {parsed.mapped.stats.brandCheck.ownCode}.
                </p>
                <p className="mt-1">
                  {parsed.mapped.stats.brandCheck.matched} of its campaign IDs are numbered for{' '}
                  {parsed.mapped.stats.brandCheck.counts.map((c) => `${c.brand} (${c.count})`).join(', ')}
                  , and none are numbered for your brand. Importing it would file another
                  brand&rsquo;s campaigns under yours, so it has been blocked.
                </p>
                <p className="mt-1 text-xs text-red-800">
                  If you meant to import this, sign in as {parsed.mapped.stats.brandCheck.looksLike}{' '}
                  and upload it there.
                </p>
              </div>
            )}

            {/* campaigns has no raw_attrs, so an unrecognised column genuinely
                cannot be kept. Say so rather than dropping it quietly. */}
            {parsed.unmapped.length > 0 && (
              <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                These columns are not recognised and <strong>will not be saved</strong>:{' '}
                {parsed.unmapped.join(', ')}. Campaigns have no free-form attribute field, so
                there is nowhere to keep them.
              </div>
            )}

            {parsed.mapped.stats.commaDecimalSpends > 0 && (
              <div className="mb-4 rounded-md border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900">
                <span className="font-medium">
                  {parsed.mapped.stats.commaDecimalSpends} spend value
                  {parsed.mapped.stats.commaDecimalSpends === 1 ? '' : 's'}
                </span>{' '}
                use a comma as the decimal point (for example <code>221,09</code>). These were read
                as {parsed.mapped.stats.commaDecimalSpends === 1 ? 'a decimal amount' : 'decimal amounts'}, so
                <code> 221,09</code> means 221.09 and not 22109.
              </div>
            )}

            {parsed.mapped.stats.willBeMarkedSent > 0 && (
              <p className="mb-4 text-xs text-slate-500">
                {parsed.mapped.stats.willBeMarkedSent} of these campaigns have a send date, so they
                will be marked as already sent rather than left as drafts.{' '}
                {parsed.mapped.stats.withParent > 0 &&
                  `${parsed.mapped.stats.withParent} reference a parent campaign, which is linked after all rows are saved.`}
              </p>
            )}

            {parsed.fileWideParseErrors.length > 0 && (
              <div role="alert" className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                <p className="font-medium">This file has formatting problems:</p>
                <ul className="mt-1 list-inside list-disc">
                  {parsed.fileWideParseErrors.slice(0, 5).map((message) => (
                    <li key={message}>{message}</li>
                  ))}
                </ul>
              </div>
            )}

            {parsed.mapped.stats.byCode.length > 0 && (
              <div className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
                <p className="font-medium text-slate-900">Why rows will be rejected</p>
                <ul className="mt-1 space-y-0.5 text-slate-700">
                  {parsed.mapped.stats.byCode.map(({ code, count }) => (
                    <li key={code}>
                      {labelForCode(code)}: <span className="font-medium">{count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* mapped preview */}
            <div className="mb-4 overflow-x-auto">
              <table className="min-w-full text-left text-xs">
                <thead className="border-b border-slate-200 text-slate-500">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Campaign ID</th>
                    <th className="px-2 py-1.5 font-medium">Name</th>
                    <th className="px-2 py-1.5 font-medium">Channel</th>
                    <th className="px-2 py-1.5 font-medium">Spend</th>
                    <th className="px-2 py-1.5 font-medium">Reported sent</th>
                    <th className="px-2 py-1.5 font-medium">Sent at</th>
                    <th className="px-2 py-1.5 font-medium">Parent</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {parsed.mapped.campaigns.slice(0, 5).map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-2 py-1.5 font-mono text-slate-700">{row.payload.external_id}</td>
                      <td className="px-2 py-1.5 text-slate-900">{row.payload.name}</td>
                      <td className="px-2 py-1.5 text-slate-700">{row.payload.channel ?? '—'}</td>
                      <td className="px-2 py-1.5 text-slate-700">{formatMoney(row.payload.spend)}</td>
                      <td className="px-2 py-1.5 text-slate-700">{formatCount(row.payload.reported_sent)}</td>
                      <td className="px-2 py-1.5 text-slate-700">{row.payload.sent_at_utc ?? '—'}</td>
                      <td className="px-2 py-1.5 font-mono text-slate-700">{row.parentExternalId ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {parsed.mapped.campaigns.length > 5 && (
                <p className="mt-1 text-xs text-slate-500">
                  Showing the first 5 of {parsed.mapped.campaigns.length}.
                </p>
              )}
            </div>

            {/* warnings: rows that import anyway */}
            {parsed.mapped.warnings.length > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setShowWarnings((prev) => !prev)}
                  className="text-sm font-medium text-slate-700 underline"
                >
                  {showWarnings ? 'Hide' : 'View'} {parsed.mapped.warnings.length} warning
                  {parsed.mapped.warnings.length === 1 ? '' : 's'}
                </button>
                <p className="mt-1 text-xs text-slate-500">
                  These rows will be imported. A warning records something the file said that we
                  did not store.
                </p>
                {showWarnings && (
                  <ul className="mt-2 space-y-1 text-xs text-slate-700">
                    {parsed.mapped.warnings.map((warning) => (
                      <li key={`${warning.rowNumber}-${warning.code}`} className="rounded bg-slate-50 px-2 py-1">
                        <span className="font-medium">Row {warning.rowNumber}</span> —{' '}
                        {CAMPAIGN_WARNING_LABELS[warning.code] ?? warning.code}: {warning.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* rejected rows */}
            {rejectedPreview.length > 0 && (
              <div className="mb-4">
                <button
                  type="button"
                  onClick={() => setShowRejected((prev) => !prev)}
                  className="text-sm font-medium text-slate-700 underline"
                >
                  {showRejected ? 'Hide' : 'View'} {rejectedPreview.length} rejected row
                  {rejectedPreview.length === 1 ? '' : 's'}
                </button>
                {showRejected && (
                  <div className="mt-2 max-h-72 overflow-auto rounded border border-slate-200">
                    <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-xs">
                      <thead className="sticky top-0 bg-slate-50 text-slate-500">
                        <tr>
                          <th className="px-2 py-1.5 font-medium">Row</th>
                          <th className="px-2 py-1.5 font-medium">Reason</th>
                          <th className="px-2 py-1.5 font-medium">Original data</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {rejectedPreview.map((row) => (
                          <tr key={row.rowNumber}>
                            <td className="px-2 py-1.5 text-slate-700">{row.rowNumber}</td>
                            <td className="px-2 py-1.5 text-slate-900">{row.reason}</td>
                            <td className="px-2 py-1.5 font-mono text-slate-500">
                              {rawRowPreview(row.rawRow)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {importError && (
              <p role="alert" className="mb-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {importError}
              </p>
            )}

            {phase === 'importing' ? (
              <div className="text-sm text-slate-600">
                {progress.label}… step {progress.done} of {progress.total}
              </div>
            ) : (
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => void handleConfirm()}
                  disabled={
                    parsed.mapped.stats.valid === 0 || parsed.mapped.stats.brandCheck.ok === false
                  }
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  Import {parsed.mapped.stats.valid} campaign
                  {parsed.mapped.stats.valid === 1 ? '' : 's'}
                </button>
                <button
                  type="button"
                  onClick={resetImport}
                  className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Choose a different file
                </button>
              </div>
            )}
          </section>
        )}

        {/* ---------- summary ---------- */}
        {phase === 'done' && result && (
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="mb-3 text-sm font-medium text-slate-900">Import finished</h2>
            <dl className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-slate-500">Rows read</dt>
                <dd className="font-medium text-slate-900">{result.total}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">New campaigns</dt>
                <dd className="font-medium text-slate-900">{result.inserted}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Updated</dt>
                <dd className="font-medium text-slate-900">{result.updated}</dd>
              </div>
              <div>
                <dt className="text-xs text-slate-500">Rejected</dt>
                <dd className="font-medium text-slate-900">{result.failed}</dd>
              </div>
            </dl>

            <p className="mb-3 text-xs text-slate-500">
              {result.inserted} + {result.updated} + {result.failed} ={' '}
              {result.inserted + result.updated + result.failed} of {result.total} rows read.
              {result.markedSent > 0 && ` ${result.markedSent} marked as already sent.`}
              {result.parentsLinked > 0 && ` ${result.parentsLinked} parent link(s) resolved.`}
            </p>

            {result.parentWarnings > 0 && (
              <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.parentWarnings} campaign{result.parentWarnings === 1 ? '' : 's'} named a
                parent campaign we could not link, so {result.parentWarnings === 1 ? 'it was' : 'they were'}{' '}
                saved with no parent. The campaigns themselves imported normally — see the warnings
                in the import history below.
              </div>
            )}

            {result.markSentWarning && (
              <p role="alert" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.markSentWarning}
              </p>
            )}
            {result.errorLogWarning && (
              <p role="alert" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.errorLogWarning}
              </p>
            )}
            {result.finalizeWarning && (
              <p role="alert" className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {result.finalizeWarning}
              </p>
            )}

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => {
                  setSelectedBatchId(result.batchId);
                  setHistoryPage(0);
                }}
                className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Review this import
              </button>
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

        {/* ---------- import history ---------- */}
        {batches.length > 0 && (
          <section className="rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="mb-3 text-sm font-medium text-slate-900">Import history</h2>
            <div className="flex flex-wrap items-end gap-3">
              {/* min-w-0 matters: as a flex item this div defaults to
                  min-width:auto, which lets a long filename in the options push
                  it wider than the screen no matter what the select says. */}
              <div className="w-full min-w-0 sm:w-auto">
                <label htmlFor="batch" className="block text-xs text-slate-500">
                  Import
                </label>
                <select
                  id="batch"
                  value={selectedBatchId}
                  onChange={(event) => {
                    setSelectedBatchId(event.target.value);
                    setHistoryPage(0);
                  }}
                  className="mt-1 box-border w-full max-w-full rounded-md border border-slate-300 px-3 py-2 text-sm sm:max-w-xl"
                >
                  <option value="">Choose an import&hellip;</option>
                  {batches.map((batch) => (
                    <option key={batch.id} value={batch.id} title={batchDetail(batch)}>
                      {batchOptionLabel(batch)}
                    </option>
                  ))}
                </select>
                {selectedBatch && (
                  <p className="mt-2 text-xs text-slate-500">{batchDetail(selectedBatch)}</p>
                )}
              </div>
              {selectedBatchId && historyRows.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const batch = batches.find((item) => item.id === selectedBatchId);
                    downloadCsv(
                      `campaign-import-${safeFilePart(batch?.filename)}.csv`,
                      Papa.unparse(
                        historyRows.map((row) => ({
                          row_number: row.row_number,
                          kind: isWarningCode(row.error_code) ? 'warning' : 'rejected',
                          code: row.error_code,
                          message: row.error_message,
                          raw_row: JSON.stringify(row.raw_row ?? {}),
                        })),
                        { columns: ['row_number', 'kind', 'code', 'message', 'raw_row'] }
                      )
                    );
                  }}
                  className="rounded-md border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Download this page
                </button>
              )}
            </div>

            {historyError && (
              <p role="alert" className="mt-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
                {historyError}
              </p>
            )}

            {selectedBatchId && (
              <div className="mt-4">
                {historyLoading ? (
                  <p className="text-sm text-slate-500">Loading…</p>
                ) : historyRows.length === 0 ? (
                  <p className="text-sm text-slate-500">
                    Nothing was rejected or flagged in this import.
                  </p>
                ) : (
                  <>
                    <div className="max-h-96 overflow-auto rounded border border-slate-200">
                      <div className="overflow-x-auto">
                      <table className="min-w-full text-left text-xs">
                        <thead className="sticky top-0 bg-slate-50 text-slate-500">
                          <tr>
                            <th className="px-2 py-1.5 font-medium">Row</th>
                            <th className="px-2 py-1.5 font-medium">Kind</th>
                            <th className="px-2 py-1.5 font-medium">Reason</th>
                            <th className="px-2 py-1.5 font-medium">Original data</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {historyRows.map((row) => (
                            <tr key={`${row.row_number}-${row.error_code}`}>
                              <td className="px-2 py-1.5 text-slate-700">{row.row_number}</td>
                              <td className="px-2 py-1.5">
                                <span
                                  className={
                                    isWarningCode(row.error_code)
                                      ? 'rounded bg-amber-100 px-1.5 py-0.5 text-amber-900'
                                      : 'rounded bg-red-100 px-1.5 py-0.5 text-red-900'
                                  }
                                >
                                  {isWarningCode(row.error_code) ? 'imported' : 'rejected'}
                                </span>
                              </td>
                              <td className="px-2 py-1.5 text-slate-900">
                                <span className="font-medium">{labelForCode(row.error_code)}</span>
                                <span className="block text-slate-600">{row.error_message}</span>
                              </td>
                              <td className="px-2 py-1.5 font-mono text-slate-500">
                                {rawRowPreview(row.raw_row)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    </div>
                    <div className="mt-2 flex items-center justify-between text-xs text-slate-500">
                      <span>
                        {historyCount} row{historyCount === 1 ? '' : 's'} flagged — page{' '}
                        {historyPage + 1} of {historyTotalPages}
                      </span>
                      <span className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => setHistoryPage((prev) => Math.max(0, prev - 1))}
                          disabled={historyPage === 0}
                          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        >
                          Previous
                        </button>
                        <button
                          type="button"
                          onClick={() => setHistoryPage((prev) => prev + 1)}
                          disabled={historyPage + 1 >= historyTotalPages}
                          className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                        >
                          Next
                        </button>
                      </span>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        {/* ---------- existing campaigns ---------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-sm font-medium text-slate-900">
            Your campaigns {campaignCount !== null && `(${campaignCount})`}
          </h2>

          {listError && (
            <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
              {listError}
            </p>
          )}

          {listLoading ? (
            <p className="text-sm text-slate-500">Loading…</p>
          ) : campaigns.length === 0 ? (
            <p className="text-sm text-slate-500">
              No campaigns yet. Import a CSV above to get started.
            </p>
          ) : (
            <>
              {shareError && (
                <p role="alert" className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  {shareError}
                </p>
              )}

              {share && (
                <div className="mb-4 rounded-md border border-amber-300 bg-amber-50 p-4">
                  <p className="text-sm font-medium text-amber-900">
                    Shareable link for &ldquo;{share.campaignName}&rdquo;
                  </p>
                  <p className="mt-1 text-xs text-amber-900">
                    Copy the password now. It is stored only as a hash, so this is the one and
                    only time it can be shown &mdash; if it is lost, share the campaign again to
                    get a new link.
                  </p>

                  <div className="mt-3 space-y-2">
                    <div>
                      <span className="block text-xs uppercase tracking-wide text-amber-800">
                        Link
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 truncate rounded border border-amber-200 bg-white px-2 py-1 text-xs">
                          {share.url}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(share.url, 'url')}
                          className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                        >
                          {copied === 'url' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>

                    <div>
                      <span className="block text-xs uppercase tracking-wide text-amber-800">
                        Password
                      </span>
                      <div className="flex items-center gap-2">
                        <code className="flex-1 rounded border border-amber-200 bg-white px-2 py-1 font-mono text-sm">
                          {share.password}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(share.password, 'password')}
                          className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100"
                        >
                          {copied === 'password' ? 'Copied' : 'Copy'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setShare(null);
                      setCopied('');
                    }}
                    className="mt-3 text-xs font-medium text-amber-900 underline"
                  >
                    Hide
                  </button>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs text-slate-500">
                    <tr>
                      <th className="px-2 py-2 font-medium">Campaign ID</th>
                      <th className="px-2 py-2 font-medium">Name</th>
                      <th className="px-2 py-2 font-medium">Channel</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 font-medium">Spend</th>
                      <th className="px-2 py-2 font-medium" title="The client's own reported figure, not derived from delivery events">
                        Reported sent
                      </th>
                      <th className="px-2 py-2 font-medium">Sent at</th>
                      {isOwner && <th className="px-2 py-2 font-medium">Share</th>}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {campaigns.map((campaign) => (
                      <tr key={campaign.id}>
                        <td className="px-2 py-2 font-mono text-xs text-slate-700">
                          {campaign.external_id ?? '—'}
                        </td>
                        <td className="px-2 py-2 text-slate-900">{campaign.name}</td>
                        <td className="px-2 py-2 text-slate-700">{campaign.channel ?? '—'}</td>
                        <td className="px-2 py-2 text-slate-700">{campaign.status}</td>
                        <td className="px-2 py-2 text-slate-700">{formatMoney(campaign.spend)}</td>
                        <td className="px-2 py-2 text-slate-700">
                          {formatCount(campaign.reported_sent)}
                        </td>
                        <td className="px-2 py-2 text-slate-700">
                          {campaign.sent_at_utc
                            ? new Date(campaign.sent_at_utc).toLocaleString()
                            : '—'}
                        </td>
                        {isOwner && (
                          <td className="px-2 py-2">
                            {campaign.status === 'sent' ? (
                              <button
                                type="button"
                                onClick={() => void shareCampaign(campaign)}
                                disabled={sharing === campaign.id}
                                className="text-xs font-medium text-slate-700 underline hover:text-slate-900 disabled:text-slate-400 disabled:no-underline"
                              >
                                {sharing === campaign.id ? 'Creating…' : 'Share results'}
                              </button>
                            ) : (
                              <span className="text-xs text-slate-400">—</span>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 flex items-center justify-between text-xs text-slate-500">
                <span>
                  Page {page + 1} of {totalPages}
                </span>
                <span className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setPage((prev) => Math.max(0, prev - 1))}
                    disabled={page === 0}
                    className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setPage((prev) => prev + 1)}
                    disabled={page + 1 >= totalPages}
                    className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
                  >
                    Next
                  </button>
                </span>
              </div>
            </>
          )}
          <p className="mt-3 text-xs text-slate-500">
            &ldquo;Reported&rdquo; figures come from the source CSV and are the client&rsquo;s own
            numbers. They are never combined with counts derived from delivery events.
          </p>
        </section>
      </div>
    </div>
  );
}
