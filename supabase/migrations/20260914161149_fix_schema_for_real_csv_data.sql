-- =============================================================================
-- fix_schema_for_real_csv_data
-- =============================================================================
-- REVIEW ONLY. Not applied.
--
-- Aligns the schema with the real client CSV vocabulary, plus the live
-- dispatcher's documented webhook vocabulary.
--
-- -----------------------------------------------------------------------------
-- EVENT VOCABULARY — VERIFIED AGAINST THE DISPATCHER, NOT GUESSED
-- -----------------------------------------------------------------------------
-- GET https://dispatcher-production-72fc.up.railway.app/v1/docs
--   "VG Messaging Dispatcher", version 1.4.0
--   "event_types": ["delivered", "bounced", "opened", "unsubscribed"]
--
-- That list does NOT match the assumption in the change request:
--   * 'failed' is NOT a dispatcher event type. It has been LEFT OUT of the
--     CHECK rather than added on spec. Nothing would ever write it, and an
--     allowed-but-impossible value invites a dashboard column that is
--     permanently zero.
--   * 'bounced', 'opened' and 'unsubscribed' ARE dispatcher event types and
--     are the past-tense twins of the CSV's 'bounce', 'open', 'unsubscribe'.
--     Both spellings are therefore allowed, because both will really arrive.
--   * 'click' and 'complaint' appear only in the historical CSVs; the
--     dispatcher has no equivalent. They stay allowed for the backfill.
--
-- The two vocabularies are kept as-is rather than normalised on write so the
-- stored event matches its source byte-for-byte and the raw payload stays
-- auditable. Severity ranking collapses the synonyms — see event_severity().
--
-- ALSO NOTED: /v1/docs claims "every event is delivered exactly once and in
-- order". Per .cursorrules that claim is not to be trusted, and nothing here
-- relies on it: dedupe is still the provider_event_id unique constraint, and
-- ordering is still event_timestamp from the payload.
--
-- -----------------------------------------------------------------------------
-- SIGNED OFF SEPARATELY (.cursorrules: ask before touching idempotency
-- constraints or the campaign_sends table)
-- -----------------------------------------------------------------------------
--   * campaign_sends_one_active_per_campaign_idx is rescoped to live sends so
--     a multi-batch historical campaign can be backfilled. Section 8.
--   * contacts.unsubscribed_at / hard_bounced_at / suppressed_at are dropped.
--     Two parallel suppression mechanisms is exactly the disagreeing-signal
--     risk .cursorrules warns about; contact_sendability.is_sendable_now is
--     the single source of truth from here. Section 5.
--     Verified before dropping: the only references anywhere in the repo are
--     the initial migration that creates them and its snapshot at schema.sql.
--     No Edge Function, import script or test reads them.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Preflight
-- -----------------------------------------------------------------------------
-- The enum -> text conversion below carries no data migration, and the new
-- CHECK rejects every value the old enum allowed ('queued', 'sent', 'read',
-- 'failed', 'bounced'...). If rows exist, this migration would either fail
-- noisily on the CHECK or quietly strand rows in a vocabulary nothing reads.
-- Stop instead.
do $$
begin
  if exists (select 1 from public.message_events) then
    raise exception
      'message_events contains % row(s). This migration assumes an empty table; write a data migration mapping the old enum values to the new vocabulary first.',
      (select count(*) from public.message_events)
      using errcode = 'check_violation';
  end if;
end;
$$;

-- Section 5 drops unsubscribed_at / hard_bounced_at / suppressed_at. That is
-- safe only while no contact actually carries state in them; otherwise the
-- drop silently re-opens messaging to people already suppressed.
--
-- Guarding on "these columns are all NULL" rather than "the table is empty" on
-- purpose: it blocks exactly when real state would be lost, and does not
-- refuse a table that merely has unsuppressed contacts in it.
do $$
declare
  v_stranded bigint;
