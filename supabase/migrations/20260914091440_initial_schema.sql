-- =============================================================================
-- vg-campaign-portal — Supabase schema
-- =============================================================================
-- REVIEW ONLY. This file has not been executed against any database.
--
-- Design rules enforced here (see .cursorrules):
--   1. Every table is brand-isolated by RLS. brand_id is NEVER taken from the
--      client; it is derived server-side from auth.uid() via public.profiles.
--   2. Double-sends are prevented by a DB-level partial UNIQUE INDEX, not by
--      application-level "check status then update".
--   3. Webhook events are deduplicated on the provider's event id and ordered
--      by the payload's event_timestamp, never by arrival order.
--   4. The recipient count shown at confirmation is frozen in
--      campaign_sends.recipient_snapshot and locked by a CHECK + a trigger.
--   5. No DELETE policies anywhere. RLS denies by default, so DELETE is
--      impossible through PostgREST. Rows are retired via status columns.
--   6. shared_links is deliberately structured differently from every other
--      table — see the big comment in section 11.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- 0. Extensions
-- -----------------------------------------------------------------------------
create schema if not exists extensions;

-- citext  -> case-insensitive email so Foo@x.com and foo@x.com are ONE contact,
--            which is what makes the (brand_id, email) upsert actually idempotent.
-- pgcrypto -> gen_random_bytes for share tokens, crypt()/gen_salt() for bcrypt
--            password hashing of shared links. Never store a plaintext password.
create extension if not exists citext with schema extensions;
create extension if not exists pgcrypto with schema extensions;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
create type public.user_role as enum ('owner', 'analyst');

create type public.campaign_status as enum (
  'draft',
  'scheduled',
  'sending',
  'sent',
  'failed',
  'archived'   -- soft-delete: there is no DELETE path, campaigns are archived
);

-- Terminal-failure statuses are ONLY 'failed' and 'canceled'. Everything else
-- ('pending', 'in_flight', 'sent') occupies the campaign's single send slot.
-- See the partial unique index in section 7 — this enum is load-bearing.
create type public.send_status as enum (
  'pending',
  'in_flight',
  'sent',
  'failed',
  'canceled'
);

create type public.import_status as enum ('pending', 'processing', 'completed', 'failed');

create type public.message_event_type as enum (
  'queued',
  'sent',
  'delivered',
  'read',
  'bounced',
  'failed',
  'complained',
  'unsubscribed'
);

-- -----------------------------------------------------------------------------
-- 2. Shared helpers
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- =============================================================================
-- 3. brands
-- =============================================================================
create table public.brands (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 120),
  slug        extensions.citext not null unique
                check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 4. profiles
-- =============================================================================
-- The single source of truth for "which brand does this user belong to".
-- Everything downstream reads brand_id from here, never from the request body.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  brand_id    uuid not null references public.brands (id),
  role        public.user_role not null default 'analyst',
  full_name   text check (full_name is null or length(btrim(full_name)) between 1 and 120),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index profiles_brand_id_idx on public.profiles (brand_id);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- A user's brand must never change: re-pointing a profile at another brand
-- would instantly re-key every RLS check for that user. Brand moves require a
-- deliberate service-role migration, not an UPDATE from the app.
create or replace function public.profiles_guard_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.brand_id is distinct from old.brand_id then
    raise exception 'profiles.brand_id is immutable (attempted % -> %)', old.brand_id, new.brand_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_immutable
  before update on public.profiles
  for each row execute function public.profiles_guard_immutable();

-- -----------------------------------------------------------------------------
-- 4b. Auth context functions (SECURITY DEFINER)
-- -----------------------------------------------------------------------------
-- These MUST be SECURITY DEFINER. They read public.profiles, and public.profiles
-- itself has RLS policies that call them. An invoker-rights function would
-- recurse infinitely ("infinite recursion detected in policy for relation
-- profiles"). Definer rights let the lookup bypass RLS and terminate.
--
-- search_path is pinned to '' and every object is schema-qualified so a caller
-- cannot shadow `profiles` with a temp table and impersonate another brand.
create or replace function public.auth_brand_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.brand_id
  from public.profiles p
  where p.id = (select auth.uid());
$$;

create or replace function public.auth_role()
returns public.user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid());
$$;

