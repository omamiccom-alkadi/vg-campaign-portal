-- =============================================================================
-- campaign_performance — one row per campaign, three figures kept apart
-- =============================================================================
-- The dashboard needs per-campaign totals from three tables. PostgREST cannot
-- GROUP BY, so the alternative was ~50 count(head) round trips per page load,
-- each one a separate HTTP request. This is one query instead.
--
-- The columns are deliberately NOT reconciled into a single "sent" number. The
-- three sources disagree for every campaign in the seed data — for Kilele's
-- seven backfilled batches the send log differs from the campaign's own
-- reported_sent by -8% to +11%, in both directions — and there is no basis for
-- choosing between them. Averaging or coalescing would manufacture a figure
-- no source supports, which is the "quietly wrong number" the brief forbids.
-- The UI labels each column with where it came from.
--
-- security_invoker = on, so the caller's RLS on campaigns, campaign_sends and
-- message_events applies exactly as it would to a direct query. Without it the
-- view would run as its owner and hand every brand's totals to every caller.

create or replace view public.campaign_performance
with (security_invoker = on) as
select
  c.id                as campaign_id,
  c.brand_id,
  c.external_id,
  c.name,
  c.status,
  c.sent_at_utc,
  c.spend,

  -- Source 1: the campaign CSV's own claim.
  c.reported_sent,
  c.reported_opens,
  c.reported_clicks,

  -- Source 2: the send log. Split by origin because a live send and an
  -- imported historical batch are not the same kind of evidence, and summing
  -- them would hide which is which.
  coalesce(s.backfill_recipients, 0) as backfill_recipients,
  coalesce(s.live_recipients, 0)     as live_recipients,
  coalesce(s.backfill_batches, 0)    as backfill_batches,

  -- Source 3: the events actually held. Both vocabularies are counted: the
  -- historical CSV uses open/click/bounce/unsubscribe and the live webhook
  -- uses opened/bounced/unsubscribed, and a campaign can legitimately carry
  -- both if it was backfilled and then kept running.
  coalesce(e.events_total, 0)  as events_total,
  coalesce(e.event_opens, 0)   as event_opens,
  coalesce(e.event_clicks, 0)  as event_clicks,
  coalesce(e.event_bounces, 0) as event_bounces
from public.campaigns c
left join lateral (
  select
    sum(cs.recipient_count) filter (where cs.is_backfill)           as backfill_recipients,
    sum(cs.recipient_count) filter (where not cs.is_backfill)       as live_recipients,
    count(*)                filter (where cs.is_backfill)           as backfill_batches
  from public.campaign_sends cs
  where cs.campaign_id = c.id
    and cs.brand_id    = c.brand_id
) s on true
left join lateral (
  -- Uses message_events_campaign_ts_idx, which is partial on
  -- campaign_id is not null — exactly the rows this can match.
  select
    count(*)                                                          as events_total,
    count(*) filter (where me.event_type in ('open', 'opened'))        as event_opens,
    count(*) filter (where me.event_type = 'click')                    as event_clicks,
    count(*) filter (where me.event_type in ('bounce', 'bounced'))     as event_bounces
  from public.message_events me
  where me.campaign_id = c.id
    and me.brand_id    = c.brand_id
) e on true;

comment on view public.campaign_performance is
  'Per-campaign totals from three independent sources, held apart on purpose: reported_* is the source CSV''s own claim, *_recipients comes from campaign_sends, and event_* is derived from message_events. They disagree for every campaign in the seed data and must never be combined into one number — present them side by side, captioned with their source.';

grant select on public.campaign_performance to authenticated;