begin
  select count(*) into v_stranded
  from public.contacts
  where unsubscribed_at is not null
     or hard_bounced_at is not null
     or suppressed_at   is not null;

  if v_stranded > 0 then
    raise exception
      '% contact(s) carry suppression state in unsubscribed_at/hard_bounced_at/suppressed_at. Dropping those columns would silently re-open messaging to them. Backfill consent_marketing/deleted_at/suppressed_until first.',
      v_stranded
      using errcode = 'check_violation';
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 1. Drop dependents that block the column changes
-- -----------------------------------------------------------------------------
-- contact_latest_status reads both message_events.event_type and
-- contacts.is_contactable, so it has to go before either column is altered.
-- It is rebuilt in section 8 — including its security_invoker setting, without
-- which the view would silently bypass RLS and leak every brand's events.
drop view if exists public.contact_latest_status;

-- =============================================================================
-- 2. message_events.event_type: enum -> text + CHECK
-- =============================================================================
alter table public.message_events
  alter column event_type type text using event_type::text;

alter table public.message_events
  add constraint message_events_event_type_check
  check (event_type in (
    -- Historical client CSV vocabulary
    'open',
    'click',
    'bounce',
    'complaint',
    'unsubscribe',
    -- Live dispatcher vocabulary, per /v1/docs v1.4.0 event_types
    'delivered',
    'bounced',
    'opened',
    'unsubscribed'
  ));

comment on column public.message_events.event_type is
  'Free text constrained by CHECK. Two vocabularies coexist: the historical CSVs use open/click/bounce/complaint/unsubscribe, the live dispatcher uses delivered/bounced/opened/unsubscribed. Use public.event_severity() to compare across them.';

-- Nothing references the enum any more.
drop type if exists public.message_event_type;

-- =============================================================================
-- 3. Event severity ranking
-- =============================================================================
-- Single source of truth for "which event wins". Defined once here so the
-- view, the sendability check and any future report cannot drift apart.
--
-- Lower number = more severe = stickier. A later low-severity event must never
-- override an earlier high-severity one: an 'open' arriving after a
-- 'complaint' does not make someone contactable again.
--
--   1 complaint    legal/compliance signal, never overridden
--   2 unsubscribe  explicit opt-out
--   3 bounce       technical delivery failure
--   4 click        engagement
--   5 open         engagement, weakest of the requested five
--   6 delivered    NOT in the requested ranking, but it is a permitted value
--                  and every permitted value needs a rank. Ranked below the
--                  engagement signals because it is pure transport progress:
--                  a delivery receipt must never displace a click or an open.
--  99 unknown      fail-safe. Unreachable while the CHECK holds; if a value is
--                  ever added to the CHECK and not to this function it sorts
--                  last instead of silently outranking a complaint.
--
-- SET search_path is pinned even though the body only touches literals: a
-- LANGUAGE SQL function with a quoted body is re-parsed at execution, so
-- operator resolution is not frozen at creation time. Cost is that the
-- function will not inline; at this row count that is not worth trading away.
create or replace function public.event_severity(p_event_type text)
returns integer
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_event_type
    when 'complaint'    then 1
    when 'unsubscribe'  then 2
    when 'unsubscribed' then 2
    when 'bounce'       then 3
    when 'bounced'      then 3
    when 'click'        then 4
    when 'open'         then 5
    when 'opened'       then 5
    when 'delivered'    then 6
    else 99
  end;
$$;

revoke execute on function public.event_severity(text) from public;
grant execute on function public.event_severity(text) to authenticated;

-- The suppressing set, spelled out once. Both vocabularies, because a live
-- 'unsubscribed' from the dispatcher must suppress exactly as hard as an
-- 'unsubscribe' from the CSV backfill.
create index message_events_suppressing_contact_idx
  on public.message_events (contact_id)
  where event_type in ('bounce', 'bounced', 'complaint', 'unsubscribe', 'unsubscribed');

-- =============================================================================
-- 4. contacts: new columns from the real CSV
-- =============================================================================
alter table public.contacts
  add column external_id       text,
  add column country           text,
  add column city              text,
  add column consent_marketing boolean not null default false,
  add column suppressed_until  timestamptz,
  add column deleted_at        timestamptz,
  add column notes             text;

