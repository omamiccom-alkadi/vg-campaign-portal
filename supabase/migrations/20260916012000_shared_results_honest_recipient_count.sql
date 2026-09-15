-- =============================================================================
-- get_shared_campaign_results: stop reporting "unknown" as zero
-- =============================================================================
-- Recipients read 0 on a shared link for an imported campaign, which reads as
-- "nobody received this" when the truth is "no recipient figure was recorded".
--
-- The cause was `coalesce(v_send.recipient_count, 0)`. v_send is the newest
-- campaign_sends row for the campaign with status = 'sent'; when there is no
-- such row the coalesce converted a genuine NULL into a confident 0. The send-
-- log backfill does populate recipient_count from the CSV, so this is not a
-- gap in the backfill: it affects a campaign whose history simply carries no
-- send-log row, or whose row is 'failed'/'canceled' rather than 'sent'.
--
-- Dropping the coalesce makes "not recorded" representable, so the UI can say
-- so instead of printing a number nobody measured. The OUT column was already
-- nullable, so the signature does not change and no caller breaks.
--
-- Deliberately NOT changed here:
--   * which send row is chosen. Widening it to 'failed'/'canceled' would report
--     the size of a send that did not land as if it had, which is a worse lie
--     than a blank.
--   * the delivered filter. Imported history has no delivery receipts at all -
--     the historical CSV vocabulary is open/click/bounce/complaint/unsubscribe,
--     as the 20260914161149 column comment records - so delivered is 0 for
--     every imported campaign as a matter of what was collected, not of what
--     happened. Inventing a proxy (counting 'sent', say) would manufacture a
--     number. The page now labels it rather than restating it.
--
-- Recreated in full because a function body cannot be amended in place; the
-- widened event join from 20260916002000 is carried over unchanged.

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
  --     recount of the audience. It is NULL, never 0, when no send was
  --     recorded: "not measured" and "measured as none" are different claims
  --     and the UI must not merge them.
  --   * every other figure counts DISTINCT contacts, not events, because the
  --     provider redelivers receipts and a contact who opens twice is one open.
  --   * each filter accepts BOTH vocabularies, so a campaign whose receipts are
  --     part CSV backfill and part live webhook is counted once, consistently.
  --     Counting only one spelling is how a figure ends up quietly halved.
  --   * delivered is the exception, and not by oversight: only the live
  --     dispatcher reports delivery receipts. Imported history never carried
  --     them, so 0 delivered against non-zero opens means "not collected".
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
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. Events match on campaign_send_id (live) OR campaign_id (CSV backfill). recipient_count is NULL, not 0, when no send was recorded, so the UI can distinguish "not recorded" from "none". The anon role has no direct access to shared_links.';
