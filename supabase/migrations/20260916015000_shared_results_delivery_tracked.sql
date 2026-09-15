-- =============================================================================
-- get_shared_campaign_results: say when delivery was never tracked
-- =============================================================================
-- Third and last of the honest-figure fixes on this function. The previous one
-- let the page blank out Recipients and Delivered whenever recipient_count came
-- back NULL, using "no send was recorded" as a proxy for "imported campaign".
-- That proxy is wrong for the campaigns the send-log backfill DID cover: those
-- have a status='sent' row carrying a real recipient_count, so the page treated
-- them as live sends and printed Delivered as a confident 0 - which is the exact
-- misleading zero the previous migration set out to remove, just relocated to a
-- different subset of history. Most of Kilele's campaigns are in that subset.
--
-- "Has a recorded send" and "reported delivery receipts" are different
-- questions. Only the live dispatcher reports delivery receipts; imported
-- history carries the open/click/bounce/complaint/unsubscribe vocabulary and
-- nothing else. The send row already knows which it is, so the function now
-- answers the question directly instead of leaving the UI to infer it:
--
--   delivery_tracked = true   a live, non-backfill send produced these figures,
--                             so 0 delivered means 0 delivered.
--   delivery_tracked = false  a backfilled send, or no send row at all, so
--                             0 delivered means nobody ever recorded it.
--
-- Exposed as a semantic boolean rather than as is_backfill: an anonymous
-- visitor has no business learning this schema's column names, and the name
-- states the claim the page actually makes. It is not an identifier, so the
-- signature assertion that bans brand/campaign/contact/credential columns from
-- the OUT list is unaffected.
--
-- A live send that has not been polled yet reports delivery_tracked = true with
-- 0 delivered. That is correct and already covered by the standing caption that
-- engagement figures are a floor rather than a final total.
--
-- Recreated in full again because a function body cannot be amended in place.
-- The widened event join (20260916002000) and the NULL recipient_count
-- (20260916012000) are carried over unchanged.

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
  --     than print 0. See the migration header for why this is not inferred
  --     from recipient_count.
  --   * every other figure counts DISTINCT contacts, not events, because the
  --     provider redelivers receipts and a contact who opens twice is one open.
  --   * each filter accepts BOTH vocabularies, so a campaign whose receipts are
  --     part CSV backfill and part live webhook is counted once, consistently.
  --     Counting only one spelling is how a figure ends up quietly halved.
  --   * events are matched by EITHER linkage, because the live path records
  --     campaign_send_id and the CSV backfill records campaign_id. Matching
  --     only one is how every engagement figure on a historical campaign ends
  --     up reading zero.
  --   * a contact can appear in more than one column (delivered AND opened);
  --     the columns are independent facts, they are not a partition of
  --     recipient_count and are not expected to sum to it.
  return query
  select
    c.name,
    c.status,
    v_send.completed_at,
    v_send.recipient_count,          -- NULL when no send was recorded, not 0
    count(distinct me.contact_id) filter (where me.event_type = 'delivered'),
    coalesce(not v_send.is_backfill, false),   -- no send row => never tracked
    count(distinct me.contact_id) filter (where me.event_type in ('open', 'opened')),
    count(distinct me.contact_id) filter (where me.event_type = 'click'),
    count(distinct me.contact_id) filter (where me.event_type in ('bounce', 'bounced')),
    count(distinct me.contact_id) filter (where me.event_type = 'complaint'),
    count(distinct me.contact_id) filter (where me.event_type in ('unsubscribe', 'unsubscribed'))
  from public.campaigns c
  left join public.message_events me
    on me.brand_id = v_link.brand_id
   and (
         me.campaign_send_id = v_send.id
      or me.campaign_id      = v_link.campaign_id
       )
  where c.id = v_link.campaign_id      -- scoped to this one campaign, always
  group by c.name, c.status;
end;
$$;

-- Re-grant: DROP FUNCTION discarded the old privileges.
revoke execute on function public.get_shared_campaign_results(text, text) from public;
grant execute on function public.get_shared_campaign_results(text, text) to anon, authenticated;

comment on function public.get_shared_campaign_results(text, text) is
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. Events match on campaign_send_id (live) OR campaign_id (CSV backfill). recipient_count is NULL rather than 0 when no send was recorded, and delivery_tracked is false when no delivered figure was ever collectable, so the UI can distinguish absent figures from measured zeros. The anon role has no direct access to shared_links.';