comment on function public.auth_brand_id() is
  'Server-side brand resolution from auth.uid(). The ONLY sanctioned source of brand_id. Returns NULL for anon, which makes every RLS comparison false.';

revoke execute on function public.auth_brand_id() from public;
revoke execute on function public.auth_role() from public;
grant execute on function public.auth_brand_id() to authenticated;
grant execute on function public.auth_role() to authenticated;

-- =============================================================================
-- 5. contacts
-- =============================================================================
create table public.contacts (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references public.brands (id),
  email             extensions.citext not null check (email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  full_name         text,
  phone             text,

  is_subscribed     boolean not null default true,
  unsubscribed_at   timestamptz,
  hard_bounced_at   timestamptz,
  suppressed_at     timestamptz,   -- manual suppression / soft-delete

  -- Single definition of "may we message this person", computed by the DB so
  -- the dashboard, the send snapshot and any ad-hoc query can never disagree.
  is_contactable    boolean not null
    generated always as (
      is_subscribed
      and unsubscribed_at is null
      and hard_bounced_at is null
      and suppressed_at   is null
    ) stored,

  -- PLACEHOLDER: the real CSV column set is not confirmed yet. Until it is,
  -- every non-core column lands here verbatim so no imported data is silently
  -- dropped. Promote fields to real columns once the CSV spec is locked.
  -- Expected shape, e.g.:
  --   {"company":"Acme","plan":"pro","signup_source":"webinar","city":"Riyadh"}
  raw_attrs         jsonb not null default '{}'::jsonb
                      check (jsonb_typeof(raw_attrs) = 'object'),

  source_batch_id   uuid,          -- FK added in section 6 (import_batches)
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- The idempotency anchor for CSV import: re-uploading the same file UPSERTs
  -- onto this constraint instead of creating duplicate contacts.
  constraint contacts_brand_email_key unique (brand_id, email),
  -- Lets child tables carry a composite FK so a row can never reference a
  -- parent belonging to a different brand.
  constraint contacts_id_brand_key unique (id, brand_id)
);

create index contacts_brand_contactable_idx
  on public.contacts (brand_id) where is_contactable;
create index contacts_brand_created_idx on public.contacts (brand_id, created_at desc);
create index contacts_raw_attrs_gin_idx on public.contacts using gin (raw_attrs);

create trigger contacts_set_updated_at
  before update on public.contacts
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 6. import_batches + import_errors
-- =============================================================================
create table public.import_batches (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references public.brands (id),
  uploaded_by       uuid not null references public.profiles (id),
  filename          text not null check (length(btrim(filename)) between 1 and 255),

  -- Hash of the uploaded file bytes. Re-uploading an identical file is still
  -- safe (row-level UPSERT handles that), but this lets the UI say
  -- "you already imported this file on <date>" instead of silently re-running.
  file_checksum     text check (file_checksum is null or file_checksum ~ '^[a-f0-9]{64}$'),

  status            public.import_status not null default 'pending',
  total_rows        integer not null default 0 check (total_rows >= 0),
  inserted_rows     integer not null default 0 check (inserted_rows >= 0),
  updated_rows      integer not null default 0 check (updated_rows >= 0),
  failed_rows       integer not null default 0 check (failed_rows >= 0),

  started_at        timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Accuracy guardrail: the per-row outcomes must add up to the row count we
  -- claim to have read. A batch that doesn't balance is a bug, not a rounding
  -- difference, and the DB refuses to record it.
  constraint import_batches_rows_balance
    check (inserted_rows + updated_rows + failed_rows <= total_rows),
  constraint import_batches_id_brand_key unique (id, brand_id)
);

create index import_batches_brand_created_idx
  on public.import_batches (brand_id, created_at desc);
create unique index import_batches_brand_checksum_idx
  on public.import_batches (brand_id, file_checksum)
  where file_checksum is not null and status = 'completed';

create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

alter table public.contacts
  add constraint contacts_source_batch_fkey
  foreign key (source_batch_id, brand_id)
  references public.import_batches (id, brand_id);

create table public.import_errors (
  id            uuid primary key default gen_random_uuid(),
  batch_id      uuid not null,
  brand_id      uuid not null references public.brands (id),
  row_number    integer not null check (row_number > 0),
  -- Rejected input is kept here as text and never written to contacts:
  -- "validate all user inputs, reject bad data instantly, do not store it".
  raw_row       jsonb not null default '{}'::jsonb,
  error_code    text not null check (length(btrim(error_code)) between 1 and 64),
  error_message text not null,
  created_at    timestamptz not null default now(),

  constraint import_errors_batch_fkey
    foreign key (batch_id, brand_id)
    references public.import_batches (id, brand_id),
  -- Re-processing a batch must not multiply its error rows.
  constraint import_errors_batch_row_key unique (batch_id, row_number)
);

create index import_errors_brand_batch_idx on public.import_errors (brand_id, batch_id);

-- =============================================================================
-- 7. campaigns
-- =============================================================================
create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  brand_id      uuid not null references public.brands (id),
  name          text not null check (length(btrim(name)) between 1 and 160),
  subject       text,
  body_template text,
  created_by    uuid references public.profiles (id),
  status        public.campaign_status not null default 'draft',

  -- PLACEHOLDER: audience targeting rules pending the confirmed CSV columns.
  -- e.g. {"all_contacts": true} or {"raw_attrs": {"plan": "pro"}}
  audience_filter jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(audience_filter) = 'object'),

  scheduled_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint campaigns_brand_name_key unique (brand_id, name),
  constraint campaigns_id_brand_key unique (id, brand_id)
);