-- -----------------------------------------------------------------------------
-- consent_marketing: INPUT NORMALISATION HAPPENS IN THE IMPORT PARSER
-- -----------------------------------------------------------------------------
-- The source CSVs express consent inconsistently: '1', 'TRUE', 'f', 'Y', 'no',
-- 'false', and likely more. None of that reaches this column. The import
-- parser (application layer) maps each raw token to a clean boolean, and a row
-- whose consent token is not recognised is rejected into import_errors rather
-- than defaulted — guessing consent is the one place a wrong default is a
-- compliance incident, not a data-quality issue.
--
-- Deliberately NOT done in the database: a permissive SQL coercion would have
-- to decide what '' or 'maybe' means, silently and invisibly, on every insert.
-- The parser decides once, in code that is testable and reviewable, and the
-- column only ever stores true or false.
--
-- NOTE: the default is false, so every contact that already exists becomes
-- non-contactable the moment this migration lands, and stays that way until an
-- import sets consent explicitly. That is deliberate and fail-closed.
-- -----------------------------------------------------------------------------
comment on column public.contacts.consent_marketing is
  'Clean boolean only. Raw CSV tokens (1/TRUE/f/Y/no/false) are normalised in the import parser; unrecognised tokens are rejected to import_errors, never defaulted.';

-- Second idempotency key for import, alongside (brand_id, email). Partial, so
-- the many contacts with no external_id do not collide with each other.
create unique index contacts_brand_external_id_idx
  on public.contacts (brand_id, external_id)
  where external_id is not null;

-- =============================================================================
-- 5. contacts.is_contactable: rebuilt
-- =============================================================================
-- Two clauses from the requested definition CANNOT live in a generated column,
-- and Postgres rejects the whole expression if either is present:
--
--   a) `not exists (select ... from public.message_events ...)`
--      A generation expression may only reference columns of the row being
--      written. Subqueries and cross-table references are rejected outright.
--
--   b) `suppressed_until < now()`
--      A generation expression must be IMMUTABLE. now() is STABLE, so this is
--      rejected too. (Not flagged in the change request, but it fails for the
--      same reason: a stored column cannot re-evaluate itself as the clock
--      moves, so a contact would stay suppressed forever after the window
--      passed.)
--
-- So is_contactable keeps ONLY the immutable, same-row clauses, and the two
-- dynamic clauses move into the public.contact_sendability view in section 6.
--
-- ***** is_contactable IS NO LONGER SUFFICIENT ON ITS OWN. *****
-- It is a static precondition, not the audience gate. Selecting recipients
-- with `where is_contactable` would message people who have unsubscribed.
-- Use public.contact_sendability.is_sendable_now.
--
-- Dropped and recreated rather than altered because Postgres has no
-- ALTER COLUMN ... SET EXPRESSION for a generated column's definition.
-- Dropping the column also drops contacts_brand_contactable_idx, rebuilt below.
alter table public.contacts drop column is_contactable;

-- The legacy suppression trio goes with it. is_contactable was their only
-- dependent, so this has to follow the drop above and precede the rebuild
-- below. Retiring them leaves ONE suppression model:
--   consent_marketing / deleted_at / suppressed_until on the row, plus
--   bounce|complaint|unsubscribe events, combined in
--   contact_sendability.is_sendable_now.
-- Keeping both models would let the two disagree, and the dashboard would have
-- no way to say which one was right. Guarded by the preflight in section 0.
alter table public.contacts
  drop column unsubscribed_at,
  drop column hard_bounced_at,
  drop column suppressed_at;

alter table public.contacts
  add column is_contactable boolean not null
    generated always as (
      is_subscribed
      and email is not null        -- already NOT NULL; kept as belt and braces
      and deleted_at is null
      and consent_marketing
    ) stored;

comment on column public.contacts.is_contactable is
  'STATIC preconditions only (subscribed, not deleted, consented). NOT the audience gate — it cannot see message_events or the clock. Use public.contact_sendability.is_sendable_now to pick recipients.';

create index contacts_brand_contactable_idx
  on public.contacts (brand_id) where is_contactable;

