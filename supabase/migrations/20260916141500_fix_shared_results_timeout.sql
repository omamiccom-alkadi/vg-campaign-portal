-- =============================================================================
-- get_shared_campaign_results: 57014 on Kilele's historical campaigns
-- =============================================================================
-- Confirmed from the hosted logs: sql_state_code 57014, "canceling statement
-- due to statement timeout", surfacing to the anonymous caller as a 500 on
-- POST /rest/v1/rpc/get_shared_campaign_results. The anon role carries
-- statement_timeout = 3s -- half the authenticated budget that the dashboard
-- aggregates had already exceeded before 20260916120000 indexed them.
--
-- This is security-relevant, not merely an availability bug. An invalid token
-- short-circuits to the deliberate 'Invalid link or password' exception
-- (28P01) in microseconds, while a VALID token proceeds into the aggregate and
-- times out with 57014. The two are then distinguishable by status code and
-- error code, which hands a stranger an oracle for which tokens exist -- the
-- exact property the constant-time bcrypt burn and single generic message were
-- built to deny. Making the query fast restores indistinguishability.
--
-- Two causes, addressed separately below.
--
-- =============================================================================
-- 1. The indexes did not reach contact_id
-- =============================================================================
-- Every figure this function returns is count(distinct me.contact_id) under a
-- different FILTER. 20260916120000 indexed (campaign_id, brand_id, event_type)
-- for campaign_performance, which needs no contact_id -- so this function still
-- had to visit the heap for every matching event purely to read it, then sort
-- those rows for the distinct counts.
--
-- contact_id is a key column rather than INCLUDE deliberately. As a key column
-- the index returns contact_id already ordered within each event_type, which
-- lets the distinct counts stream instead of sorting. INCLUDE would permit the
-- index-only scan but throw that ordering away.
create index if not exists message_events_campaign_brand_type_contact_idx
  on public.message_events (campaign_id, brand_id, event_type, contact_id)
  where campaign_id is not null;

-- message_events_campaign_brand_type_idx (20260916120000) is deliberately NOT
-- dropped, even though its three columns are an exact leading prefix of the
-- index above. That index was measured against real Kilele data and verified
-- functionally; this one has not been. Overlapping indexes cost write
-- throughput on a table nothing is currently bulk-loading, which is a cheaper
-- price than disturbing a known-good plan. Revisit as cleanup once this fix has
-- its own verification behind it.
comment on index public.message_events_campaign_brand_type_contact_idx is
  'Serves the get_shared_campaign_results campaign_id branch, which needs contact_id for its count(distinct) aggregates -- the reason the narrower message_events_campaign_brand_type_idx could not help it. Dropping contact_id or demoting it to INCLUDE reintroduces a sort; dropping the partial predicate reintroduces heap fetches.';

-- The live-send branch of the same join. message_events_send_type_idx is
-- (campaign_send_id, event_type) and carries neither brand_id nor contact_id,
-- so that branch had the same heap problem. Kept alongside it rather than
-- replacing it: event_type sits second there and fourth here, so this is not a
-- prefix-superset and the older index may still be the cheaper choice for a
-- lookup that wants event_type without brand_id.
create index if not exists message_events_send_brand_type_contact_idx
  on public.message_events (campaign_send_id, brand_id, event_type, contact_id)
  where campaign_send_id is not null;

comment on index public.message_events_send_brand_type_contact_idx is
  'Live-send branch of the get_shared_campaign_results event join. Partial because the join does equality on campaign_send_id, which never matches the NULLs that CSV-backfilled events carry.';