create index campaigns_brand_status_idx on public.campaigns (brand_id, status, created_at desc);

create trigger campaigns_set_updated_at
  before update on public.campaigns
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 8. campaign_sends  — the money table
-- =============================================================================
create table public.campaign_sends (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null,
  brand_id          uuid not null references public.brands (id),

  -- Client-supplied per-attempt key. Uniqueness is per brand, so a retried or
  -- double-clicked request collides with its own earlier row instead of
  -- creating a second dispatch.
  idempotency_key   text not null check (length(btrim(idempotency_key)) between 8 and 200),

  status            public.send_status not null default 'pending',

  -- FROZEN AT CONFIRMATION TIME. recipient_snapshot is the exact list of
  -- contact ids the user agreed to send to, and recipient_count is its length.
  -- Neither is ever recomputed: if a contact unsubscribes between confirmation
  -- and dispatch the Edge Function filters at send time and records the
  -- difference, but the number shown on the confirmation screen stays the
  -- number the user saw.
  recipient_count   integer not null check (recipient_count >= 0),
  recipient_snapshot jsonb not null
                       check (jsonb_typeof(recipient_snapshot) = 'array'),

  provider_batch_id text,
  requested_by      uuid references public.profiles (id),
  error_message     text,

  dispatched_at     timestamptz,
  completed_at      timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint campaign_sends_campaign_fkey
    foreign key (campaign_id, brand_id)
    references public.campaigns (id, brand_id),

  -- The displayed count and the actual recipient list cannot drift apart:
  -- the DB rejects any row where they disagree. jsonb_array_length is
  -- immutable, so this is a legal CHECK.
  constraint campaign_sends_count_matches_snapshot
    check (recipient_count = jsonb_array_length(recipient_snapshot)),

  constraint campaign_sends_brand_idempotency_key
    unique (brand_id, idempotency_key),

  constraint campaign_sends_id_brand_key unique (id, brand_id)
);

-- ***** THE DOUBLE-SEND GUARD *****
-- At most ONE campaign_sends row per campaign may occupy a non-terminal-failure
-- status. 'pending', 'in_flight' and 'sent' all hold the slot; only 'failed'
-- and 'canceled' release it for a retry.
--
-- Two concurrent confirm requests both INSERT: one commits, the other gets a
-- unique_violation (SQLSTATE 23505) from Postgres itself. There is no window
-- between a check and a write, because there is no check — the constraint IS
-- the check. Application code must catch 23505 and show "this campaign is
-- already sending" rather than retrying.
--
-- The predicate is written as NOT IN rather than IN on purpose: any status
-- added to the enum later is covered by the guard by default (fail closed).
create unique index campaign_sends_one_active_per_campaign_idx
  on public.campaign_sends (campaign_id)
  where status not in ('failed', 'canceled');

create index campaign_sends_brand_status_idx
  on public.campaign_sends (brand_id, status, created_at desc);
