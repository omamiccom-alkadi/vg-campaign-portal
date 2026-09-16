-- =============================================================================
-- Indexes for the two dashboard aggregates that time out at Kilele's scale
-- =============================================================================
-- Symptom: 57014 "canceling statement due to statement timeout" on Kilele's
-- Dashboard (76k contacts, 312k events). The `authenticated` role carries
-- statement_timeout = 8s, so any plan that needs more is returned as a 500.
--
-- Measured against a local fixture at Kilele's volume (76,000 contacts /
-- 312,000 events / 31 campaigns), as the authenticated role with RLS active.
-- Buffer counts rather than timings, because a local warm cache is not
-- representative of a hosted instance and block accesses are not.
--
-- =============================================================================
-- 1. campaign_performance: the actual cause
-- =============================================================================
-- The view's event lateral filters on (campaign_id, brand_id) and then counts
-- with FILTER clauses on event_type. The only campaign_id index was
-- message_events_campaign_ts_idx (campaign_id, event_timestamp desc), which
-- carries neither brand_id nor event_type -- so every matching event row had to
-- be fetched from the heap purely to read two columns the index could have
-- held. Once per campaign, 31 times over:
--
--   before: Bitmap Heap Scan, Heap Blocks: exact=209556, 209,932 buffers
--   after:  Index Only Scan,  Heap Fetches: 0,                404 buffers
--
-- A 519x reduction in block accesses, and the working set drops from the 53 MB
-- message_events heap to this 2.3 MB index. That matters more than the local
-- timing improvement (307ms -> 56ms): the old plan touched the same 53 MB
-- repeatedly across 31 nested-loop iterations, which is fine while it all fits
-- in shared_buffers and degrades into re-reading it per iteration when it does
-- not. That is why the failure was intermittent rather than constant.
--
-- event_timestamp is deliberately NOT included. The view never orders or
-- filters by it, and leaving it out is what keeps this index small enough to
-- stay cached.
create index if not exists message_events_campaign_brand_type_idx
  on public.message_events (campaign_id, brand_id, event_type)
  where campaign_id is not null;

comment on index public.message_events_campaign_brand_type_idx is
  'Covers the campaign_performance event lateral: (campaign_id, brand_id) for the join and RLS, event_type for the count FILTERs. Exists to keep that lateral index-only -- adding columns or dropping the partial predicate will push it back to heap fetches.';

-- =============================================================================
-- 2. contact_sendability: secondary, but real
-- =============================================================================
-- The NOT EXISTS probe matched message_events_suppressing_contact_idx on
-- (contact_id), which omits brand_id -- so the probe visited the heap to check
-- brand_id even though the index could have answered it.
--
-- This view has two plan shapes and the fix helps both. With enough work_mem
-- the planner hashes the whole suppressing set once; without it, the NOT EXISTS
-- runs once per contact:
--
--   hashed plan:     4,669 -> 1,554 buffers   (physical reads 1,547 -> 44)
--   per-contact plan: 128,450 -> 126,958 buffers, 62,746 probes
--                     (physical reads 2,308 -> 44, Heap Fetches 0)
--
-- Neither shape reached 8s locally (25-96ms), so this view is not believed to
-- be the primary cause of the reported timeouts. It is indexed here anyway
-- because it is the query behind the Send page's audience count, where a
-- timeout would block the send confirmation screen outright.
create index if not exists message_events_suppressing_brand_contact_idx
  on public.message_events (brand_id, contact_id)
  where event_type in ('bounce', 'bounced', 'complaint', 'unsubscribe', 'unsubscribed');

comment on index public.message_events_suppressing_brand_contact_idx is
  'Brand-scoped twin of message_events_suppressing_contact_idx, so the contact_sendability NOT EXISTS is index-only. The predicate must stay identical to the suppressing set in contact_sendability; if one gains an event type and the other does not, the probe silently falls back to a heap scan.';

-- =============================================================================
-- Considered and rejected: an index on campaign_sends (campaign_id, brand_id)
-- =============================================================================
-- The view's other lateral also has no usable index -- the only campaign_id
-- index on campaign_sends is partial on is_backfill = false, so it cannot serve
-- a lateral that must see backfilled sends. It was measured anyway:
--
--   create index campaign_sends_campaign_brand_idx
--     on public.campaign_sends (campaign_id, brand_id)
--     include (recipient_count, is_backfill);
--
-- The planner ignored it and kept the sequential scan, correctly: the table
-- holds a handful of rows per brand and fits in a single page, so 31 nested
-- scans cost 31 buffer accesses in total. It is not added, because an unused
-- index is pure write overhead. Revisit only if campaign_sends grows to a
-- point where that sequential scan shows up in a plan.
