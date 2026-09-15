import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabaseClient';

const SIGNUP_WINDOW_DAYS = 30;
const CAMPAIGN_PAGE_SIZE = 25;

// Ceiling on the signup rows pulled back for client-side grouping. PostgREST
// cannot GROUP BY, so the dates are bucketed here; this cap stops a brand with
// an unusually busy month from dragging a whole page load down. If it is ever
// hit the UI says so rather than quietly charting a partial month.
const SIGNUP_ROW_CAP = 20000;

const nf = new Intl.NumberFormat();
const fmt = (n) => (n === null || n === undefined ? '\u2014' : nf.format(n));

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

export default function Dashboard() {
  const { profile, signOut } = useAuth();
  const brandId = profile?.brand_id;

  const [totals, setTotals] = useState({ contacts: null, sendable: null });
  const [totalsError, setTotalsError] = useState('');
  const [totalsLoading, setTotalsLoading] = useState(true);

  const [signups, setSignups] = useState(null);
  const [signupsError, setSignupsError] = useState('');
  const [signupsLoading, setSignupsLoading] = useState(true);
  const [latestSignup, setLatestSignup] = useState(null);
  const [signupsCapped, setSignupsCapped] = useState(false);

  const [campaigns, setCampaigns] = useState([]);
  const [campaignCount, setCampaignCount] = useState(0);
  const [campaignPage, setCampaignPage] = useState(0);
  const [campaignsError, setCampaignsError] = useState('');
  const [campaignsLoading, setCampaignsLoading] = useState(true);

  // ---- 1 & 2: audience size -------------------------------------------------
  useEffect(() => {
    if (!brandId) return;
    let cancelled = false;

    (async () => {
      setTotalsLoading(true);
      setTotalsError('');

      const [all, sendable] = await Promise.all([
        supabase
          .from('contacts')
          .select('id', { count: 'exact', head: true })
          .eq('brand_id', brandId),
        // contact_sendability, NOT contacts.is_contactable. is_contactable is a
        // generated column and can only see same-row fields, so it knows
        // nothing about suppressed_until having elapsed or about a bounce or
        // unsubscribe event. Counting it alone would overstate the audience.
        supabase
          .from('contact_sendability')
          .select('contact_id', { count: 'exact', head: true })
          .eq('brand_id', brandId)
          .eq('is_sendable_now', true),
      ]);

      if (cancelled) return;

      if (all.error || sendable.error) {
        setTotalsError('Could not load audience figures.');
      } else {
        setTotals({ contacts: all.count ?? 0, sendable: sendable.count ?? 0 });
      }
      setTotalsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [brandId]);

  // ---- 3: signups per day ---------------------------------------------------
  useEffect(() => {
    if (!brandId) return;
    let cancelled = false;

    (async () => {
      setSignupsLoading(true);
      setSignupsError('');

      const since = new Date();
      since.setUTCDate(since.getUTCDate() - (SIGNUP_WINDOW_DAYS - 1));
      since.setUTCHours(0, 0, 0, 0);

      const [window, latest] = await Promise.all([
        supabase
          .from('contacts')
          .select('signup_at')
          .eq('brand_id', brandId)
          .gte('signup_at', since.toISOString())
          .limit(SIGNUP_ROW_CAP),
        // The seed data's signups are historical, so the last 30 days can
        // legitimately be empty. Naming the most recent signup turns a blank
        // chart into a fact instead of a suspected bug.
        supabase
          .from('contacts')
          .select('signup_at')
          .eq('brand_id', brandId)
          .not('signup_at', 'is', null)
          .order('signup_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      if (cancelled) return;

      if (window.error) {
        setSignupsError('Could not load signups.');
        setSignupsLoading(false);
        return;
      }

      const counts = new Map();
      for (const row of window.data ?? []) {
        if (!row.signup_at) continue;
        const key = dayKey(new Date(row.signup_at));
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      const days = [];
      for (let i = 0; i < SIGNUP_WINDOW_DAYS; i += 1) {
        const date = new Date(since);
        date.setUTCDate(since.getUTCDate() + i);
        const key = dayKey(date);
        days.push({ key, count: counts.get(key) ?? 0 });
      }

      setSignups(days);
      setSignupsCapped((window.data?.length ?? 0) >= SIGNUP_ROW_CAP);
      setLatestSignup(latest.error ? null : latest.data?.signup_at ?? null);
      setSignupsLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [brandId]);

  // ---- 4: campaign performance ---------------------------------------------
  const loadCampaigns = useCallback(
    async (page) => {
      if (!brandId) return;
      setCampaignsLoading(true);
      setCampaignsError('');

      const from = page * CAMPAIGN_PAGE_SIZE;
      const { data, error, count } = await supabase
        .from('campaign_performance')
        .select('*', { count: 'exact' })
        .eq('brand_id', brandId)
        .order('sent_at_utc', { ascending: false, nullsFirst: false })
        .order('name', { ascending: true })
        .range(from, from + CAMPAIGN_PAGE_SIZE - 1);

      if (error) {
        setCampaignsError(
          error.code === '42P01' || error.code === 'PGRST205'
            ? 'This section needs a database update that has not been applied yet ' +
                '(the campaign_performance view). Run the pending migration, then reload.'
            : 'Could not load campaign performance.'
        );
        setCampaigns([]);
      } else {
        setCampaigns(data ?? []);
        setCampaignCount(count ?? 0);
      }
      setCampaignsLoading(false);
    },
    [brandId]
  );

  useEffect(() => {
    void loadCampaigns(campaignPage);
  }, [loadCampaigns, campaignPage]);

  const peakSignups = useMemo(
    () => (signups ? Math.max(1, ...signups.map((d) => d.count)) : 1),
    [signups]
  );
  const windowTotal = useMemo(
    () => (signups ? signups.reduce((sum, d) => sum + d.count, 0) : 0),
    [signups]
  );

  return (
    <div className="min-h-screen bg-slate-100">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Client Campaign Portal</p>
            <p className="text-xs text-slate-500">
              {profile?.brand?.name ?? 'Unknown brand'} &middot; {profile?.role}
            </p>
          </div>
          <div className="flex items-center gap-4 text-sm">
            <Link to="/contacts" className="text-slate-700 hover:underline">
              Contacts
            </Link>
            <Link to="/campaigns" className="text-slate-700 hover:underline">
              Campaigns
            </Link>
            <Link to="/events" className="text-slate-700 hover:underline">
              Events
            </Link>
            <Link to="/sends" className="text-slate-700 hover:underline">
              Sends
            </Link>
            <button
              type="button"
              onClick={() => {
                void signOut();
              }}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-slate-700 hover:bg-slate-50"
            >
              Sign out
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {/* ---- 1 & 2: audience ------------------------------------------- */}
        <section className="mb-8 grid gap-4 sm:grid-cols-2">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Total customers</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">
              {totalsLoading ? '\u2026' : fmt(totals.contacts)}
            </p>
            <p className="mt-1 text-xs text-slate-500">Every contact held for this brand.</p>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <p className="text-xs uppercase tracking-wide text-slate-500">Contactable customers</p>
            <p className="mt-1 text-3xl font-semibold text-slate-900">
              {totalsLoading ? '\u2026' : fmt(totals.sendable)}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              Sendable right now: consent given, no suppression still in force, and no bounce,
              complaint or unsubscribe on record.
            </p>
          </div>

          {totalsError && (
            <p role="alert" className="text-sm text-red-800 sm:col-span-2">
              {totalsError}
            </p>
          )}
        </section>

        {/* ---- 3: signups per day ---------------------------------------- */}
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-5">
          <div className="mb-1 flex items-baseline justify-between">
            <h2 className="text-lg font-medium text-slate-900">Signups, last 30 days</h2>
            {!signupsLoading && !signupsError && (
              <span className="text-sm text-slate-600">{fmt(windowTotal)} in total</span>
            )}
          </div>
          <p className="mb-4 text-xs text-slate-500">
            By signup date from the source file. Contacts whose file gave no signup date are not
            counted here.
          </p>

          {signupsLoading && <p className="text-sm text-slate-600">Loading&hellip;</p>}
          {signupsError && (
            <p role="alert" className="text-sm text-red-800">
              {signupsError}
            </p>
          )}

          {!signupsLoading && !signupsError && windowTotal === 0 && (
            <p className="text-sm text-slate-600">
              No signups in the last 30 days.
              {latestSignup
                ? ` The most recent signup on record is ${new Date(latestSignup).toLocaleDateString()}, which is outside this window.`
                : ' No contact for this brand has a signup date.'}
            </p>
          )}

          {!signupsLoading && !signupsError && windowTotal > 0 && (
            <>
              {signupsCapped && (
                <p className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                  Only the first {fmt(SIGNUP_ROW_CAP)} signups in this window were read, so the
                  bars below are a floor, not a total.
                </p>
              )}
              <div className="flex h-40 items-end gap-1">
                {signups.map((day) => (
                  <div
                    key={day.key}
                    className="flex-1"
                    title={`${day.key}: ${fmt(day.count)} signup${day.count === 1 ? '' : 's'}`}
                  >
                    <div
                      className="w-full rounded-t bg-slate-800"
                      style={{ height: `${(day.count / peakSignups) * 100}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 flex justify-between text-xs text-slate-500">
                <span>{signups[0]?.key}</span>
                <span>peak {fmt(peakSignups)}/day</span>
                <span>{signups[signups.length - 1]?.key}</span>
              </div>
            </>
          )}
        </section>

        {/* ---- 4: campaign performance ----------------------------------- */}
        <section className="rounded-lg border border-slate-200 bg-white p-5">
          <h2 className="text-lg font-medium text-slate-900">Campaign performance</h2>
          <p className="mb-4 mt-1 text-xs text-slate-500">
            Three independent figures per campaign, shown side by side and not combined. They
            disagree for most campaigns, and nothing in the data says which is right.
          </p>

          {campaignsLoading && <p className="text-sm text-slate-600">Loading&hellip;</p>}
          {campaignsError && (
            <p role="alert" className="text-sm text-red-800">
              {campaignsError}
            </p>
          )}
          {!campaignsLoading && !campaignsError && campaigns.length === 0 && (
            <p className="text-sm text-slate-600">
              No campaigns yet. Import a campaigns CSV on the{' '}
              <Link to="/campaigns" className="underline">
                Campaigns
              </Link>{' '}
              page.
            </p>
          )}

          {campaigns.length > 0 && (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs text-slate-600">
                    <tr className="border-b border-slate-200">
                      <th className="px-2 py-2 font-medium">Campaign</th>
                      <th className="px-2 py-2 font-medium">Status</th>
                      <th className="px-2 py-2 text-right font-medium">
                        Reported sent
                        <span className="block font-normal text-slate-400">from campaign file</span>
                      </th>
                      <th className="px-2 py-2 text-right font-medium">
                        Send-log recipients
                        <span className="block font-normal text-slate-400">from send log</span>
                      </th>
                      <th className="px-2 py-2 text-right font-medium">
                        Events held
                        <span className="block font-normal text-slate-400">opens / clicks</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaigns.map((row) => (
                      <tr key={row.campaign_id} className="border-b border-slate-100">
                        <td className="px-2 py-2">
                          <span className="font-medium text-slate-900">{row.name}</span>
                          {row.external_id && (
                            <span className="block font-mono text-xs text-slate-500">
                              {row.external_id}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-slate-700">{row.status}</td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {fmt(row.reported_sent)}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {row.backfill_recipients > 0 || row.live_recipients > 0 ? (
                            <>
                              {fmt(row.backfill_recipients + row.live_recipients)}
                              <span className="block text-xs font-normal text-slate-500">
                                {row.backfill_recipients > 0 && row.live_recipients > 0
                                  ? `${fmt(row.backfill_recipients)} imported, ${fmt(row.live_recipients)} live`
                                  : row.backfill_recipients > 0
                                    ? `${fmt(row.backfill_batches)} imported batch${row.backfill_batches === 1 ? '' : 'es'}`
                                    : 'live send'}
                              </span>
                            </>
                          ) : (
                            <span className="text-slate-400">no send logged</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {fmt(row.events_total)}
                          {row.events_total > 0 && (
                            <span className="block text-xs font-normal text-slate-500">
                              {fmt(row.event_opens)} / {fmt(row.event_clicks)}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                &ldquo;Reported sent&rdquo; is the source file&rsquo;s own claim.
                &ldquo;Send-log recipients&rdquo; is the frozen count from each send batch.
                &ldquo;Events held&rdquo; counts the delivery receipts actually stored, which is a
                floor on engagement rather than a total &mdash; it only includes receipts the
                provider sent us.
              </p>

              {campaignCount > CAMPAIGN_PAGE_SIZE && (
                <div className="mt-3 flex items-center justify-between text-sm">
                  <span className="text-slate-600">
                    {fmt(campaignPage * CAMPAIGN_PAGE_SIZE + 1)}&ndash;
                    {fmt(Math.min((campaignPage + 1) * CAMPAIGN_PAGE_SIZE, campaignCount))} of{' '}
                    {fmt(campaignCount)}
                  </span>
                  <span className="flex gap-3">
                    <button
                      type="button"
                      disabled={campaignPage === 0}
                      onClick={() => setCampaignPage((p) => p - 1)}
                      className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                    >
                      Previous
                    </button>
                    <button
                      type="button"
                      disabled={(campaignPage + 1) * CAMPAIGN_PAGE_SIZE >= campaignCount}
                      onClick={() => setCampaignPage((p) => p + 1)}
                      className="text-slate-700 underline disabled:text-slate-300 disabled:no-underline"
                    >
                      Next
                    </button>
                  </span>
                </div>
              )}
            </>
          )}
        </section>
      </main>
    </div>
  );
}