-- =============================================================================
-- 6. contact_sendability — the real audience gate
-- =============================================================================
-- A view rather than a maintained column, because:
--   * a generated column cannot do either dynamic clause (see section 5);
--   * a trigger-maintained column could, but goes stale the moment
--     suppressed_until elapses — nothing fires on the passage of time;
--   * contact_latest_status is the wrong home: it is DISTINCT ON over
--     message_events, so a contact with zero events does not appear in it at
--     all, and those are exactly the contacts a first campaign targets.
-- A view is recomputed per query and therefore cannot be stale.
--
-- security_invoker so the caller's RLS on contacts and message_events applies.
create or replace view public.contact_sendability
with (security_invoker = on) as
select
  c.id       as contact_id,
  c.brand_id,
  c.email,
  c.external_id,
  c.is_contactable                                              as passes_static_checks,
  (c.suppressed_until is null or c.suppressed_until < now())    as suppression_window_elapsed,
  s.no_suppressing_event,
  (
        c.is_contactable
    and (c.suppressed_until is null or c.suppressed_until < now())
    and s.no_suppressing_event
  ) as is_sendable_now
from public.contacts c
cross join lateral (
  select not exists (
    select 1
    from public.message_events me
    where me.contact_id = c.id
      and me.brand_id   = c.brand_id
      and me.event_type in ('bounce', 'bounced', 'complaint', 'unsubscribe', 'unsubscribed')
  ) as no_suppressing_event
) s;

comment on view public.contact_sendability is
  'One row per contact. is_sendable_now is the ONLY sanctioned audience gate: static consent checks AND the suppression window AND the absence of any bounce/complaint/unsubscribe event, in either vocabulary.';

grant select on public.contact_sendability to authenticated;

-- =============================================================================
-- 7. campaigns: new columns from the real CSV
-- =============================================================================
alter table public.campaigns
  add column external_id        text,
  add column channel            text,
  add column target_country     text,
  add column reported_sent      integer check (reported_sent      is null or reported_sent      >= 0),
  add column reported_delivered integer check (reported_delivered is null or reported_delivered >= 0),
  add column reported_bounced   integer check (reported_bounced   is null or reported_bounced   >= 0),
  add column reported_opens     integer check (reported_opens     is null or reported_opens     >= 0),
  add column reported_clicks    integer check (reported_clicks    is null or reported_clicks    >= 0),
  add column spend              numeric(12,2) check (spend is null or spend >= 0),
  add column sent_at_utc        timestamptz,
  add column send_local_time    text,
  add column parent_campaign_id uuid;

-- DEVIATION FROM SPEC, FLAGGED: requested as `references public.campaigns(id)`.
-- A single-column FK would let a brand A campaign name a brand B campaign as
-- its parent — a readable cross-brand edge, reachable through any join that
-- follows the parent link. The composite FK against the existing
-- campaigns(id, brand_id) unique key accepts exactly the same rows for
-- well-formed data and rejects the cross-brand case at write time.
alter table public.campaigns
  add constraint campaigns_parent_campaign_fkey
  foreign key (parent_campaign_id, brand_id)
  references public.campaigns (id, brand_id);

alter table public.campaigns
  add constraint campaigns_parent_not_self
  check (parent_campaign_id is null or parent_campaign_id <> id);

create unique index campaigns_brand_external_id_idx
  on public.campaigns (brand_id, external_id)
  where external_id is not null;

-- The reported_* figures are what the CLIENT's spreadsheet claims. They are
-- NOT derived from message_events and the two will disagree. Never sum or
-- average across the two sources, and label them as client-reported wherever
-- they surface, or the dashboard becomes a quietly wrong number.
comment on column public.campaigns.reported_sent is
  'Client-reported figure from the source CSV. Not derived from message_events. Display separately from event-derived counts; never combine the two.';

-- =============================================================================
-- 8. campaign_sends: backfill support
-- =============================================================================
alter table public.campaign_sends
  add column is_backfill boolean not null default false,
  add column batch_key   text;

-- Makes re-importing kilele-send-log.csv idempotent. That file repeats rows
-- for the same batch_key, so the importer should INSERT ... ON CONFLICT
-- (brand_id, batch_key) DO NOTHING.
--
-- DO NOTHING, not DO UPDATE: campaign_sends_guard_immutable() rejects any
-- update to recipient_count or recipient_snapshot, so a DO UPDATE that touches
-- either will abort the import.
create unique index campaign_sends_brand_batch_key_idx
  on public.campaign_sends (brand_id, batch_key)
  where batch_key is not null;

