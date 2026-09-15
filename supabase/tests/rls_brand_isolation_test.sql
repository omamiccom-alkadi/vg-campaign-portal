-- =============================================================================
-- pgTAP: brand isolation + double-send + share-link + no-delete guarantees
-- =============================================================================
-- Run with:
--   supabase test db          (or)   pg_prove -d "$DB_URL" tests/*.sql
--
-- BASELINE: 45/45 passing. The original 33 were established by two runs —
-- locally against `supabase start`, and once against a throwaway cloud project
-- (since deleted) to confirm identical behaviour on hosted Postgres. Tests 16
-- and 17, the composite-FK cross-brand guards, arrived with
-- 20260915150000_add_campaigns_source_batch.sql and have so far only been run
-- locally. The four message_events guards arrived with
-- 20260915170000_events_per_brand_dedupe_and_campaign_link.sql, also local
-- only so far, as did the three is_backfill guards that arrived with
-- 20260915220000_close_is_backfill_policy_gap.sql. Test 35, the shared-results
-- event-linkage guard, arrived with
-- 20260916002000_fix_shared_results_event_join.sql, also local only so far.
-- A count below 45 is a regression to investigate, not a suite that has never
-- been executed.
--
-- Tests 16 and 17 were mutation-checked rather than merely observed passing:
-- rewriting both composite FKs as single-column references made exactly those
-- two fail and nothing else, so they are guarding the constraint and not
-- passing for an unrelated reason.
--
-- The four message_events guards were mutation-checked the same way:
--   * restoring the global unique on provider_event_id  -> only 6 and 7 fail
--   * weakening message_events_campaign_fkey to (campaign_id) -> only 24 fails
--   * granting authenticated INSERT with check (true)   -> only 23 fails
-- and the suite returned to 39/39 once each mutation was reverted.
--
-- The three is_backfill guards (29, 30, 31) were mutation-checked against both
-- halves of the mechanism, since the flag and the index predicate have to agree
-- for either to mean anything:
--   * reverting the INSERT policy to its pre-fix body, i.e. dropping the
--     `is_backfill = false` clause          -> only 29 fails
--   * dropping `is_backfill = false` from the guard index predicate, so
--     history competes with live sends      -> only 30 fails
-- and the suite returned to 42/42 once each was reverted. 31 has no mutation of
-- its own: it exists to prove the exemption did not quietly release the live
-- slot, so it must keep passing throughout.
--
-- Test 35 was mutation-checked too, and that check is why it exists. Reverting
-- get_shared_campaign_results to its campaign_send_id-only join made 35 fail
-- with `have: 0, want: 1` and left the other 42 passing — which is precisely
-- the problem: the suite had been fully green while every engagement figure on
-- a historical campaign read zero on the public share page. Row-count, name and
-- leakage assertions cannot see a wrong number. 35 is the one that can, so it
-- guards in both directions: 0 means the backfill linkage was dropped again,
-- 2 means the join widened far enough to count a sibling campaign's events.
--
-- This file is the audit that .cursorrules demands: it FAILS the moment brand
-- isolation is weakened. Specifically it fails if any of these regress:
--   * a policy loses its brand_id predicate
--   * an UPDATE policy loses its WITH CHECK clause (cross-brand row move)
--   * brand_id starts being trusted from client input
--   * the partial unique index guarding double-sends is dropped
--   * a composite FK on campaigns or message_events is weakened to a
--     single-column reference, re-opening a readable cross-brand edge
--   * event dedupe reverts to a global unique on provider_event_id, letting
--     one brand's ids block another's
--   * message_events becomes insertable by authenticated clients, which would
--     let a client fabricate delivery figures
--   * campaign_sends becomes insertable with is_backfill = true by a client,
--     which would place a send outside the double-send guard's predicate
--   * a DELETE policy is ever added
--   * shared_links becomes readable by the anon role
--   * the share-link function starts returning brand/campaign identifiers
--   * its failure messages start distinguishing "bad token" from "bad password"
--   * revoked or expired links start resolving
--   * its event join stops counting backfilled history, or starts counting a
--     campaign other than the linked one — both are wrong numbers shown to an
--     external client, which .cursorrules rates worse than showing none
--
-- It runs as a superuser to seed fixtures, then drops to the `authenticated`
-- role with a forged JWT claim for each user, and to the bare `anon` role for
-- the share-link path — i.e. it exercises the same code path a real client
-- hits, not a privileged shortcut.
-- =============================================================================

begin;

create extension if not exists pgtap with schema extensions;

select plan(45);

-- -----------------------------------------------------------------------------
-- Fixtures: two brands, one owner + one analyst each
-- -----------------------------------------------------------------------------
\set brand_a  '11111111-1111-1111-1111-111111111111'
\set brand_b  '22222222-2222-2222-2222-222222222222'
\set owner_a  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
\set analyst_a 'aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb'
\set owner_b  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
\set newbie   'dddddddd-dddd-dddd-dddd-dddddddddddd'
\set batch_b  'eeeeeeee-eeee-eeee-eeee-bbbbbbbbbbbb'
\set camp_a   'cccccccc-cccc-cccc-cccc-aaaaaaaaaaaa'
\set camp_a2  'cccccccc-cccc-cccc-cccc-aaaaaaaaaaab'
\set camp_b   'cccccccc-cccc-cccc-cccc-bbbbbbbbbbbb'

-- Well-formed (64 hex chars, passes the function's own format check) but never
-- issued. Probing with this must be indistinguishable from a wrong password.
\set tok_missing 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd'
\set share_pw    'correct-password-123'

insert into public.brands (id, name, slug) values
  (:'brand_a', 'Brand A', 'brand-a'),
  (:'brand_b', 'Brand B', 'brand-b');

insert into auth.users (id, instance_id, aud, role, email, encrypted_password,
                        email_confirmed_at, created_at, updated_at)
values
  (:'owner_a',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'owner-a@test.local',   '', now(), now(), now()),
  (:'analyst_a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'analyst-a@test.local', '', now(), now(), now()),
  (:'owner_b',   '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'owner-b@test.local',   '', now(), now(), now()),
  -- Signed up, not yet attached to a brand. Used to prove owner A cannot
  -- hand a new user to brand B.
  (:'newbie',    '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
   'newbie@test.local',    '', now(), now(), now());

insert into public.profiles (id, brand_id, role) values
  (:'owner_a',   :'brand_a', 'owner'),
  (:'analyst_a', :'brand_a', 'analyst'),
  (:'owner_b',   :'brand_b', 'owner');

insert into public.contacts (brand_id, email, raw_attrs) values
  (:'brand_a', 'alice@a.test', '{"plan":"pro"}'),
  (:'brand_a', 'bob@a.test',   '{"plan":"free"}'),
  (:'brand_b', 'carol@b.test', '{"plan":"pro"}');

-- Brand B's import batch. Exists only as a cross-brand target for the
-- composite-FK guards in section C.
insert into public.import_batches (id, brand_id, uploaded_by, filename) values
  (:'batch_b', :'brand_b', :'owner_b', 'brand-b-contacts.csv');

insert into public.campaigns (id, brand_id, name, created_by) values
  (:'camp_a',  :'brand_a', 'Campaign A',  :'owner_a'),
  (:'camp_a2', :'brand_a', 'Campaign A2', :'owner_a'),
  (:'camp_b',  :'brand_b', 'Campaign B',  :'owner_b');

-- -----------------------------------------------------------------------------
-- Session helpers
-- -----------------------------------------------------------------------------
-- These live in `public`, not `pg_temp`, on purpose: the session's temporary
-- schema grants USAGE to its owner only, so `anon` could not call a pg_temp
-- helper. They are created inside this transaction and vanish on ROLLBACK.

-- Become a given end user, exactly as PostgREST would.
create or replace function public.login_as(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user, 'role', 'authenticated')::text,
                     true);
end;
$$;

-- Become a bare anonymous visitor: the `anon` role with no JWT at all, so
-- auth.uid() and therefore auth_brand_id() are both NULL. This is the exact
-- context a shared-link page runs in.
create or replace function public.login_as_anon()
returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
end;
$$;

create or replace function public.logout()
returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- Runs a statement and returns its error MESSAGE (not its code), so two
-- failure paths can be compared for byte-identical text. Comparing SQLSTATEs
-- would not catch a leak: the message is what reaches the visitor.
create or replace function public.capture_error(p_sql text)
returns text language plpgsql as $$
begin
  execute p_sql;
  return '<no error raised>';
exception when others then
  return sqlerrm;
end;
$$;

-- =============================================================================
-- A. Structural guarantees (these fail loudly if someone "simplifies" the schema)
-- =============================================================================
select ok(
  (select bool_and(rowsecurity) from pg_tables
    where schemaname = 'public'
      and tablename in ('brands','profiles','contacts','import_batches','import_errors',
                        'campaigns','campaign_sends','message_events','shared_links')),
  'RLS is enabled on every table'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and cmd = 'DELETE'),
  0,
  'no DELETE policy exists on any table — deletion is impossible via the API'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and cmd = 'UPDATE' and with_check is null),
  0,
  'every UPDATE policy has a WITH CHECK clause (cannot move a row to another brand)'
);

select ok(
  exists (
    select 1 from pg_index i
    where i.indexrelid = to_regclass('public.campaign_sends_one_active_per_campaign_idx')::oid
      and i.indisunique
  ),
  'the UNIQUE index guarding against double-sends still exists'
);

-- A guard that covers every status is no guard at all.
select ok(
  pg_get_expr(
    (select indpred from pg_index
      where indexrelid = to_regclass('public.campaign_sends_one_active_per_campaign_idx')::oid),
    'public.campaign_sends'::regclass
  ) is not null,
  'the double-send guard is still a PARTIAL index (has a predicate)'
);

-- Event dedupe must stay scoped to a brand. The three historical files reuse
-- one 'EV-' id space, so a global key would make whichever brand imported
-- first silently consume the others' ids — and would let one tenant's writes
-- block another's, which is an isolation failure even with no data leak.
select ok(
  exists (
    select 1 from pg_index i
    where i.indrelid = 'public.message_events'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a
            where a.attrelid = i.indrelid
              and a.attnum = any(i.indkey::smallint[]))
          = array['brand_id', 'provider_event_id']
  ),
  'event dedupe is scoped per brand (unique on brand_id + provider_event_id)'
);

-- Checked against pg_index rather than pg_constraint so a bare
-- `create unique index` reintroducing the global key is caught too.
select is(
  (select count(*)::int from pg_index i
    where i.indrelid = 'public.message_events'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname::text)
             from pg_attribute a
            where a.attrelid = i.indrelid
              and a.attnum = any(i.indkey::smallint[]))
          = array['provider_event_id']),
  0,
  'no global unique on provider_event_id alone'
);

select ok(
  (select c.reloptions::text like '%security_invoker=on%'
     from pg_class c where c.oid = 'public.contact_latest_status'::regclass),
  'contact_latest_status is security_invoker (does not bypass RLS)'
);

select is(
  (select count(*)::int from pg_policies
    where schemaname = 'public' and tablename = 'shared_links'
      and 'anon' = any(roles)),
  0,
  'shared_links has no policy granting the anon role table access'
);

-- =============================================================================
-- B. Read isolation
-- =============================================================================
select public.login_as(:'owner_a');

select is(
  (select count(*)::int from public.contacts),
  2,
  'brand A owner sees only brand A contacts'
);

select is(
  (select count(*)::int from public.contacts where email = 'carol@b.test'),
  0,
  'brand A owner cannot read a brand B contact even by exact email'
);

select is(
  (select count(*)::int from public.campaigns where id = :'camp_b'),
  0,
  'brand A owner cannot read a brand B campaign by primary key'
);

select is(
  (select count(*)::int from public.brands),
  1,
  'brand A owner sees exactly one brand row'
);

select is(public.auth_brand_id(), :'brand_a'::uuid, 'auth_brand_id() resolves from auth.uid()');
select is(public.auth_role(), 'owner'::public.user_role, 'auth_role() resolves from auth.uid()');

-- =============================================================================
-- C. Write isolation
-- =============================================================================
-- The security audit's favourite move: name another brand in the payload.
select throws_ok(
  format('insert into public.contacts (brand_id, email) values (%L, %L)',
         :'brand_b', 'injected@a.test'),
  '42501',
  null,
  'brand A owner cannot INSERT a contact into brand B (client-supplied brand_id rejected)'
);

select throws_ok(
  format('insert into public.campaigns (brand_id, name) values (%L, %L)',
         :'brand_b', 'Smuggled campaign'),
  '42501',
  null,
  'brand A owner cannot INSERT a campaign into brand B'
);

-- Both of these name brand A in brand_id, so RLS is satisfied and waves them
-- through: the composite foreign keys are the only thing left to refuse them.
-- Reduce either FK to a single-column reference — campaigns(id) or
-- import_batches(id) — and the row is accepted, handing brand A a readable
-- edge into brand B through any join that follows the link.
select throws_ok(
  format($q$insert into public.campaigns (brand_id, name, source_batch_id)
            values (%L, 'Batch smuggler', %L)$q$,
         :'brand_a', :'batch_b'),
  '23503',
  null,
  'a campaign cannot cite another brand''s import batch'
);

select throws_ok(
  format($q$insert into public.campaigns (brand_id, name, parent_campaign_id)
            values (%L, 'Parent smuggler', %L)$q$,
         :'brand_a', :'camp_b'),
  '23503',
  null,
  'a campaign cannot name another brand''s campaign as its parent'
);

-- WITH CHECK is what catches this one. USING lets brand A touch its own row;
-- only WITH CHECK stops the row from walking out of brand A into brand B.
-- Delete the WITH CHECK clause from contacts_update_own_brand and this fails.
select throws_ok(
  format('update public.contacts set brand_id = %L where email = %L', :'brand_b', 'alice@a.test'),
  '42501',
  null,
  'cross-brand UPDATE is rejected by the WITH CHECK clause'
);

select public.logout();
select is(
  (select brand_id from public.contacts where email = 'alice@a.test'),
  :'brand_a'::uuid,
  'the contact did NOT move to brand B'
);

-- Deletion must be impossible even for the row's own brand.
select public.login_as(:'owner_a');
select throws_ok(
  format('delete from public.contacts where email = %L', 'alice@a.test'),
  '42501',
  null,
  'DELETE is denied outright (no policy, no grant)'
);

-- The events backfill runs through an Edge Function holding the service role
-- precisely BECAUSE clients cannot write here. If this ever starts passing,
-- that design has been quietly undone and a client can fabricate delivery
-- figures, so the assertion belongs next to the isolation guards.
select throws_ok(
  format($q$insert into public.message_events
            (brand_id, campaign_id, provider_event_id, event_type, event_timestamp)
            values (%L, %L, 'EV-CLIENT-0001', 'open', now())$q$,
         :'brand_a', :'camp_a'),
  '42501',
  null,
  'an authenticated client cannot insert a message event'
);

-- Run with RLS bypassed (reset role) on purpose: the policy above already
-- stops clients, so this asserts the composite FK independently. It is the
-- structural half of brand-scoped resolution — the guarantee that even a
-- service-role importer resolving 'CT-005612' or 'KIL-0007' against the wrong
-- brand is refused by the database rather than filing one brand's engagement
-- under another's.
select public.logout();
select throws_ok(
  format($q$insert into public.message_events
            (brand_id, campaign_id, provider_event_id, event_type, event_timestamp)
            values (%L, %L, 'EV-CROSS-0001', 'open', now())$q$,
         :'brand_a', :'camp_b'),
  '23503',
  null,
  'an event cannot cite another brand''s campaign'
);
-- Section D expects owner A, as left by the tests above.
select public.login_as(:'owner_a');

-- =============================================================================
-- D. Double-send protection
-- =============================================================================
select lives_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count, recipient_snapshot, requested_by)
            values (%L, %L, 'send-key-0001', 2,
                    (select jsonb_agg(id) from public.contacts where brand_id = %L), %L)$q$,
         :'camp_a', :'brand_a', :'brand_a', :'owner_a'),
  'first send for a campaign is accepted'
);

-- A different idempotency key, i.e. a genuinely separate request — exactly the
-- case application-level "check then update" logic loses to.
select throws_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count, recipient_snapshot, requested_by)
            values (%L, %L, 'send-key-0002', 2, '["x","y"]'::jsonb, %L)$q$,
         :'camp_a', :'brand_a', :'owner_a'),
  '23505',
  null,
  'a second concurrent send for the same campaign is rejected by the database'
);

-- The displayed count cannot drift from the frozen snapshot it was taken from.
select throws_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count, recipient_snapshot, requested_by)
            values (%L, %L, 'send-key-0003', 999, '["x","y"]'::jsonb, %L)$q$,
         :'camp_a2', :'brand_a', :'owner_a'),
  '23514',
  null,
  'recipient_count cannot be inflated beyond the frozen snapshot'
);

-- An analyst must not be able to spend money.
select public.login_as(:'analyst_a');
select throws_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count, recipient_snapshot, requested_by)
            values (%L, %L, 'analyst-key-0001', 0, '[]'::jsonb, %L)$q$,
         :'camp_a2', :'brand_a', :'analyst_a'),
  '42501',
  null,
  'an analyst cannot create a send'
);

-- ---- is_backfill is a service-role-only flag ------------------------------
-- The guard index is predicated on `is_backfill = false`, so a client able to
-- set the flag could place a send outside the guard and let two concurrent
-- confirms both commit. It would also escape
-- campaign_sends_count_matches_snapshot. This row is otherwise valid — pending,
-- own brand, self-attributed — so the only thing that can reject it is the
-- is_backfill clause in campaign_sends_insert_own_brand_owner.
select public.login_as(:'owner_a');
select throws_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count,
             recipient_snapshot, requested_by, is_backfill)
            values (%L, %L, 'backfill-key-0001', 999, '[]'::jsonb, %L, true)$q$,
         :'camp_a2', :'brand_a', :'owner_a'),
  '42501',
  null,
  'an owner cannot mark a send as backfill and escape the double-send guard'
);

-- The legitimate path the flag exists for, proven not to have been broken by
-- closing that gap. camp_a already holds a live 'pending' send from the first
-- test in this section, and a historical campaign really was sent in several
-- batches, so both of these must land: the guard has to ignore backfill rows
-- entirely, in both directions.
select public.logout();
select lives_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, batch_key, status,
             recipient_count, recipient_snapshot, is_backfill)
            values (%L, %L, 'backfill:BATCH-9001', 'BATCH-9001', 'sent',
                    31205, '[]'::jsonb, true),
                   (%L, %L, 'backfill:BATCH-9002', 'BATCH-9002', 'sent',
                    12040, '[]'::jsonb, true)$q$,
         :'camp_a', :'brand_a', :'camp_a', :'brand_a'),
  'service_role can backfill several historical sends for one campaign'
);

-- And the guard still bites for live sends with those backfill rows present:
-- exempting history must not have released the slot camp_a's pending send
-- holds.
select public.login_as(:'owner_a');
select throws_ok(
  format($q$insert into public.campaign_sends
            (campaign_id, brand_id, idempotency_key, recipient_count, recipient_snapshot, requested_by)
            values (%L, %L, 'send-key-0004', 2, '["x","y"]'::jsonb, %L)$q$,
         :'camp_a', :'brand_a', :'owner_a'),
  '23505',
  null,
  'backfilled history does not release the live double-send slot'
);

-- =============================================================================
-- E. Shared link — happy path through the anonymous entry point
-- =============================================================================
-- Mint the links as owner A, i.e. through the real RLS-guarded path. Tokens are
-- generated by the database, so they have to be captured here rather than
-- hard-coded. \gset stashes each one in a psql variable.
select public.login_as(:'owner_a');

select public.create_shared_link(:'camp_a', :'share_pw')                             as tok_ok      \gset
-- camp_a2 deliberately has no campaign_sends row at all: every attempt to give
-- it one earlier in section D was supposed to be rejected. That makes it the
-- fixture for "no send was ever recorded".
select public.create_shared_link(:'camp_a2', :'share_pw')                            as tok_nosend  \gset
select public.create_shared_link(:'camp_a', :'share_pw')                             as tok_revoked \gset
select public.create_shared_link(:'camp_a', :'share_pw', now() - interval '1 hour')  as tok_expired \gset

-- Revoke the second link out-of-band, as the service role would.
select public.logout();
update public.shared_links set revoked_at = now() where token = :'tok_revoked';

-- Two backfill-shaped events, still RLS-bypassed: campaign_id set and
-- campaign_send_id left NULL, exactly as the CSV importer writes history.
-- One belongs to the linked campaign, one to a SIBLING campaign of the same
-- brand. contact_id is populated deliberately — every engagement figure is
-- count(distinct contact_id), so an event with a NULL contact contributes
-- nothing and would make this test pass for the wrong reason. The two events
-- use DIFFERENT contacts on purpose: with one shared contact, a join that
-- wrongly swept in the sibling campaign would still report 1 and the leak
-- would be invisible.
select id as contact_alice from public.contacts where email = 'alice@a.test' \gset
select id as contact_bob   from public.contacts where email = 'bob@a.test'   \gset

insert into public.message_events
  (brand_id, campaign_id, contact_id, provider_event_id, event_type, event_timestamp)
values
  (:'brand_a', :'camp_a',  :'contact_alice', 'EV-SHARE-BACKFILL-1', 'open', now()),
  (:'brand_a', :'camp_a2', :'contact_bob',   'EV-SHARE-SIBLING-1',  'open', now());

-- From here on: no JWT, no session, just the `anon` role.
select public.login_as_anon();

select is(
  (select count(*)::int from public.get_shared_campaign_results(:'tok_ok', :'share_pw')),
  1,
  'a valid token + password returns exactly one row to an anonymous caller'
);

select is(
  (select r.campaign_name from public.get_shared_campaign_results(:'tok_ok', :'share_pw') r),
  'Campaign A',
  'the returned campaign is the one the link points at'
);

-- The whole row, serialised, must not mention anything belonging to brand B or
-- to any campaign other than the linked one.
select ok(
  (select row_to_json(r)::text !~ '(Brand B|Campaign B|Campaign A2|brand-b|22222222-2222|cccccccc-cccc-cccc-cccc-bbbb)'
     from public.get_shared_campaign_results(:'tok_ok', :'share_pw') r),
  'the anonymous result mentions nothing from brand B or any other campaign'
);

-- Regression guard for the quietly-wrong-number bug. get_shared_campaign_results
-- once joined events on campaign_send_id alone, which is the live dispatcher's
-- linkage; the CSV backfill records campaign_id instead. The result was a real
-- Recipients figure beside zero engagement on every historical campaign — no
-- error, just plausible zeros, on the one screen an external client sees. The
-- assertions above cannot catch that: they check row count, campaign name and
-- leakage, and all three pass happily while every figure reads zero.
-- This single assertion pins both halves at once. Alice opened the linked
-- campaign, Bob opened the sibling. Exactly 1 means the backfill linkage is
-- counted; 0 means the old campaign_send_id-only join is back and history
-- reads zero; 2 means the widened predicate has started dragging in another
-- campaign's engagement.
select is(
  (select r.opened_count from public.get_shared_campaign_results(:'tok_ok', :'share_pw') r),
  1::bigint,
  'a backfill-linked event is counted, and a sibling campaign''s event is not'
);

-- "Not recorded" must stay distinguishable from "zero". camp_a2 has no send
-- row, so recipient_count has to arrive as NULL; a coalesce to 0 here would
-- tell an external client that nobody received a campaign whose recipient
-- count was merely never captured. The figure is also the one number on this
-- page a client is most likely to quote back, so a confident 0 is expensive.
select is(
  (select r.recipient_count from public.get_shared_campaign_results(:'tok_nosend', :'share_pw') r),
  null::integer,
  'a campaign with no recorded send reports NULL recipients, not a confident 0'
);

-- The corollary: a campaign that DOES have a recorded send still reports the
-- frozen number, so the change above did not blank out the real figure.
select isnt(
  (select r.recipient_count from public.get_shared_campaign_results(:'tok_ok', :'share_pw') r),
  null::integer,
  'a campaign with a recorded send still reports its frozen recipient count'
);

-- Structural: the return signature itself has no identifier the visitor could
-- pivot on. Adding brand_id or campaign_id to the OUT columns fails this.
select is(
  (select count(*)::int
     from pg_proc p,
          unnest(p.proargnames, p.proargmodes) as a(argname, argmode)
    where p.oid = to_regprocedure('public.get_shared_campaign_results(text,text)')::oid
      and a.argmode = 't'                      -- TABLE output columns only
      and a.argname in ('id','brand_id','campaign_id','contact_id','email',
                        'token','password_hash','recipient_snapshot')),
  0,
  'the share function''s return signature exposes no brand, campaign, contact or credential identifier'
);

-- =============================================================================
-- F. Shared link — failures must be indistinguishable
-- =============================================================================
-- Compared as message TEXT, in a single is(), rather than as two throws_ok
-- calls. Two separate throws_ok assertions would both still pass if the
-- messages drifted apart into "unknown link" and "wrong password", which is
-- precisely the leak that lets an attacker enumerate valid tokens.
select is(
  public.capture_error(
    format('select * from public.get_shared_campaign_results(%L, %L)',
           :'tok_ok', 'this-is-the-wrong-password')),
  'Invalid link or password',
  'a wrong password yields the generic error'
);

select is(
  public.capture_error(
    format('select * from public.get_shared_campaign_results(%L, %L)',
           :'tok_ok', 'this-is-the-wrong-password')),
  public.capture_error(
    format('select * from public.get_shared_campaign_results(%L, %L)',
           :'tok_missing', :'share_pw')),
  'wrong password and unknown token produce byte-identical messages'
);

-- =============================================================================
-- G. Shared link — revoked and expired links are dead
-- =============================================================================
-- Both reuse the correct password, so the only reason they can fail is the
-- link's own state. Both must fail with the same generic message pinned in F,
-- so a revoked link cannot be distinguished from one that never existed.
select is(
  public.capture_error(
    format('select * from public.get_shared_campaign_results(%L, %L)',
           :'tok_revoked', :'share_pw')),
  'Invalid link or password',
  'a revoked link fails with the same generic error'
);

select is(
  public.capture_error(
    format('select * from public.get_shared_campaign_results(%L, %L)',
           :'tok_expired', :'share_pw')),
  'Invalid link or password',
  'an expired link fails with the same generic error'
);

-- =============================================================================
-- H. profiles isolation
-- =============================================================================
-- profiles is the root of trust: auth_brand_id() reads it, so every other
-- policy in the schema inherits whatever isolation this table has.
select public.logout();
select public.login_as(:'owner_a');

select is(
  (select array_agg(p.id order by p.id) from public.profiles p),
  array[:'owner_a'::uuid, :'analyst_a'::uuid],
  'brand A owner sees exactly the two brand A profiles and no others'
);

select is(
  (select count(*)::int from public.profiles p where p.id = :'owner_b'),
  0,
  'the brand B owner''s profile is invisible even when addressed by primary key'
);

-- Writing a profile into another brand would mint a user inside brand B, which
-- auth_brand_id() would then honour everywhere. WITH CHECK stops it.
select throws_ok(
  format($q$insert into public.profiles (id, brand_id, role) values (%L, %L, 'analyst')$q$,
         :'newbie', :'brand_b'),
  '42501',
  null,
  'brand A owner cannot create a profile in brand B'
);

select public.logout();
select * from finish();

rollback;
