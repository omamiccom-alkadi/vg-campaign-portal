import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';

// ONE message for every failure. Wrong password, unknown token, revoked link,
// expired link — all identical, because anything else lets a stranger probe
// which tokens exist. The database function is built the same way: it burns a
// comparable amount of bcrypt work on a bad token so the two cases cannot be
// told apart by response time either. Do not add a more helpful message here.
const GENERIC_FAILURE = 'Invalid link or password';

const nf = new Intl.NumberFormat();
const fmt = (n) => nf.format(Number(n));

// A measured zero is a fact worth printing. An absent figure is not a zero, and
// printing it as one tells a client nobody received their campaign. The database
// returns NULL for recipient_count when no send was recorded, precisely so this
// page can tell the two apart — do not reintroduce a `?? 0` here.
const NOT_RECORDED = 'Not recorded';
const NOT_TRACKED = 'Not tracked';

export default function SharedResults() {
  const { token } = useParams();

  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('idle'); // idle | loading | ok | failed
  const [results, setResults] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setStatus('loading');

    const { data, error } = await supabase.rpc('get_shared_campaign_results', {
      p_token: token,
      p_password: password,
    });

    // Both branches land in the same place on purpose: an error and an empty
    // result are indistinguishable to the caller.
    if (error || !data || data.length === 0) {
      setStatus('failed');
      setResults(null);
      return;
    }

    setResults(data[0]);
    setStatus('ok');
  };

  if (status === 'ok' && results) {
    // Two independent questions, and conflating them is what produced the bug
    // this page was fixed for twice. A campaign can have a real recipient count
    // from the send log and still have no delivery receipts, so "was the
    // audience size recorded" cannot stand in for "was delivery tracked". The
    // database answers each one separately; read each one separately.
    const recipientsRecorded = results.recipient_count != null;
    const deliveryTracked = results.delivery_tracked === true;

    return (
      <div className="min-h-screen bg-slate-100 px-4 py-10">
        <div className="mx-auto max-w-2xl rounded-lg border border-slate-200 bg-white p-6">
          <h1 className="text-xl font-semibold text-slate-900">{results.campaign_name}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {results.campaign_status}
            {results.sent_at && ` \u00b7 sent ${new Date(results.sent_at).toLocaleDateString()}`}
          </p>

          <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Recipients</dt>
              {recipientsRecorded ? (
                <dd className="text-2xl font-semibold text-slate-900">
                  {fmt(results.recipient_count)}
                </dd>
              ) : (
                <dd className="text-lg font-medium text-slate-400">{NOT_RECORDED}</dd>
              )}
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Delivered</dt>
              {deliveryTracked ? (
                <dd className="text-2xl font-semibold text-slate-900">
                  {fmt(results.delivered_count)}
                </dd>
              ) : (
                <dd className="text-lg font-medium text-slate-400">{NOT_TRACKED}</dd>
              )}
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Opened</dt>
              <dd className="text-2xl font-semibold text-slate-900">{fmt(results.opened_count)}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Clicked</dt>
              <dd className="text-2xl font-semibold text-slate-900">
                {fmt(results.clicked_count)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Bounced</dt>
              <dd className="text-2xl font-semibold text-slate-900">
                {fmt(results.bounced_count)}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-slate-500">Unsubscribed</dt>
              <dd className="text-2xl font-semibold text-slate-900">
                {fmt(results.unsubscribed_count)}
              </dd>
            </div>
          </dl>

          {/* Wording mirrored from the counting notes inside
              get_shared_campaign_results, as that function's comment instructs.
              Two careful people could count these differently, so the page says
              which way it counted. */}
          <div className="mt-6 border-t border-slate-200 pt-4 text-xs leading-relaxed text-slate-500">
            {recipientsRecorded ? (
              <p>
                <span className="font-medium text-slate-700">Recipients</span> is the count frozen
                when the send was approved, not a later recount of the audience.
              </p>
            ) : (
              <p>
                <span className="font-medium text-slate-700">Recipients</span> is shown as
                unavailable because no audience size was recorded for this campaign &mdash; it was
                sent before this portal tracked it. Reading it as zero would be wrong: the figure
                was never captured, not measured as none.
              </p>
            )}

            {!deliveryTracked && (
              <p className="mt-2">
                <span className="font-medium text-slate-700">Delivered</span> is shown as
                unavailable for the same reason. The historical records behind this campaign list
                opens, clicks, bounces, complaints and unsubscribes, but they carry no
                per-message delivery receipts, so no delivered figure exists to report. The
                engagement figures below are real counts.
              </p>
            )}
            <p className="mt-2">
              Every other figure counts <span className="font-medium text-slate-700">distinct
              people</span>, not events: someone who opens twice is one open. A person can appear
              in more than one column &mdash; opened and clicked, for instance &mdash; so these
              figures are independent facts and are not expected to add up to the recipient count.
            </p>
            <p className="mt-2">
              Engagement figures reflect the reports the messaging provider has sent so far, so
              they are a floor rather than a final total.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-100 px-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-lg border border-slate-200 bg-white p-6"
      >
        <h1 className="text-lg font-semibold text-slate-900">Campaign results</h1>
        <p className="mt-1 text-sm text-slate-600">
          This link is password protected. Enter the password you were given.
        </p>

        <label htmlFor="password" className="mt-4 block text-sm font-medium text-slate-800">
          Password
        </label>
        <input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="off"
          required
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
        />

        {status === 'failed' && (
          <p role="alert" className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
            {GENERIC_FAILURE}
          </p>
        )}

        <button
          type="submit"
          disabled={status === 'loading'}
          className="mt-4 w-full rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:bg-slate-300"
        >
          {status === 'loading' ? 'Checking\u2026' : 'View results'}
        </button>
      </form>
    </div>
  );
}