-- Historical rows carry a count with no real recipient list, so the strict
-- equality cannot hold for them. Exempting them by is_backfill keeps the check
-- fully strict for live sends, which is where the money is.
alter table public.campaign_sends
  drop constraint campaign_sends_count_matches_snapshot;

alter table public.campaign_sends
  add constraint campaign_sends_count_matches_snapshot
  check (is_backfill or recipient_count = jsonb_array_length(recipient_snapshot));

comment on column public.campaign_sends.is_backfill is
  'True only for historically imported sends. Exempts the row from the recipient_count = snapshot length check. Must never be set on a live send.';

-- -----------------------------------------------------------------------------
-- DOUBLE-SEND GUARD, RESCOPED TO LIVE SENDS (signed off separately)
-- -----------------------------------------------------------------------------
-- The guard allowed ONE row per campaign in a non-terminal-failure status.
-- Historical rows land with status 'sent', so a campaign that really was sent
-- in several batches could only have its FIRST batch imported; every later one
-- failed with 23505 and the import silently under-reported.
--
-- Adding `is_backfill = false` exempts imported history and changes nothing
-- for live sends. The app cannot set is_backfill: the INSERT policy on
-- campaign_sends is restricted to owners inserting status='pending', and
-- backfill runs as service_role. So for every row the API can create, the
-- predicate is identical to before — two concurrent confirms still race into
-- one unique_violation, and the guard is still a database constraint rather
-- than an application-level status check.
--
-- Rebuilt, not patched: an index predicate cannot be altered in place.
drop index public.campaign_sends_one_active_per_campaign_idx;

create unique index campaign_sends_one_active_per_campaign_idx
  on public.campaign_sends (campaign_id)
  where is_backfill = false and status not in ('failed', 'canceled');

comment on index public.campaign_sends_one_active_per_campaign_idx is
  'Zero-double-send guard. At most one live (non-backfill) send per campaign may hold a non-terminal-failure status. Concurrent confirms collide here, in the database, not in application code.';

-- =============================================================================
-- 9. contact_latest_status, rebuilt on the new vocabulary
-- =============================================================================
-- security_invoker = on is mandatory and is the reason this is a full rebuild
-- rather than a patch: without it the view runs with owner rights and hands
-- every brand's events to every caller.
--
-- ORDERING (surface this wording in the UI tooltip):
--   * rank by public.event_severity() first, so a later, milder event never
--     displaces an earlier, more severe one. This replaces the old
--     unsubscribed-only sticky rule.
--   * within one severity, the provider's event_timestamp decides, descending.
--     Arrival order (received_at) is never the primary signal.
--   * remaining ties break on received_at then provider_event_id, so the
--     result is deterministic and does not flip between refreshes.
create or replace view public.contact_latest_status
with (security_invoker = on) as
select distinct on (e.contact_id)
  e.contact_id,
  e.brand_id,
  c.email,
  c.is_contactable,
  e.event_type                        as latest_event_type,
  public.event_severity(e.event_type) as latest_event_severity,
  e.event_timestamp                   as latest_event_at,
  e.campaign_send_id                  as latest_campaign_send_id,
  e.provider_event_id                 as latest_provider_event_id
from public.message_events e
join public.contacts c
  on c.id = e.contact_id
 and c.brand_id = e.brand_id
where e.contact_id is not null
order by
  e.contact_id,
  public.event_severity(e.event_type) asc,  -- severity outranks recency
  e.event_timestamp desc,                   -- payload time, not arrival time
  e.received_at desc,
  e.provider_event_id desc;

comment on view public.contact_latest_status is
  'Most significant state per contact. Ranked by event_severity (complaint > unsubscribe > bounce > click > open > delivered), then by payload event_timestamp. A milder later event never overrides a severer earlier one.';

-- Dropping the view dropped its grants.
grant select on public.contact_latest_status to authenticated;