create unique index campaign_sends_provider_batch_idx
  on public.campaign_sends (provider_batch_id)
  where provider_batch_id is not null;

create trigger campaign_sends_set_updated_at
  before update on public.campaign_sends
  for each row execute function public.set_updated_at();

-- Belt and braces around the frozen snapshot: the CHECK keeps count and list
-- consistent with each other, this keeps both consistent with what the user
-- actually confirmed. Also pins the identity/idempotency columns.
create or replace function public.campaign_sends_guard_immutable()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.campaign_id     is distinct from old.campaign_id
     or new.brand_id     is distinct from old.brand_id
     or new.idempotency_key is distinct from old.idempotency_key then
    raise exception 'campaign_sends identity columns are immutable'
      using errcode = 'check_violation';
  end if;

  if new.recipient_count    is distinct from old.recipient_count
     or new.recipient_snapshot is distinct from old.recipient_snapshot then
    raise exception 'recipient_count/recipient_snapshot are frozen at confirmation time and cannot be recomputed'
      using errcode = 'check_violation';
  end if;

  -- provider_batch_id is write-once: overwriting it would orphan the provider
  -- receipts already recorded against the old value.
  if old.provider_batch_id is not null
     and new.provider_batch_id is distinct from old.provider_batch_id then
    raise exception 'provider_batch_id is write-once'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger campaign_sends_guard_immutable
  before update on public.campaign_sends
  for each row execute function public.campaign_sends_guard_immutable();

-- =============================================================================
-- 9. message_events
-- =============================================================================
-- The provider's receipts arrive out of order and duplicated. This table is a
-- pure append-only log: dedupe on the provider's id, and derive state by
-- sorting on the payload's event_timestamp (see contact_latest_status).
create table public.message_events (
  id                 uuid primary key default gen_random_uuid(),
  brand_id           uuid not null references public.brands (id),
  campaign_send_id   uuid,
  contact_id         uuid,

  -- Dedupe key. A webhook redelivery INSERTs and hits this constraint, so the
  -- handler can treat 23505 as "already processed, ack with 200".
  provider_event_id  text not null
                       check (length(btrim(provider_event_id)) between 1 and 200),

  event_type         public.message_event_type not null,

  -- FROM THE PAYLOAD. This is the only field allowed to determine ordering.
  event_timestamp    timestamptz not null,
  -- When WE received it. Diagnostics only — never used for ordering, because
  -- HTTP arrival order is not chronological order.
  received_at        timestamptz not null default now(),

  payload            jsonb not null default '{}'::jsonb
                       check (jsonb_typeof(payload) = 'object'),

  constraint message_events_provider_event_id_key unique (provider_event_id),

  constraint message_events_send_fkey
    foreign key (campaign_send_id, brand_id)
    references public.campaign_sends (id, brand_id),
  constraint message_events_contact_fkey
    foreign key (contact_id, brand_id)
    references public.contacts (id, brand_id)
);

-- Supports the DISTINCT ON in contact_latest_status without a full sort.
create index message_events_contact_ts_idx
  on public.message_events (contact_id, event_timestamp desc)
  where contact_id is not null;
create index message_events_send_type_idx
  on public.message_events (campaign_send_id, event_type);
create index message_events_brand_ts_idx
  on public.message_events (brand_id, event_timestamp desc);

-- Append-only. Rewriting history would break every aggregate derived from it.
create or replace function public.message_events_reject_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'message_events is append-only; correct state by inserting a newer event'
    using errcode = 'check_violation';
end;
$$;

create trigger message_events_reject_update
  before update on public.message_events
  for each row execute function public.message_events_reject_update();

