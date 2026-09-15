import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

// Rows per read while building the audience. PostgREST caps a single response,
// so the list is paged; 1000 keeps the number of round trips sane for the
// largest brand without relying on a server setting we do not control.
const AUDIENCE_PAGE = 1000;

// Hard stop. The provider accepts 100,000 recipients per call and a send above
// that cannot be recorded against one provider_batch_id, so it is refused here
// rather than half-sent.
const MAX_RECIPIENTS = 100000;

const PREVIEW_PAGE = 25;

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(n ?? 0);

export default function Send() {
  const { profile, user } = useAuth();
  const brandId = profile?.brand_id;
  const isOwner = profile?.role === 'owner';

  const [drafts, setDrafts] = useState([]);
  const [draftsError, setDraftsError] = useState('');
  const [draftsLoading, setDraftsLoading] = useState(true);
  const [campaignId, setCampaignId] = useState('');

  // 'idle' -> 'building' -> 'ready' -> 'sending' -> 'done'
  const [phase, setPhase] = useState('idle');
  const [built, setBuilt] = useState(null);
  const [buildProgress, setBuildProgress] = useState(0);
  const [previewPage, setPreviewPage] = useState(0);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const [history, setHistory] = useState([]);

  const loadDrafts = useCallback(async () => {
    if (!brandId) return;
    setDraftsLoading(true);
    setDraftsError('');
    const { data, error: err } = await supabase
      .from('campaigns')
      .select('id, name, external_id, status')
      .eq('brand_id', brandId)
      .eq('status', 'draft')
      .order('name', { ascending: true });

    if (err) setDraftsError('Could not load campaigns.');
    else setDrafts(data ?? []);
    setDraftsLoading(false);
  }, [brandId]);

  const loadHistory = useCallback(async () => {
    if (!brandId) return;
    const { data } = await supabase
      .from('campaign_sends')
      .select(
        'id, campaign_id, status, recipient_count, provider_batch_id, dispatch_summary, dispatched_at, completed_at, error_message, is_backfill'
      )
      .eq('brand_id', brandId)
      .eq('is_backfill', false)
      .order('created_at', { ascending: false })
      .limit(10);
    setHistory(data ?? []);
  }, [brandId]);

  useEffect(() => {
    void loadDrafts();
    void loadHistory();
  }, [loadDrafts, loadHistory]);

  function reset() {
    setPhase('idle');
    setBuilt(null);
    setBuildProgress(0);
    setPreviewPage(0);
    setError('');
    setResult(null);
  }

  // ---------------------------------------------------------------------------
  // Freeze the audience
  // ---------------------------------------------------------------------------
  // Every sendable contact is read into memory and that exact array becomes
  // recipient_snapshot. This is the whole point: the number on this screen and
  // the array handed to the provider are the same object, so they cannot
  // disagree. contact_sendability, not contacts.is_contactable — the latter is
  // a generated column that cannot see an elapsed suppression window or a
  // bounce/unsubscribe event, and would overstate the audience.
  const buildAudience = async () => {
    if (!brandId || !campaignId) return;
    reset();
    setPhase('building');

    const rows = [];
    for (let page = 0; ; page += 1) {
      const from = page * AUDIENCE_PAGE;
      const { data, error: err } = await supabase
        .from('contact_sendability')
        .select('contact_id, email')
        .eq('brand_id', brandId)
        .eq('is_sendable_now', true)
        .order('contact_id', { ascending: true })
        .range(from, from + AUDIENCE_PAGE - 1);

      if (err) {
        setPhase('idle');
        setError('Could not work out who this campaign would go to. Nothing was sent.');
        return;
      }

      rows.push(...(data ?? []));
      setBuildProgress(rows.length);

      if (!data || data.length < AUDIENCE_PAGE) break;
      if (rows.length > MAX_RECIPIENTS) break;
    }

    if (rows.length > MAX_RECIPIENTS) {
      setPhase('idle');
      setError(
        `This audience is ${fmt(rows.length)} people, above the ${fmt(MAX_RECIPIENTS)} the ` +
          'provider accepts in one send. Nothing was sent.'
      );
      return;
    }

    setBuilt({
      campaignId,
      recipients: rows,
      // Generated once, here, and reused on every retry of this confirmation.
      // campaign_sends is unique on (brand_id, idempotency_key), so a
      // double-click or a retry after a dropped response collides with its own
      // earlier row instead of creating a second dispatch.
      idempotencyKey: `send-${crypto.randomUUID()}`,
    });
    setPhase('ready');
  };

  // ---------------------------------------------------------------------------
  // Confirm
  // ---------------------------------------------------------------------------
  const confirmSend = async () => {
    if (!built || !brandId || !user?.id) return;
    setPhase('sending');
    setError('');

    const snapshot = built.recipients.map((r) => r.contact_id);

    let sendId = null;

    const { data: inserted, error: insertError } = await supabase
      .from('campaign_sends')
      .insert({
        campaign_id: built.campaignId,
        brand_id: brandId,
        idempotency_key: built.idempotencyKey,
        recipient_count: snapshot.length,
        recipient_snapshot: snapshot,
        requested_by: user.id,
        // status defaults to 'pending' and is_backfill to false. Both are
        // pinned by the RLS policy anyway, which refuses any other value.
      })
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        const detail = `${insertError.message} ${insertError.details ?? ''}`;

        if (detail.includes('idempotency')) {
          // Our own earlier attempt already created this row. Pick it up and
          // carry on dispatching it rather than reporting a failure.
          const { data: mine } = await supabase
            .from('campaign_sends')
            .select('id')
            .eq('brand_id', brandId)
            .eq('idempotency_key', built.idempotencyKey)
            .maybeSingle();
          sendId = mine?.id ?? null;
        }

        if (!sendId) {
          setPhase('ready');
          setError(
            'This campaign already has a send that is in progress or finished, so a second ' +
              'one was refused by the database. Nothing was sent twice. Reload to see the ' +
              'send that exists.'
          );
          void loadHistory();
          return;
        }
      } else if (insertError.code === '42501') {
        setPhase('ready');
        setError('You do not have permission to send. Only an owner can.');
        return;
      } else {
        setPhase('ready');
        setError('Could not record this send, so nothing was sent.');
        return;
      }
    } else {
      sendId = inserted.id;
    }

    // The row exists and holds the guard slot. From here the send is the
    // function's to finish.
    const { data, error: fnError } = await supabase.functions.invoke('dispatch-send', {
      body: { sendId },
    });

    if (fnError) {
      let message = 'The send was recorded but could not be handed to the provider.';
      if (fnError.context && typeof fnError.context.json === 'function') {
        try {
          const payload = await fnError.context.json();
          if (payload?.error) message = payload.error;
        } catch {
          /* keep the generic message */
        }
      }
      setPhase('done');
      setResult({ failed: true, message, sendId });
      void loadHistory();
      void loadDrafts();
      return;
    }

    setPhase('done');
    setResult({ failed: false, sendId, ...data });
    void loadHistory();
    void loadDrafts();
  };

  const selectedDraft = useMemo(
    () => drafts.find((d) => d.id === campaignId) ?? null,
    [drafts, campaignId]
  );

  const previewSlice = useMemo(() => {
    if (!built) return [];
    const from = previewPage * PREVIEW_PAGE;
    return built.recipients.slice(from, from + PREVIEW_PAGE);
  }, [built, previewPage]);

  // ---------------------------------------------------------------------------
  // Analysts: no send controls at all.
  // ---------------------------------------------------------------------------
  // RLS refuses their INSERT and the Edge Function refuses their request, so
  // this is presentation rather than protection — but showing a button that
  // cannot work is its own kind of dishonesty.
  if (!isOwner) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="text-2xl font-semibold text-slate-900">Send a campaign</h1>
        <p className="mt-3 rounded-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700">
          Sending is limited to brand owners, so there is nothing to do on this page with your
          account. You can still see what has been sent on the{' '}
          <Link to="/dashboard" className="underline">
            dashboard
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-semibold text-slate-900">Send a campaign</h1>
      <p className="mt-1 text-sm text-slate-600">
        Real messages go to real people from this page. The count you approve is the count that
        is sent.
      </p>

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
        <label htmlFor="campaign" className="block text-sm font-medium text-slate-800">
          1. Choose a draft campaign
        </label>

        {draftsLoading && <p className="mt-2 text-sm text-slate-600">Loading&hellip;</p>}
        {draftsError && (
          <p role="alert" className="mt-2 text-sm text-red-800">
            {draftsError}
          </p>
        )}
        {!draftsLoading && !draftsError && drafts.length === 0 && (
          <p className="mt-2 text-sm text-slate-600">
            No draft campaigns. Every campaign for this brand has already been sent or is not a
            draft.
          </p>
        )}

        {drafts.length > 0 && (
          <select
            id="campaign"
            value={campaignId}
            onChange={(e) => {
              setCampaignId(e.target.value);
              reset();
            }}
            disabled={phase === 'building' || phase === 'sending'}
            className="mt-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
          >
            <option value="">Select a campaign&hellip;</option>
            {drafts.map((draft) => (
              <option key={draft.id} value={draft.id}>
                {draft.name}
                {draft.external_id ? ` (${draft.external_id})` : ''}
              </option>
            ))}
          </select>
        )}

        {campaignId && phase === 'idle' && (
          <button
            type="button"
            onClick={() => void buildAudience()}
            className="mt-4 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
          >
            Work out who this goes to
          </button>
        )}

        {phase === 'building' && (
          <p className="mt-4 text-sm text-slate-600">
            Working out the audience&hellip; {fmt(buildProgress)} people so far.
          </p>
        )}

        {error && (
          <p role="alert" className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            {error}
          </p>
        )}
      </section>

      {(phase === 'ready' || phase === 'sending') && built && (
        <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-sm font-medium text-slate-800">2. Confirm</h2>

          <p className="mt-3 text-3xl font-semibold text-slate-900">
            {fmt(built.recipients.length)}
          </p>
          <p className="text-sm text-slate-600">
            people will receive &ldquo;{selectedDraft?.name}&rdquo;.
          </p>

          <p className="mt-3 text-xs text-slate-500">
            This is every contact who is sendable right now: consent given, no suppression still
            in force, and no bounce, complaint or unsubscribe on record. This campaign has no
            narrower targeting rules, so it goes to the whole contactable audience. The list
            below is frozen as it stands &mdash; if someone unsubscribes before the messages go
            out they are dropped at that point, and the difference is recorded against this send.
          </p>

          <div className="mt-4 rounded-md border border-slate-200">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-2 py-1.5">#</th>
                  <th className="px-2 py-1.5">Email</th>
                </tr>
              </thead>
              <tbody>
                {previewSlice.map((row, index) => (
                  <tr key={row.contact_id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 text-slate-500">
                      {fmt(previewPage * PREVIEW_PAGE + index + 1)}
                    </td>
                    <td className="px-2 py-1.5">{row.email}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between border-t border-slate-200 px-2 py-1.5 text-xs">
              <span className="text-slate-600">
                {fmt(previewPage * PREVIEW_PAGE + 1)}&ndash;
                {fmt(Math.min((previewPage + 1) * PREVIEW_PAGE, built.recipients.length))} of{' '}
                {fmt(built.recipients.length)}
              </span>
              <span className="flex gap-3">
                <button
                  type="button"
                  disabled={previewPage === 0}
                  onClick={() => setPreviewPage((p) => p - 1)}
                  className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={(previewPage + 1) * PREVIEW_PAGE >= built.recipients.length}
                  onClick={() => setPreviewPage((p) => p + 1)}
                  className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                >
                  Next
                </button>
              </span>
            </div>
          </div>

          <div className="mt-4 flex gap-3">
            <button
              type="button"
              onClick={() => void confirmSend()}
              disabled={phase === 'sending' || built.recipients.length === 0}
              className="rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white hover:bg-red-800 disabled:bg-slate-300"
            >
              {phase === 'sending'
                ? 'Sending\u2026'
                : `Send to ${fmt(built.recipients.length)} people`}
            </button>
            <button
              type="button"
              onClick={reset}
              disabled={phase === 'sending'}
              className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:text-slate-400"
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {phase === 'done' && result && (
        <section
          className={`mt-6 rounded-lg border p-5 ${
            result.failed ? 'border-red-200 bg-red-50' : 'border-emerald-200 bg-emerald-50'
          }`}
        >
          <h2 className="text-lg font-medium text-slate-900">
            {result.failed ? 'This send did not complete' : 'Sent'}
          </h2>

          {result.failed && <p className="mt-2 text-sm text-red-900">{result.message}</p>}

          {result.warning && <p className="mt-2 text-sm text-amber-900">{result.warning}</p>}

          {result.dispatchSummary && (
            <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-600">Approved</dt>
                <dd className="text-lg font-semibold">{fmt(result.dispatchSummary.requested)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-600">Sent</dt>
                <dd className="text-lg font-semibold">{fmt(result.dispatchSummary.dispatched)}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-600">
                  Dropped at send
                </dt>
                <dd className="text-lg font-semibold">
                  {fmt(result.dispatchSummary.skipped_suppressed)}
                </dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-slate-600">
                  Provider accepted
                </dt>
                <dd className="text-lg font-semibold">
                  {fmt(result.dispatchSummary.provider_accepted)}
                </dd>
              </div>
            </dl>
          )}

          {result.dispatchSummary?.skipped_suppressed > 0 && (
            <p className="mt-3 text-xs text-slate-700">
              {fmt(result.dispatchSummary.skipped_suppressed)} of the people you approved were no
              longer contactable by the time the messages went out, so they were dropped. The
              approved figure above is left as you approved it rather than quietly reduced.
            </p>
          )}

          {result.providerBatchId && (
            <p className="mt-3 text-xs text-slate-600">
              Provider batch: <span className="font-mono">{result.providerBatchId}</span>
            </p>
          )}

          <button
            type="button"
            onClick={() => {
              reset();
              setCampaignId('');
            }}
            className="mt-4 rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Done
          </button>
        </section>
      )}

      <section className="mt-6 rounded-lg border border-slate-200 bg-white p-5">
        <h2 className="text-sm font-medium text-slate-800">Recent live sends</h2>
        <p className="mt-1 text-xs text-slate-500">
          Imported historical batches are not shown here &mdash; these are sends this app made.
        </p>

        {history.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">No campaigns have been sent from here yet.</p>
        ) : (
          <table className="mt-3 w-full text-left text-xs">
            <thead className="text-slate-600">
              <tr className="border-b border-slate-200">
                <th className="px-2 py-1.5">When</th>
                <th className="px-2 py-1.5">Status</th>
                <th className="px-2 py-1.5 text-right">Approved</th>
                <th className="px-2 py-1.5 text-right">Sent</th>
                <th className="px-2 py-1.5">Provider batch</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.id} className="border-b border-slate-100">
                  <td className="px-2 py-1.5">
                    {row.dispatched_at ? new Date(row.dispatched_at).toLocaleString() : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5">
                    {row.status}
                    {row.error_message && (
                      <span className="block text-slate-500">{row.error_message}</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {fmt(row.recipient_count)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {row.dispatch_summary ? fmt(row.dispatch_summary.dispatched) : '\u2014'}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-slate-500">
                    {row.provider_batch_id ?? '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