-- =============================================================================
-- 10. get_shared_campaign_results, rebuilt on the new vocabulary
-- =============================================================================
-- Its filters referenced 'read', 'bounced', 'failed' and 'unsubscribed' from
-- the old enum, which are now either renamed or gone. Left alone it would
-- compile fine and report zeros forever.
--
-- DROP then CREATE because the OUT columns change:
--   read_count   -> opened_count   ('read' was never a real event name)
--   (new)           clicked_count  (the CSVs carry clicks; nothing reported them)
--   failed_count -> complained_count
--        'failed' is not a dispatcher event type and is not in the new CHECK,
--        so failed_count could only ever have been 0. 'complaint' is a real
--        value that nothing was counting.
-- Everything else, including the security posture, is unchanged.
drop function if exists public.get_shared_campaign_results(text, text);

create function public.get_shared_campaign_results(
  p_token    text,
  p_password text
)
returns table (
  campaign_name      text,
  campaign_status    public.campaign_status,
  sent_at            timestamptz,
  recipient_count    integer,
  delivered_count    bigint,
  opened_count       bigint,
  clicked_count      bigint,
  bounced_count      bigint,
  complained_count   bigint,
  unsubscribed_count bigint
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_link   public.shared_links;
  v_send   public.campaign_sends;
begin
  if p_token is null or p_token !~ '^[a-f0-9]{64}$' then
    -- Constant-ish work even on a malformed token, then the same generic error.
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 12));
    raise exception 'Invalid link or password' using errcode = 'invalid_password';
  end if;

  select * into v_link
  from public.shared_links sl
  where sl.token = p_token
    and sl.revoked_at is null
    and (sl.expires_at is null or sl.expires_at > now());

  if v_link.id is null then
    -- Burn a comparable amount of time so "no such token" and "wrong password"
    -- are not distinguishable by response latency.
    perform extensions.crypt(coalesce(p_password, ''), extensions.gen_salt('bf', 12));
    raise exception 'Invalid link or password' using errcode = 'invalid_password';
  end if;

  if v_link.password_hash <> extensions.crypt(coalesce(p_password, ''), v_link.password_hash) then
    raise exception 'Invalid link or password' using errcode = 'invalid_password';
  end if;

  update public.shared_links sl
     set view_count = sl.view_count + 1,
         last_viewed_at = now()
   where sl.id = v_link.id;

  -- The send that actually went out for this campaign, if any.
  select * into v_send
  from public.campaign_sends cs
  where cs.campaign_id = v_link.campaign_id
    and cs.status = 'sent'
  order by cs.created_at desc
  limit 1;

  -- COUNTING LOGIC (mirror this wording in the shared-results UI):
  --   * recipient_count is the FROZEN snapshot count from the send, not a live
  --     recount of the audience.
  --   * every other figure counts DISTINCT contacts, not events, because the
  --     provider redelivers receipts and a contact who opens twice is one open.
  --   * each filter accepts BOTH vocabularies, so a campaign whose receipts are
  --     part CSV backfill and part live webhook is counted once, consistently.
  --     Counting only one spelling is how a figure ends up quietly halved.
  --   * a contact can appear in more than one column (delivered AND opened);
  --     the columns are independent facts, they are not a partition of
  --     recipient_count and are not expected to sum to it.
  return query
  select
    c.name,
    c.status,
    v_send.completed_at,
    coalesce(v_send.recipient_count, 0),
    count(distinct me.contact_id) filter (where me.event_type = 'delivered'),
    count(distinct me.contact_id) filter (where me.event_type in ('open', 'opened')),
    count(distinct me.contact_id) filter (where me.event_type = 'click'),
    count(distinct me.contact_id) filter (where me.event_type in ('bounce', 'bounced')),
    count(distinct me.contact_id) filter (where me.event_type = 'complaint'),
    count(distinct me.contact_id) filter (where me.event_type in ('unsubscribe', 'unsubscribed'))
  from public.campaigns c
  left join public.message_events me
    on me.campaign_send_id = v_send.id
  where c.id = v_link.campaign_id      -- scoped to this one campaign, always
  group by c.name, c.status;
end;
$$;

-- Re-grant: DROP FUNCTION discarded the old privileges.
revoke execute on function public.get_shared_campaign_results(text, text) from public;
grant execute on function public.get_shared_campaign_results(text, text) to anon, authenticated;

comment on function public.get_shared_campaign_results(text, text) is
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. The anon role has no direct access to shared_links.';

commit;