-- =============================================================================
-- 10. contact_latest_status (view)
-- =============================================================================
-- security_invoker = on is mandatory. Without it the view would execute with
-- the owner's rights and hand every brand's events to every caller — RLS on
-- message_events/contacts would be bypassed. With it, the underlying policies
-- still apply to whoever selects from the view.
--
-- COUNTING/ORDERING LOGIC (surface this wording in the UI tooltip):
--   * Rows are ranked by the provider's event_timestamp, descending. Arrival
--     order (received_at) is ignored entirely.
--   * 'unsubscribed' is STICKY and outranks everything, including events with a
--     later timestamp. A delivery receipt that arrives after an opt-out does
--     not make someone contactable again. This is a compliance decision, not a
--     recency decision.
--   * Ties on event_timestamp (the provider does emit identical timestamps)
--     break on received_at then provider_event_id, so the result is
--     deterministic and does not flip between refreshes.
create or replace view public.contact_latest_status
with (security_invoker = on) as
select distinct on (e.contact_id)
  e.contact_id,
  e.brand_id,
  c.email,
  c.is_contactable,
  e.event_type        as latest_event_type,
  e.event_timestamp   as latest_event_at,
  e.campaign_send_id  as latest_campaign_send_id,
  e.provider_event_id as latest_provider_event_id
from public.message_events e
join public.contacts c
  on c.id = e.contact_id
 and c.brand_id = e.brand_id
where e.contact_id is not null
order by
  e.contact_id,
  case when e.event_type = 'unsubscribed' then 0 else 1 end,  -- opt-out wins outright
  e.event_timestamp desc,                                     -- payload time, not arrival time
  e.received_at desc,
  e.provider_event_id desc;

comment on view public.contact_latest_status is
  'Latest state per contact. Ordered by payload event_timestamp; unsubscribed is sticky and outranks later events.';

-- =============================================================================
-- 11. shared_links
-- =============================================================================
-- >>> THIS TABLE'S RLS IS INTENTIONALLY STRUCTURED DIFFERENTLY FROM EVERY <<<
-- >>> OTHER TABLE IN THIS SCHEMA. READ BEFORE CHANGING.                   <<<
--
-- Why: every other table is read by a logged-in user, so auth_brand_id() is a
-- meaningful filter. A shared link is opened by an anonymous visitor with no
-- session at all — auth.uid() is NULL, so auth_brand_id() is NULL, and any
-- policy built on it evaluates to false for exactly the audience the feature
-- exists for. The tempting "fix" is a policy like `using (true)` for anon, or
-- `using (token = current_setting(...))`. Both are wrong: they grant the anon
-- role SELECT on the table, and PostgREST would then let a visitor page
-- through every brand's tokens and password hashes.
--
-- So: the anon role gets NO policy and NO grant on this table. Zero rows are
-- reachable. The only anonymous entry point is
-- public.get_shared_campaign_results(token, password) — SECURITY DEFINER, which
-- validates the token and the bcrypt password server-side and returns ONLY the
-- aggregated results of that one campaign. No raw table access, no other
-- campaign, no other brand.
--
-- The authenticated policies below DO use auth_brand_id(), and that is
-- deliberate: brand staff must be able to create and revoke their own links,
-- and dropping brand scoping there would let any logged-in user of brand A
-- mint or revoke a share link for brand B. The "no auth_brand_id()" rule
-- applies to the anonymous read path, which has no policy at all.
create table public.shared_links (
  id             uuid primary key default gen_random_uuid(),
  campaign_id    uuid not null,
  brand_id       uuid not null references public.brands (id),

  -- 32 bytes of CSPRNG entropy, hex-encoded. Unguessable, and generated by the
  -- DB so a client can never propose its own (predictable) token.
  token          text not null default encode(extensions.gen_random_bytes(32), 'hex')
                   check (token ~ '^[a-f0-9]{64}$'),

  -- bcrypt digest only. Written exclusively by public.create_shared_link();
  -- the plaintext password never reaches this table or any log.
  password_hash  text not null check (password_hash ~ '^\$2[aby]\$'),

  created_by     uuid references public.profiles (id),
  expires_at     timestamptz,
  revoked_at     timestamptz,          -- soft-delete; there is no DELETE path
  last_viewed_at timestamptz,
  view_count     integer not null default 0 check (view_count >= 0),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint shared_links_token_key unique (token),
  constraint shared_links_campaign_fkey
    foreign key (campaign_id, brand_id)
    references public.campaigns (id, brand_id)
);

create index shared_links_brand_campaign_idx on public.shared_links (brand_id, campaign_id);

create trigger shared_links_set_updated_at
  before update on public.shared_links
  for each row execute function public.set_updated_at();

