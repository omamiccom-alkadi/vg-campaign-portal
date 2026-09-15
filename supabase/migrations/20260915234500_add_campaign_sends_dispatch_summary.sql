-- =============================================================================
-- campaign_sends.dispatch_summary — what actually happened at send time
-- =============================================================================
-- The initial schema promised this and never gave it a home:
--
--     "if a contact unsubscribes between confirmation and dispatch the Edge
--      Function filters at send time and records the difference, but the number
--      shown on the confirmation screen stays the number the user saw."
--
-- recipient_count and recipient_snapshot are frozen at confirmation and must
-- stay that way, so the difference cannot be recorded by amending them. Without
-- somewhere else to put it, "filters at send time" would be invisible: the row
-- would read as though every approved recipient was messaged.
--
-- NO CHANGE IS NEEDED TO campaign_sends_guard_immutable(). That trigger is
-- column-specific and ends in a plain `return new`: it rejects changes to
-- campaign_id/brand_id/idempotency_key, changes to
-- recipient_count/recipient_snapshot, and overwriting a non-null
-- provider_batch_id. It does not lock the row, so status, dispatched_at,
-- completed_at, error_message and this column remain writable after insert —
-- which is required, because the summary is only knowable once the provider
-- has answered.

alter table public.campaign_sends
  add column dispatch_summary jsonb
    check (dispatch_summary is null or jsonb_typeof(dispatch_summary) = 'object');

comment on column public.campaign_sends.dispatch_summary is
  'What the dispatcher was actually asked to send, versus what the owner approved. NULL until dispatch is attempted. Keys: requested (= recipient_count, the frozen approved figure), dispatched (how many were handed to the provider), skipped_suppressed (approved but no longer sendable when dispatch ran), skipped_not_in_brand (ids in the snapshot that do not belong to this brand - always 0 unless a client was tampered with), provider_accepted, provider_rejected. requested is never recalculated: it is copied from the frozen count so the gap between approval and delivery is legible in one row without a join.';
