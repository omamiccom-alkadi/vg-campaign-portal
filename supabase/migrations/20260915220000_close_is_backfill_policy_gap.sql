-- =============================================================================
-- Close the is_backfill gap in the campaign_sends INSERT policy
-- =============================================================================
-- 20260914161149 rescoped the double-send guard to `is_backfill = false` and
-- justified it with this claim:
--
--     "The app cannot set is_backfill: the INSERT policy on campaign_sends is
--      restricted to owners inserting status='pending', and backfill runs as
--      service_role. So for every row the API can create, the predicate is
--      identical to before."
--
-- The conclusion was right; the premise was not. The policy constrained
-- `status` and said nothing about `is_backfill`, so an authenticated owner
-- could insert `status = 'pending', is_backfill = true` and land a row that
-- sits OUTSIDE the guard's partial index. Two concurrent confirms for one
-- campaign would then both commit — the precise double-send this table exists
-- to prevent. The same flag also exempts a row from
-- campaign_sends_count_matches_snapshot, so the same request could claim any
-- recipient_count it liked against an empty snapshot.
--
-- Adding `is_backfill = false` to the WITH CHECK makes the migration's claim
-- true instead of merely intended. Nothing legitimate changes:
--
--   * the live send flow never sets the column, and it defaults to false;
--   * the backfill runs as service_role, which bypasses RLS entirely;
--   * for every row an API client can now create, the guard's predicate is
--     genuinely identical to what it was before backfill support existed.
--
-- Replaced rather than altered: a policy's WITH CHECK cannot be amended in
-- place. The body below is the original with one clause added.

drop policy campaign_sends_insert_own_brand_owner on public.campaign_sends;

create policy campaign_sends_insert_own_brand_owner on public.campaign_sends
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and public.auth_role() = 'owner'
    and status = 'pending'
    and requested_by = (select auth.uid())
    -- is_backfill is a service-role-only flag. It exempts a row from both the
    -- double-send guard and the count-matches-snapshot check, so a client that
    -- could set it could defeat either one.
    and is_backfill = false
  );

comment on policy campaign_sends_insert_own_brand_owner on public.campaign_sends is
  'Owners confirm a send by inserting a pending, non-backfill row attributed to themselves. The is_backfill = false clause is load-bearing, not tidiness: the double-send guard index is predicated on it, so without this clause an owner could opt a row out of the guard and two concurrent confirms would both succeed. Historical sends are written by service_role, which bypasses this policy.';