-- =============================================================================
-- 12. Row Level Security
-- =============================================================================
alter table public.brands          enable row level security;
alter table public.profiles        enable row level security;
alter table public.contacts        enable row level security;
alter table public.import_batches  enable row level security;
alter table public.import_errors   enable row level security;
alter table public.campaigns       enable row level security;
alter table public.campaign_sends  enable row level security;
alter table public.message_events  enable row level security;
alter table public.shared_links    enable row level security;

-- NOTE ON "FORCE ROW LEVEL SECURITY": deliberately NOT used, and this is not an
-- oversight. FORCE only changes behaviour for the *table owner* (postgres).
-- anon and authenticated are never the owner, so FORCE buys nothing against the
-- actual threat model — but it would subject public.auth_brand_id() to the very
-- profiles policy that calls it (infinite recursion) and would blank out
-- public.get_shared_campaign_results(), since no policy here targets postgres.
-- Owner-rights access is the sanctioned, audited bypass; it is confined to the
-- three SECURITY DEFINER functions in this file.

-- NOTE ON DELETE: there is not a single DELETE policy in this file, by design.
-- With RLS enabled and no permissive DELETE policy, Postgres denies every
-- DELETE for anon/authenticated. The grants in section 14 also withhold the
-- DELETE privilege, so the API surface has two independent reasons to refuse.
-- Rows are retired via status/archived/revoked/suppressed columns instead.

-- ---- brands ------------------------------------------------------------
-- A user sees exactly one brand: their own.
create policy brands_select_own on public.brands
  for select to authenticated
  using (id = public.auth_brand_id());

-- Brand provisioning is an admin/service-role operation. Explicitly denied for
-- API clients rather than left to default-deny, so the intent is visible.
create policy brands_insert_denied on public.brands
  for insert to authenticated
  with check (false);

create policy brands_update_own_owner on public.brands
  for update to authenticated
  using  (id = public.auth_brand_id() and public.auth_role() = 'owner')
  with check (id = public.auth_brand_id() and public.auth_role() = 'owner');

-- ---- profiles ----------------------------------------------------------
create policy profiles_select_same_brand on public.profiles
  for select to authenticated
  using (brand_id = public.auth_brand_id());

-- Owners may add teammates, and only into their own brand. brand_id is checked
-- against auth_brand_id() rather than trusted from the payload.
-- The FIRST profile for a brand cannot be created this way (the creator has no
-- brand yet); bootstrap it with the service role or an on-signup trigger.
create policy profiles_insert_own_brand_owner on public.profiles
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and public.auth_role() = 'owner'
  );

-- Self-service profile edits, or an owner editing someone in their brand.
-- brand_id can't be moved regardless — the immutability trigger blocks it.
create policy profiles_update_self_or_owner on public.profiles
  for update to authenticated
  using (
    brand_id = public.auth_brand_id()
    and (id = (select auth.uid()) or public.auth_role() = 'owner')
  )
  with check (
    brand_id = public.auth_brand_id()
    and (id = (select auth.uid()) or public.auth_role() = 'owner')
  );

-- ---- contacts ----------------------------------------------------------
create policy contacts_select_own_brand on public.contacts
  for select to authenticated
  using (brand_id = public.auth_brand_id());

create policy contacts_insert_own_brand on public.contacts
  for insert to authenticated
  with check (brand_id = public.auth_brand_id());

-- WITH CHECK is what stops an UPDATE from moving a row into another brand:
-- USING gates which rows you may touch, WITH CHECK gates what they may become.
-- Both are required; either one alone is a hole.
create policy contacts_update_own_brand on public.contacts
  for update to authenticated
  using      (brand_id = public.auth_brand_id())
  with check (brand_id = public.auth_brand_id());

-- ---- import_batches ----------------------------------------------------
create policy import_batches_select_own_brand on public.import_batches
  for select to authenticated
  using (brand_id = public.auth_brand_id());

create policy import_batches_insert_own_brand on public.import_batches
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and uploaded_by = (select auth.uid())
  );

create policy import_batches_update_own_brand on public.import_batches
  for update to authenticated
  using      (brand_id = public.auth_brand_id())
  with check (brand_id = public.auth_brand_id());

-- ---- import_errors -----------------------------------------------------
create policy import_errors_select_own_brand on public.import_errors
  for select to authenticated
  using (brand_id = public.auth_brand_id());

