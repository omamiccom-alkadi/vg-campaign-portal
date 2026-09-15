-- =============================================================================
-- get_shared_campaign_results: count events linked either way
-- =============================================================================
-- BUG, and the worst kind: it produced plausible zeros rather than an error,
-- on the one screen an outside client sees with no context to know better.
--
-- The event join was `on me.campaign_send_id = v_send.id`. That is the live
-- dispatcher's linkage, but the CSV backfill sets campaign_id instead — by
-- design, since historical events predate any campaign_sends row. So a shared
-- link for a historical campaign showed a real Recipients figure next to zero
-- delivered, zero opened, zero clicked, zero bounced and zero unsubscribed,
-- for a campaign holding thousands of genuine events.
--
-- Widened to accept either linkage. Specifically:
--
--   * `me.campaign_send_id = v_send.id` still catches live sends. When no send
--     row exists v_send.id is NULL, the comparison is NULL, and the branch
--     simply contributes nothing rather than erroring.
--   * `me.campaign_id = v_link.campaign_id` catches backfilled history, and
--     now also catches a campaign that has events but no send row at all.
--   * `me.brand_id = v_link.brand_id` is redundant — campaign_id and
--     campaign_send_id are both primary keys and therefore already pin one
--     brand — but it is free, and it means the cross-brand guarantee on this
--     anonymous path does not rest on an argument about uniqueness.
--
-- Rows are not double-counted when both links are set, which is what the
-- poller writes: the OR is a join predicate, so one event row matches once,
-- and every figure is count(distinct contact_id) regardless.
--
-- Everything else is carried over verbatim: the security posture, the generic
-- error on every failure path, the bcrypt burn that keeps an unknown token
-- indistinguishable from a wrong password, the view_count bump, and the
-- counting notes. Recreated rather than patched because a function body cannot
-- be amended in place.

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
    coalesce(v_send.recipient_count, 0),
    count(distinct me.contact_id) filter (where me.event_type = 'delivered'),
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
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. Events are matched on campaign_send_id (live sends) OR campaign_id (CSV backfill), so a historical campaign does not report zero engagement. The anon role has no direct access to shared_links.';
