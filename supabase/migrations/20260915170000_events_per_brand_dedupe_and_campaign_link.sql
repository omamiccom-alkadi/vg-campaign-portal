-- =============================================================================
-- message_events: per-brand dedupe + direct campaign attribution
-- =============================================================================
-- Two changes, both forced by the historical events files.
--
-- 1. provider_event_id was globally unique. The three brands reuse a single
--    'EV-' namespace: all 69,100 of Karoo's distinct event ids also appear in
--    Kilele's file, and all 940 of Marrakech's appear in both of the others.
--    Under a global constraint, whichever brand imports first consumes those
--    ids and every later brand's file is rejected wholesale as "already
--    processed" — except these are not redeliveries, they are different events
--    for different contacts on different campaigns.
--
--    A global key is also wrong for tenancy on its own terms: it lets one
--    brand's writes block another brand's, which is a cross-tenant
--    interference channel even when no data leaks.
--
-- 2. message_events could only reach a campaign through campaign_send_id, and
--    there are 6 campaign_sends in existence against 386,940 historical
--    events. Without a direct link, campaign performance cannot be derived
--    from the only engagement data we have.

-- -----------------------------------------------------------------------------
-- 1. Dedupe becomes per-brand
-- -----------------------------------------------------------------------------
-- Non-destructive in this direction: anything unique globally is necessarily
-- unique within a brand, so no existing row can violate the new constraint.
alter table public.message_events
  drop constraint message_events_provider_event_id_key;

alter table public.message_events
  add constraint message_events_brand_provider_event_key
  unique (brand_id, provider_event_id);

comment on column public.message_events.provider_event_id is
  'The provider''s own event id, stored verbatim — never prefixed or rewritten, because the live webhook sends the bare id and must hit the same key as the backfill. Unique per BRAND, not globally: the historical files prove the id space is reused across brands, and a global key would let one tenant block another tenant''s writes. A redelivery is always for the same brand, so per-brand scope still makes dedupe exact where it matters. Webhook handlers should continue to treat 23505 on this constraint as "already processed, ack 200".';

-- -----------------------------------------------------------------------------
-- 2. Direct campaign attribution
-- -----------------------------------------------------------------------------
alter table public.message_events
  add column campaign_id uuid;

-- Composite FK, so an event can only ever cite its own brand's campaign. This
-- is the structural half of brand-scoped resolution: even if the importer
-- resolved 'CT-005612' or 'KIL-0007' against the wrong brand, the database
-- refuses the row rather than filing one brand's engagement under another's.
alter table public.message_events
  add constraint message_events_campaign_fkey
  foreign key (campaign_id, brand_id)
  references public.campaigns (id, brand_id);

comment on column public.message_events.campaign_id is
  'The campaign this event belongs to, or NULL when the source file named a campaign we do not hold. Set at INSERT only — message_events_reject_update blocks every UPDATE, so this cannot be backfilled later without disabling that trigger. Where campaign_send_id is also present the two must agree; the live dispatcher path sets campaign_send_id and historical CSV backfill sets campaign_id. Nothing enforces agreement, because a per-row trigger would cost more on bulk backfill than the case is worth — importers must set exactly one.';

-- Campaign performance aggregates scan by campaign over a time window.
create index message_events_campaign_ts_idx
  on public.message_events (campaign_id, event_timestamp desc)
  where campaign_id is not null;

-- -----------------------------------------------------------------------------
-- 3. Audit parity with contacts and campaigns
-- -----------------------------------------------------------------------------
-- Same pattern as contacts.source_batch_id and campaigns.source_batch_id.
-- Without it there is no way to ask which upload produced a given event, and
-- 386,940 rows is a lot of history to leave unattributed.
alter table public.message_events
  add column source_batch_id uuid;

alter table public.message_events
  add constraint message_events_source_batch_fkey
  foreign key (source_batch_id, brand_id)
  references public.import_batches (id, brand_id);

comment on column public.message_events.source_batch_id is
  'The import batch that loaded this event, or NULL for events the live webhook delivered. Composite FK on (id, brand_id), so an event can only cite its own brand''s batch.';

create index message_events_source_batch_idx
  on public.message_events (source_batch_id)
  where source_batch_id is not null;