create policy import_errors_insert_own_brand on public.import_errors
  for insert to authenticated
  with check (brand_id = public.auth_brand_id());

-- Error rows are a record of what happened. Editing them would make the
-- "N rows failed" figure disagree with the listed reasons.
create policy import_errors_update_denied on public.import_errors
  for update to authenticated
  using (false)
  with check (false);

-- ---- campaigns ---------------------------------------------------------
create policy campaigns_select_own_brand on public.campaigns
  for select to authenticated
  using (brand_id = public.auth_brand_id());

create policy campaigns_insert_own_brand on public.campaigns
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and status = 'draft'          -- campaigns cannot be born already 'sent'
  );

create policy campaigns_update_own_brand on public.campaigns
  for update to authenticated
  using      (brand_id = public.auth_brand_id())
  with check (brand_id = public.auth_brand_id());

-- ---- campaign_sends ----------------------------------------------------
create policy campaign_sends_select_own_brand on public.campaign_sends
  for select to authenticated
  using (brand_id = public.auth_brand_id());

-- Owners confirm a send by inserting a 'pending' row. The partial unique index
-- decides who wins if two requests race. Analysts cannot spend money.
create policy campaign_sends_insert_own_brand_owner on public.campaign_sends
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and public.auth_role() = 'owner'
    and status = 'pending'
    and requested_by = (select auth.uid())
  );

-- Deliberate hard deny for API clients. Status transitions belong to the Edge
-- Function (service_role) that talks to the provider and knows what actually
-- happened. If a client could set 'canceled' it could free the unique-index
-- slot for a send already handed to the provider and cause the exact
-- double-send this schema exists to prevent.
create policy campaign_sends_update_denied on public.campaign_sends
  for update to authenticated
  using (false)
  with check (false);

-- ---- message_events ----------------------------------------------------
create policy message_events_select_own_brand on public.message_events
  for select to authenticated
  using (brand_id = public.auth_brand_id());

-- Only the webhook handler (service_role) writes receipts. A client that could
-- insert events could fabricate delivery numbers.
create policy message_events_insert_denied on public.message_events
  for insert to authenticated
  with check (false);

create policy message_events_update_denied on public.message_events
  for update to authenticated
  using (false)
  with check (false);

-- ---- shared_links ------------------------------------------------------
-- Different in structure on purpose — see section 11. There is deliberately
-- NO policy for the anon role here; anonymous access happens only through
-- public.get_shared_campaign_results(). The policies below exist solely so
-- brand staff can manage their own links.
create policy shared_links_select_own_brand on public.shared_links
  for select to authenticated
  using (brand_id = public.auth_brand_id());

-- Creation goes through public.create_shared_link() so the password is hashed
-- server-side; this policy is the second line of defence if someone inserts
-- directly. It still cannot bypass the bcrypt-format CHECK on password_hash.
create policy shared_links_insert_own_brand_owner on public.shared_links
  for insert to authenticated
  with check (
    brand_id = public.auth_brand_id()
    and public.auth_role() = 'owner'
    and created_by = (select auth.uid())
  );

-- Revocation / expiry changes only. Owners stay inside their own brand.
create policy shared_links_update_own_brand_owner on public.shared_links
  for update to authenticated
  using      (brand_id = public.auth_brand_id() and public.auth_role() = 'owner')
  with check (brand_id = public.auth_brand_id() and public.auth_role() = 'owner');

-- =============================================================================
-- 13. Shared-link access functions
-- =============================================================================

-- Mint a link. Takes the plaintext password, returns the token; the plaintext
-- is hashed with bcrypt (cost 12) and immediately discarded. brand_id is
-- resolved from the campaign the caller can actually see, never from input.
create or replace function public.create_shared_link(
  p_campaign_id uuid,
  p_password    text,
  p_expires_at  timestamptz default null
)
returns text
language plpgsql
volatile
security invoker           -- invoker: the caller's own RLS must permit this
set search_path = ''
as $$
declare
  v_brand_id uuid;
  v_token    text;
