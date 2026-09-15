-- =============================================================================
-- contacts.signup_at — promote the CSV signup date to a real column
-- =============================================================================
-- Until now the import parser routed signup_at / signup_date into raw_attrs.
-- Lossless, but unusable for the dashboard's "signups per day over the last 30
-- days": aggregating it would mean casting raw_attrs->>'signup_at' to
-- timestamptz on every row, which no index can serve, on top of a table where
-- one brand alone carries tens of thousands of rows.
--
-- Nullable on purpose. Not every source file carries a signup date, and a NOT
-- NULL column would force the parser to invent one — exactly the kind of
-- quietly-wrong value the dashboard would then present as fact.
--
-- ADD COLUMN with no default is a catalog-only change: no table rewrite, no
-- long lock. The CREATE INDEX below is NOT concurrent, because `supabase db
-- push` wraps each migration in a transaction and CREATE INDEX CONCURRENTLY
-- cannot run inside one. On the current row counts that is a non-issue; if this
-- ever lands on a large populated table, split the index into its own
-- out-of-transaction step instead of relaxing the guarantees here.
-- =============================================================================

alter table public.contacts
  add column signup_at timestamptz;

comment on column public.contacts.signup_at is
  'When the contact signed up, from the source CSV (signup_at / signup_date). Parsed to a real timestamptz by the import parser; only ISO-8601 input is accepted, because DD/MM/YYYY and MM/DD/YYYY are indistinguishable and a guess here would silently move signups between days on the dashboard. NULL means the file did not say.';

-- -----------------------------------------------------------------------------
-- Index choice: plain btree on (brand_id, signup_at), partial.
-- -----------------------------------------------------------------------------
-- The dashboard query is brand-scoped and range-scoped:
--
--   select date_trunc('day', signup_at), count(*)
--     from public.contacts
--    where brand_id = public.auth_brand_id()
--      and signup_at >= now() - interval '30 days'
--    group by 1;
--
-- What needs the index is the WHERE clause, and this serves it as a single
-- index range scan: brand_id equality then signup_at range. The GROUP BY then
-- buckets a result set already cut down to 30 days, so it is cheap regardless
-- of how large the table gets.
--
-- A date_trunc expression index was considered and rejected. It is possible on
-- PG17 — the two-argument date_trunc(text, timestamptz) is STABLE and would be
-- refused in an index expression, but the three-argument
-- date_trunc('day', signup_at, 'UTC') form is IMMUTABLE and indexable. It is
-- still the wrong choice today:
--   * it would not help the 30-day range predicate, which is the selective part;
--   * it only pays off if queries literally group on that same expression;
--   * it hard-codes WHOSE midnight a "day" is into the schema. Marrakech and
--     Kilele are in different offsets, so that is a product decision about how
--     signups are reported, not an indexing detail, and baking it into an index
--     now would quietly settle it.
-- If day-bucket aggregation over full history ever becomes the hot path, a
-- rollup table beats either index.
--
-- Partial (signup_at is not null) so contacts from files without a signup date
-- stay out of it entirely.
create index contacts_brand_signup_at_idx
  on public.contacts (brand_id, signup_at)
  where signup_at is not null;

-- -----------------------------------------------------------------------------
-- Backfill anything an earlier import already parked in raw_attrs
-- -----------------------------------------------------------------------------
-- Guarded by a strict ISO-8601 pattern rather than a bare ::timestamptz cast:
-- an unparseable string would abort the whole migration, and an ambiguous one
-- (06/02/2026) would be silently resolved by Postgres's DateStyle — the same
-- guess the parser now refuses to make. Anything not matching is left in
-- raw_attrs untouched, so nothing is lost and nothing is invented.
--
-- The key is dropped from raw_attrs in the same statement, so the value lives
-- in exactly one place afterwards.
update public.contacts
   set signup_at = (raw_attrs ->> 'signup_at')::timestamptz,
       raw_attrs = raw_attrs - 'signup_at'
 where raw_attrs ? 'signup_at'
   and raw_attrs ->> 'signup_at' ~
       '^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?)?$';
