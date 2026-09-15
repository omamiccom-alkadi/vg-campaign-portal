-- =============================================================================
-- campaign_sends.last_event_cursor — resume point for delivery-report polling
-- =============================================================================
-- The dispatcher reports delivery by polling, not by pushing:
-- GET /v1/messages/{batch_id}/events takes `since` = the last event_id already
-- processed. That resume point has to survive between invocations, and it
-- belongs on the send it describes, next to provider_batch_id.
--
-- Correctness does NOT depend on this cursor. The docs claim the stream is
-- "delivered exactly once and in order", and .cursorrules says not to believe
-- that regardless of what the docs say. So the cursor is an efficiency device
-- only: it avoids re-reading pages we have already seen. Dedupe remains the
-- unique index on (brand_id, provider_event_id) and state is still derived by
-- ordering on the payload's event_timestamp. A lost, stale or replayed cursor
-- therefore costs extra reads, never a duplicate or a wrong status.
--
-- campaign_sends_guard_immutable() needs no change: it pins the identity
-- columns, the frozen count and snapshot, and an already-set provider_batch_id,
-- then returns new. These columns stay writable, as polling requires.

alter table public.campaign_sends
  add column last_event_cursor text,
  add column last_polled_at    timestamptz;

comment on column public.campaign_sends.last_event_cursor is
  'The provider event_id last processed for this send, passed back as `since` on the next poll. An optimisation, not a guarantee: duplicate protection is the unique index on (brand_id, provider_event_id) and ordering comes from event_timestamp in the payload, so a stale or lost cursor only causes re-reads.';

comment on column public.campaign_sends.last_polled_at is
  'When delivery reports were last fetched for this send. Shown in the UI so "no new events" can be distinguished from "never checked".';