begin
  if p_password is null or length(p_password) < 8 then
    raise exception 'Share password must be at least 8 characters'
      using errcode = 'check_violation';
  end if;

  -- Reads through the caller's RLS: a cross-brand campaign_id simply isn't
  -- visible, so this returns no row.
  select c.brand_id into v_brand_id
  from public.campaigns c
  where c.id = p_campaign_id;

  if v_brand_id is null then
    raise exception 'Campaign not found' using errcode = 'no_data_found';
  end if;

  insert into public.shared_links (campaign_id, brand_id, password_hash, created_by, expires_at)
  values (
    p_campaign_id,
    v_brand_id,
    extensions.crypt(p_password, extensions.gen_salt('bf', 12)),
    (select auth.uid()),
    p_expires_at
  )
  returning token into v_token;

  return v_token;
end;
$$;

revoke execute on function public.create_shared_link(uuid, text, timestamptz) from public;
grant execute on function public.create_shared_link(uuid, text, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- THE ONLY ANONYMOUS ENTRY POINT.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER because the anon role has no grant and no policy on
-- shared_links, campaigns or message_events — and must not have any. This
-- function is the entire attack surface of the share feature, so:
--   * it returns aggregates for ONE campaign, resolved from the token alone;
--   * the caller cannot pass a campaign_id, a brand_id or any filter;
--   * it emits no row counts, no contact rows, no emails, nothing about any
--     other campaign or brand;
--   * failures are indistinguishable from each other ("Invalid link or
--     password") so the token space cannot be probed;
--   * search_path is pinned to '' so nothing here can be shadowed.
create or replace function public.get_shared_campaign_results(
  p_token    text,
  p_password text
)
returns table (
  campaign_name    text,
  campaign_status  public.campaign_status,
  sent_at          timestamptz,
  recipient_count  integer,
  delivered_count  bigint,
  read_count       bigint,
  bounced_count    bigint,
  failed_count     bigint,
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
  --     provider redelivers receipts and a contact who opens twice is one read.
  --   * a contact can appear in more than one column (delivered AND read); the
  --     columns are independent facts, they are not a partition of
  --     recipient_count and are not expected to sum to it.
  return query
  select
    c.name,
    c.status,
    v_send.completed_at,
    coalesce(v_send.recipient_count, 0),
    count(distinct me.contact_id) filter (where me.event_type = 'delivered'),
    count(distinct me.contact_id) filter (where me.event_type = 'read'),
    count(distinct me.contact_id) filter (where me.event_type = 'bounced'),
    count(distinct me.contact_id) filter (where me.event_type = 'failed'),
    count(distinct me.contact_id) filter (where me.event_type = 'unsubscribed')
  from public.campaigns c
  left join public.message_events me
    on me.campaign_send_id = v_send.id
  where c.id = v_link.campaign_id      -- scoped to this one campaign, always
  group by c.name, c.status;
end;
$$;

revoke execute on function public.get_shared_campaign_results(text, text) from public;
grant execute on function public.get_shared_campaign_results(text, text) to anon, authenticated;

comment on function public.get_shared_campaign_results(text, text) is
  'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. The anon role has no direct access to shared_links.';

-- =============================================================================
-- 14. Grants
-- =============================================================================
-- Supabase grants broadly to anon/authenticated by default. Reset first, then
-- hand back only what each role needs. DELETE is never granted to anyone: it
-- is blocked both here and by the absence of DELETE policies.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from anon;

-- Re-granted after the blanket revoke above, which would otherwise strip the
-- grant made in section 13. This single EXECUTE is anon's entire capability.
grant execute on function public.get_shared_campaign_results(text, text) to anon;

grant usage on schema public to anon, authenticated;
grant usage on schema extensions to authenticated;

grant select                 on public.brands          to authenticated;
grant update                 on public.brands          to authenticated;
grant select, insert, update on public.profiles        to authenticated;
grant select, insert, update on public.contacts        to authenticated;
grant select, insert, update on public.import_batches  to authenticated;
grant select, insert         on public.import_errors   to authenticated;
grant select, insert, update on public.campaigns       to authenticated;
grant select, insert         on public.campaign_sends  to authenticated;
grant select                 on public.message_events  to authenticated;
grant select, insert, update on public.shared_links    to authenticated;
grant select                 on public.contact_latest_status to authenticated;

-- anon gets nothing at all. Its only capability is EXECUTE on
-- public.get_shared_campaign_results(), granted in section 13.

commit;