-- =============================================================================
-- 2. The OR across two columns was never reliably indexable
-- =============================================================================
-- The previous body matched events with
--
--   on me.brand_id = v_link.brand_id
--  and (me.campaign_send_id = v_send.id or me.campaign_id = v_link.campaign_id)
--
-- An OR spanning two different columns can only use indexes via a BitmapOr, and
-- with v_send.id supplied as a PL/pgSQL parameter the planner is equally free
-- to fall back to a sequential scan of message_events -- 312k rows for Kilele.
-- Indexing alone therefore makes the fast plan possible without making it
-- certain.
--
-- Rewritten as a UNION of two single-column equality scans, each of which can
-- go index-only against one of the indexes above. The dedupe is deliberate and
-- semantically free: the branches overlap for a live send whose events carry
-- both linkages, and every figure counts DISTINCT contact_id per event_type, so
-- collapsing duplicate (contact_id, event_type) pairs cannot change a result.
-- It also shrinks the input before aggregation.
--
-- WHAT MUST NOT CHANGE, and has not:
--   * the token format check, the constant-time bcrypt burn on both the
--     malformed-token and unknown-token paths, and one identical generic
--     exception for every failure;
--   * me.brand_id = v_link.brand_id on BOTH branches, which is the isolation
--     guard -- a branch without it would read another brand's events;
--   * scoping to exactly one campaign, so sibling campaigns stay excluded;
--   * recipient_count NULL rather than 0 when no send was recorded;
--   * delivery_tracked = coalesce(not v_send.is_backfill, false).
--
-- The aggregate subquery has no GROUP BY, so it yields exactly one row even
-- when the campaign has no events at all; CROSS JOIN therefore preserves the
-- single campaigns row that the old LEFT JOIN guaranteed.
--
-- Considered and rejected: attaching `set statement_timeout` to the function.
-- As SECURITY DEFINER it could buy itself a larger budget, but that hides the
-- cost instead of removing it and makes the timing difference between a valid
-- and an invalid token larger, not smaller.

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
  delivery_tracked   boolean,
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
  --     recount of the audience. It is NULL, never 0, when no send was
  --     recorded: "not measured" and "measured as none" are different claims
  --     and the UI must not merge them.
  --   * delivery_tracked says whether a delivered figure was ever collectable.
  --     False means the figure is absent, not zero; the UI must label it rather
  --     than print 0.
  --   * every figure counts DISTINCT contacts, not events, because the provider
  --     redelivers receipts and a contact who opens twice is one open.
  --   * each filter accepts BOTH vocabularies, so a campaign whose receipts are
  --     part CSV backfill and part live webhook is counted once, consistently.
  --     Counting only one spelling is how a figure ends up quietly halved.
  --   * events are matched by EITHER linkage, because the live path records
  --     campaign_send_id and the CSV backfill records campaign_id. Matching
  --     only one is how every engagement figure on a historical campaign ends
  --     up reading zero. The two linkages are gathered as a UNION rather than
  --     an OR so each can use an index; see the migration header.
  --   * a contact can appear in more than one column (delivered AND opened);
  --     the columns are independent facts, they are not a partition of
  --     recipient_count and are not expected to sum to it.
  return query
  with linked as (
    select me.contact_id, me.event_type
    from public.message_events me
    where me.brand_id    = v_link.brand_id
      and me.campaign_id = v_link.campaign_id
    union
    select me.contact_id, me.event_type
    from public.message_events me
    where me.brand_id          = v_link.brand_id
      and me.campaign_send_id  = v_send.id
  ),
  agg as (
    select
      count(distinct l.contact_id) filter (where l.event_type = 'delivered')                          as delivered,
      count(distinct l.contact_id) filter (where l.event_type in ('open', 'opened'))                  as opened,
      count(distinct l.contact_id) filter (where l.event_type = 'click')                              as clicked,
      count(distinct l.contact_id) filter (where l.event_type in ('bounce', 'bounced'))               as bounced,
      count(distinct l.contact_id) filter (where l.event_type = 'complaint')                          as complained,
      count(distinct l.contact_id) filter (where l.event_type in ('unsubscribe', 'unsubscribed'))     as unsubscribed
    from linked l
  )
  select
    c.name,
    c.status,
    v_send.completed_at,
    v_send.recipient_count,          -- NULL when no send was recorded, not 0
    a.delivered,
    coalesce(not v_send.is_backfill, false),   -- no send row => never tracked
    a.opened,
    a.clicked,
    a.bounced,
    a.complained,
    a.unsubscribed
  from public.campaigns c
  cross join agg a
  where c.id = v_link.campaign_id;     -- scoped to this one campaign, always
end;
$$;

-- Re-grant: DROP FUNCTION discarded the old privileges.
revoke execute on function public.get_shared_campaign_results(text, text) from public;
grant execute on function public.get_shared_campaign_results(text, text) to anon, authenticated;

comment on function public.get_shared_campaign_results(text, text) is
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. Events match on campaign_send_id (live) OR campaign_id (CSV backfill), gathered as a UNION of two indexable equality scans rather than an OR. recipient_count is NULL rather than 0 when no send was recorded, and delivery_tracked is false when no delivered figure was ever collectable, so the UI can distinguish absent figures from measured zeros. The anon role has no direct access to shared_links.';
