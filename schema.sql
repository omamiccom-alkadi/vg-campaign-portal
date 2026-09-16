


SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE TYPE "public"."campaign_status" AS ENUM (
    'draft',
    'scheduled',
    'sending',
    'sent',
    'failed',
    'archived'
);


ALTER TYPE "public"."campaign_status" OWNER TO "postgres";


CREATE TYPE "public"."import_status" AS ENUM (
    'pending',
    'processing',
    'completed',
    'failed'
);


ALTER TYPE "public"."import_status" OWNER TO "postgres";


CREATE TYPE "public"."send_status" AS ENUM (
    'pending',
    'in_flight',
    'sent',
    'failed',
    'canceled'
);


ALTER TYPE "public"."send_status" OWNER TO "postgres";


CREATE TYPE "public"."user_role" AS ENUM (
    'owner',
    'analyst'
);


ALTER TYPE "public"."user_role" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auth_brand_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.brand_id
  from public.profiles p
  where p.id = (select auth.uid());
$$;


ALTER FUNCTION "public"."auth_brand_id"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."auth_brand_id"() IS 'Server-side brand resolution from auth.uid(). The ONLY sanctioned source of brand_id. Returns NULL for anon, which makes every RLS comparison false.';



CREATE OR REPLACE FUNCTION "public"."auth_role"() RETURNS "public"."user_role"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid());
$$;


ALTER FUNCTION "public"."auth_role"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."campaign_sends_guard_immutable"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."campaign_sends_guard_immutable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."create_shared_link"("p_campaign_id" "uuid", "p_password" "text", "p_expires_at" timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS "text"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."create_shared_link"("p_campaign_id" "uuid", "p_password" "text", "p_expires_at" timestamp with time zone) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."event_severity"("p_event_type" "text") RETURNS integer
    LANGUAGE "sql" IMMUTABLE PARALLEL SAFE
    SET "search_path" TO ''
    AS $$
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


ALTER FUNCTION "public"."event_severity"("p_event_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") RETURNS TABLE("campaign_name" "text", "campaign_status" "public"."campaign_status", "sent_at" timestamp with time zone, "recipient_count" integer, "delivered_count" bigint, "delivery_tracked" boolean, "opened_count" bigint, "clicked_count" bigint, "bounced_count" bigint, "complained_count" bigint, "unsubscribed_count" bigint)
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $_$
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
$_$;


ALTER FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") IS 'Anonymous share-link read path. Validates token + bcrypt password server-side and returns aggregates for exactly one campaign. Events match on campaign_send_id (live) OR campaign_id (CSV backfill). recipient_count is NULL rather than 0 when no send was recorded, and delivery_tracked is false when no delivered figure was ever collectable, so the UI can distinguish absent figures from measured zeros. The anon role has no direct access to shared_links.';



CREATE OR REPLACE FUNCTION "public"."message_events_reject_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  raise exception 'message_events is append-only; correct state by inserting a newer event'
    using errcode = 'check_violation';
end;
$$;


ALTER FUNCTION "public"."message_events_reject_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."profiles_guard_immutable"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  if new.brand_id is distinct from old.brand_id then
    raise exception 'profiles.brand_id is immutable (attempted % -> %)', old.brand_id, new.brand_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;


ALTER FUNCTION "public"."profiles_guard_immutable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."rls_auto_enable"() RETURNS "event_trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$$;


ALTER FUNCTION "public"."rls_auto_enable"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    SET "search_path" TO ''
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."brands" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "extensions"."citext" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "brands_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 120))),
    CONSTRAINT "brands_slug_check" CHECK ((("slug")::"text" ~ '^[a-z0-9]+(-[a-z0-9]+)*$'::"text"))
);


ALTER TABLE "public"."brands" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."campaign_sends" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "status" "public"."send_status" DEFAULT 'pending'::"public"."send_status" NOT NULL,
    "recipient_count" integer NOT NULL,
    "recipient_snapshot" "jsonb" NOT NULL,
    "provider_batch_id" "text",
    "requested_by" "uuid",
    "error_message" "text",
    "dispatched_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_backfill" boolean DEFAULT false NOT NULL,
    "batch_key" "text",
    "dispatch_summary" "jsonb",
    "last_event_cursor" "text",
    "last_polled_at" timestamp with time zone,
    CONSTRAINT "campaign_sends_count_matches_snapshot" CHECK (("is_backfill" OR ("recipient_count" = "jsonb_array_length"("recipient_snapshot")))),
    CONSTRAINT "campaign_sends_dispatch_summary_check" CHECK ((("dispatch_summary" IS NULL) OR ("jsonb_typeof"("dispatch_summary") = 'object'::"text"))),
    CONSTRAINT "campaign_sends_idempotency_key_check" CHECK ((("length"("btrim"("idempotency_key")) >= 8) AND ("length"("btrim"("idempotency_key")) <= 200))),
    CONSTRAINT "campaign_sends_recipient_count_check" CHECK (("recipient_count" >= 0)),
    CONSTRAINT "campaign_sends_recipient_snapshot_check" CHECK (("jsonb_typeof"("recipient_snapshot") = 'array'::"text"))
);


ALTER TABLE "public"."campaign_sends" OWNER TO "postgres";


COMMENT ON COLUMN "public"."campaign_sends"."is_backfill" IS 'True only for historically imported sends. Exempts the row from the recipient_count = snapshot length check. Must never be set on a live send.';



COMMENT ON COLUMN "public"."campaign_sends"."dispatch_summary" IS 'What the dispatcher was actually asked to send, versus what the owner approved. NULL until dispatch is attempted. Keys: requested (= recipient_count, the frozen approved figure), dispatched (how many were handed to the provider), skipped_suppressed (approved but no longer sendable when dispatch ran), skipped_not_in_brand (ids in the snapshot that do not belong to this brand - always 0 unless a client was tampered with), provider_accepted, provider_rejected. requested is never recalculated: it is copied from the frozen count so the gap between approval and delivery is legible in one row without a join.';



COMMENT ON COLUMN "public"."campaign_sends"."last_event_cursor" IS 'The provider event_id last processed for this send, passed back as `since` on the next poll. An optimisation, not a guarantee: duplicate protection is the unique index on (brand_id, provider_event_id) and ordering comes from event_timestamp in the payload, so a stale or lost cursor only causes re-reads.';



COMMENT ON COLUMN "public"."campaign_sends"."last_polled_at" IS 'When delivery reports were last fetched for this send. Shown in the UI so "no new events" can be distinguished from "never checked".';



CREATE TABLE IF NOT EXISTS "public"."campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "subject" "text",
    "body_template" "text",
    "created_by" "uuid",
    "status" "public"."campaign_status" DEFAULT 'draft'::"public"."campaign_status" NOT NULL,
    "audience_filter" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_id" "text",
    "channel" "text",
    "target_country" "text",
    "reported_sent" integer,
    "reported_delivered" integer,
    "reported_bounced" integer,
    "reported_opens" integer,
    "reported_clicks" integer,
    "spend" numeric(12,2),
    "sent_at_utc" timestamp with time zone,
    "send_local_time" "text",
    "parent_campaign_id" "uuid",
    "source_batch_id" "uuid",
    CONSTRAINT "campaigns_audience_filter_check" CHECK (("jsonb_typeof"("audience_filter") = 'object'::"text")),
    CONSTRAINT "campaigns_name_check" CHECK ((("length"("btrim"("name")) >= 1) AND ("length"("btrim"("name")) <= 160))),
    CONSTRAINT "campaigns_parent_not_self" CHECK ((("parent_campaign_id" IS NULL) OR ("parent_campaign_id" <> "id"))),
    CONSTRAINT "campaigns_reported_bounced_check" CHECK ((("reported_bounced" IS NULL) OR ("reported_bounced" >= 0))),
    CONSTRAINT "campaigns_reported_clicks_check" CHECK ((("reported_clicks" IS NULL) OR ("reported_clicks" >= 0))),
    CONSTRAINT "campaigns_reported_delivered_check" CHECK ((("reported_delivered" IS NULL) OR ("reported_delivered" >= 0))),
    CONSTRAINT "campaigns_reported_opens_check" CHECK ((("reported_opens" IS NULL) OR ("reported_opens" >= 0))),
    CONSTRAINT "campaigns_reported_sent_check" CHECK ((("reported_sent" IS NULL) OR ("reported_sent" >= 0))),
    CONSTRAINT "campaigns_spend_check" CHECK ((("spend" IS NULL) OR ("spend" >= (0)::numeric)))
);


ALTER TABLE "public"."campaigns" OWNER TO "postgres";


COMMENT ON COLUMN "public"."campaigns"."reported_sent" IS 'Client-reported figure from the source CSV. Not derived from message_events. Display separately from event-derived counts; never combine the two.';



COMMENT ON COLUMN "public"."campaigns"."source_batch_id" IS 'The import batch that last wrote this row, or NULL for a campaign that no import produced (created in the UI, or imported before this column existed). Composite FK on (id, brand_id), so a campaign can only ever cite its own brand''s batch.';



CREATE TABLE IF NOT EXISTS "public"."message_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "campaign_send_id" "uuid",
    "contact_id" "uuid",
    "provider_event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_timestamp" timestamp with time zone NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "campaign_id" "uuid",
    "source_batch_id" "uuid",
    CONSTRAINT "message_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['open'::"text", 'click'::"text", 'bounce'::"text", 'complaint'::"text", 'unsubscribe'::"text", 'delivered'::"text", 'bounced'::"text", 'opened'::"text", 'unsubscribed'::"text"]))),
    CONSTRAINT "message_events_payload_check" CHECK (("jsonb_typeof"("payload") = 'object'::"text")),
    CONSTRAINT "message_events_provider_event_id_check" CHECK ((("length"("btrim"("provider_event_id")) >= 1) AND ("length"("btrim"("provider_event_id")) <= 200)))
);


ALTER TABLE "public"."message_events" OWNER TO "postgres";


COMMENT ON COLUMN "public"."message_events"."provider_event_id" IS 'The provider''s own event id, stored verbatim — never prefixed or rewritten, because the live webhook sends the bare id and must hit the same key as the backfill. Unique per BRAND, not globally: the historical files prove the id space is reused across brands, and a global key would let one tenant block another tenant''s writes. A redelivery is always for the same brand, so per-brand scope still makes dedupe exact where it matters. Webhook handlers should continue to treat 23505 on this constraint as "already processed, ack 200".';



COMMENT ON COLUMN "public"."message_events"."event_type" IS 'Free text constrained by CHECK. Two vocabularies coexist: the historical CSVs use open/click/bounce/complaint/unsubscribe, the live dispatcher uses delivered/bounced/opened/unsubscribed. Use public.event_severity() to compare across them.';



COMMENT ON COLUMN "public"."message_events"."campaign_id" IS 'The campaign this event belongs to, or NULL when the source file named a campaign we do not hold. Set at INSERT only — message_events_reject_update blocks every UPDATE, so this cannot be backfilled later without disabling that trigger. Where campaign_send_id is also present the two must agree; the live dispatcher path sets campaign_send_id and historical CSV backfill sets campaign_id. Nothing enforces agreement, because a per-row trigger would cost more on bulk backfill than the case is worth — importers must set exactly one.';



COMMENT ON COLUMN "public"."message_events"."source_batch_id" IS 'The import batch that loaded this event, or NULL for events the live webhook delivered. Composite FK on (id, brand_id), so an event can only cite its own brand''s batch.';



CREATE OR REPLACE VIEW "public"."campaign_performance" WITH ("security_invoker"='on') AS
 SELECT "c"."id" AS "campaign_id",
    "c"."brand_id",
    "c"."external_id",
    "c"."name",
    "c"."status",
    "c"."sent_at_utc",
    "c"."spend",
    "c"."reported_sent",
    "c"."reported_opens",
    "c"."reported_clicks",
    COALESCE("s"."backfill_recipients", (0)::bigint) AS "backfill_recipients",
    COALESCE("s"."live_recipients", (0)::bigint) AS "live_recipients",
    COALESCE("s"."backfill_batches", (0)::bigint) AS "backfill_batches",
    COALESCE("e"."events_total", (0)::bigint) AS "events_total",
    COALESCE("e"."event_opens", (0)::bigint) AS "event_opens",
    COALESCE("e"."event_clicks", (0)::bigint) AS "event_clicks",
    COALESCE("e"."event_bounces", (0)::bigint) AS "event_bounces"
   FROM (("public"."campaigns" "c"
     LEFT JOIN LATERAL ( SELECT "sum"("cs"."recipient_count") FILTER (WHERE "cs"."is_backfill") AS "backfill_recipients",
            "sum"("cs"."recipient_count") FILTER (WHERE (NOT "cs"."is_backfill")) AS "live_recipients",
            "count"(*) FILTER (WHERE "cs"."is_backfill") AS "backfill_batches"
           FROM "public"."campaign_sends" "cs"
          WHERE (("cs"."campaign_id" = "c"."id") AND ("cs"."brand_id" = "c"."brand_id"))) "s" ON (true))
     LEFT JOIN LATERAL ( SELECT "count"(*) AS "events_total",
            "count"(*) FILTER (WHERE ("me"."event_type" = ANY (ARRAY['open'::"text", 'opened'::"text"]))) AS "event_opens",
            "count"(*) FILTER (WHERE ("me"."event_type" = 'click'::"text")) AS "event_clicks",
            "count"(*) FILTER (WHERE ("me"."event_type" = ANY (ARRAY['bounce'::"text", 'bounced'::"text"]))) AS "event_bounces"
           FROM "public"."message_events" "me"
          WHERE (("me"."campaign_id" = "c"."id") AND ("me"."brand_id" = "c"."brand_id"))) "e" ON (true));


ALTER VIEW "public"."campaign_performance" OWNER TO "postgres";


COMMENT ON VIEW "public"."campaign_performance" IS 'Per-campaign totals from three independent sources, held apart on purpose: reported_* is the source CSV''s own claim, *_recipients comes from campaign_sends, and event_* is derived from message_events. They disagree for every campaign in the seed data and must never be combined into one number — present them side by side, captioned with their source.';



CREATE TABLE IF NOT EXISTS "public"."contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "email" "extensions"."citext" NOT NULL,
    "full_name" "text",
    "phone" "text",
    "is_subscribed" boolean DEFAULT true NOT NULL,
    "raw_attrs" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source_batch_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "external_id" "text",
    "country" "text",
    "city" "text",
    "consent_marketing" boolean DEFAULT false NOT NULL,
    "suppressed_until" timestamp with time zone,
    "deleted_at" timestamp with time zone,
    "notes" "text",
    "is_contactable" boolean GENERATED ALWAYS AS (("is_subscribed" AND ("email" IS NOT NULL) AND ("deleted_at" IS NULL) AND "consent_marketing")) STORED NOT NULL,
    "signup_at" timestamp with time zone,
    CONSTRAINT "contacts_email_check" CHECK ((("email")::"text" ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'::"text")),
    CONSTRAINT "contacts_raw_attrs_check" CHECK (("jsonb_typeof"("raw_attrs") = 'object'::"text"))
);


ALTER TABLE "public"."contacts" OWNER TO "postgres";


COMMENT ON COLUMN "public"."contacts"."consent_marketing" IS 'Clean boolean only. Raw CSV tokens (1/TRUE/f/Y/no/false) are normalised in the import parser; unrecognised tokens are rejected to import_errors, never defaulted.';



COMMENT ON COLUMN "public"."contacts"."is_contactable" IS 'STATIC preconditions only (subscribed, not deleted, consented). NOT the audience gate — it cannot see message_events or the clock. Use public.contact_sendability.is_sendable_now to pick recipients.';



COMMENT ON COLUMN "public"."contacts"."signup_at" IS 'When the contact signed up, from the source CSV (signup_at / signup_date). Parsed to a real timestamptz by the import parser; only ISO-8601 input is accepted, because DD/MM/YYYY and MM/DD/YYYY are indistinguishable and a guess here would silently move signups between days on the dashboard. NULL means the file did not say.';



CREATE OR REPLACE VIEW "public"."contact_latest_status" WITH ("security_invoker"='on') AS
 SELECT DISTINCT ON ("e"."contact_id") "e"."contact_id",
    "e"."brand_id",
    "c"."email",
    "c"."is_contactable",
    "e"."event_type" AS "latest_event_type",
    "public"."event_severity"("e"."event_type") AS "latest_event_severity",
    "e"."event_timestamp" AS "latest_event_at",
    "e"."campaign_send_id" AS "latest_campaign_send_id",
    "e"."provider_event_id" AS "latest_provider_event_id"
   FROM ("public"."message_events" "e"
     JOIN "public"."contacts" "c" ON ((("c"."id" = "e"."contact_id") AND ("c"."brand_id" = "e"."brand_id"))))
  WHERE ("e"."contact_id" IS NOT NULL)
  ORDER BY "e"."contact_id", ("public"."event_severity"("e"."event_type")), "e"."event_timestamp" DESC, "e"."received_at" DESC, "e"."provider_event_id" DESC;


ALTER VIEW "public"."contact_latest_status" OWNER TO "postgres";


COMMENT ON VIEW "public"."contact_latest_status" IS 'Most significant state per contact. Ranked by event_severity (complaint > unsubscribe > bounce > click > open > delivered), then by payload event_timestamp. A milder later event never overrides a severer earlier one.';



CREATE OR REPLACE VIEW "public"."contact_sendability" WITH ("security_invoker"='on') AS
 SELECT "c"."id" AS "contact_id",
    "c"."brand_id",
    "c"."email",
    "c"."external_id",
    "c"."is_contactable" AS "passes_static_checks",
    (("c"."suppressed_until" IS NULL) OR ("c"."suppressed_until" < "now"())) AS "suppression_window_elapsed",
    "s"."no_suppressing_event",
    ("c"."is_contactable" AND (("c"."suppressed_until" IS NULL) OR ("c"."suppressed_until" < "now"())) AND "s"."no_suppressing_event") AS "is_sendable_now"
   FROM ("public"."contacts" "c"
     CROSS JOIN LATERAL ( SELECT (NOT (EXISTS ( SELECT 1
                   FROM "public"."message_events" "me"
                  WHERE (("me"."contact_id" = "c"."id") AND ("me"."brand_id" = "c"."brand_id") AND ("me"."event_type" = ANY (ARRAY['bounce'::"text", 'bounced'::"text", 'complaint'::"text", 'unsubscribe'::"text", 'unsubscribed'::"text"])))))) AS "no_suppressing_event") "s");


ALTER VIEW "public"."contact_sendability" OWNER TO "postgres";


COMMENT ON VIEW "public"."contact_sendability" IS 'One row per contact. is_sendable_now is the ONLY sanctioned audience gate: static consent checks AND the suppression window AND the absence of any bounce/complaint/unsubscribe event, in either vocabulary.';



CREATE TABLE IF NOT EXISTS "public"."import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "uploaded_by" "uuid" NOT NULL,
    "filename" "text" NOT NULL,
    "file_checksum" "text",
    "status" "public"."import_status" DEFAULT 'pending'::"public"."import_status" NOT NULL,
    "total_rows" integer DEFAULT 0 NOT NULL,
    "inserted_rows" integer DEFAULT 0 NOT NULL,
    "updated_rows" integer DEFAULT 0 NOT NULL,
    "failed_rows" integer DEFAULT 0 NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "entity" "text" DEFAULT 'contacts'::"text" NOT NULL,
    CONSTRAINT "import_batches_entity_check" CHECK (("entity" = ANY (ARRAY['contacts'::"text", 'campaigns'::"text", 'events'::"text", 'sends'::"text"]))),
    CONSTRAINT "import_batches_failed_rows_check" CHECK (("failed_rows" >= 0)),
    CONSTRAINT "import_batches_file_checksum_check" CHECK ((("file_checksum" IS NULL) OR ("file_checksum" ~ '^[a-f0-9]{64}$'::"text"))),
    CONSTRAINT "import_batches_filename_check" CHECK ((("length"("btrim"("filename")) >= 1) AND ("length"("btrim"("filename")) <= 255))),
    CONSTRAINT "import_batches_inserted_rows_check" CHECK (("inserted_rows" >= 0)),
    CONSTRAINT "import_batches_rows_balance" CHECK (((("inserted_rows" + "updated_rows") + "failed_rows") <= "total_rows")),
    CONSTRAINT "import_batches_total_rows_check" CHECK (("total_rows" >= 0)),
    CONSTRAINT "import_batches_updated_rows_check" CHECK (("updated_rows" >= 0))
);


ALTER TABLE "public"."import_batches" OWNER TO "postgres";


COMMENT ON COLUMN "public"."import_batches"."entity" IS 'Which table this batch loaded. Defaults to contacts so rows predating this column keep their meaning. Readers MUST filter on it: an import_errors row is only interpretable alongside its batch entity, since row_number and raw_row mean different things per source file.';



CREATE TABLE IF NOT EXISTS "public"."import_errors" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "row_number" integer NOT NULL,
    "raw_row" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "error_code" "text" NOT NULL,
    "error_message" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "import_errors_error_code_check" CHECK ((("length"("btrim"("error_code")) >= 1) AND ("length"("btrim"("error_code")) <= 64))),
    CONSTRAINT "import_errors_row_number_check" CHECK (("row_number" > 0))
);


ALTER TABLE "public"."import_errors" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "role" "public"."user_role" DEFAULT 'analyst'::"public"."user_role" NOT NULL,
    "full_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "profiles_full_name_check" CHECK ((("full_name" IS NULL) OR (("length"("btrim"("full_name")) >= 1) AND ("length"("btrim"("full_name")) <= 120))))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."shared_links" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid" NOT NULL,
    "brand_id" "uuid" NOT NULL,
    "token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'hex'::"text") NOT NULL,
    "password_hash" "text" NOT NULL,
    "created_by" "uuid",
    "expires_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "last_viewed_at" timestamp with time zone,
    "view_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "shared_links_password_hash_check" CHECK (("password_hash" ~ '^\$2[aby]\$'::"text")),
    CONSTRAINT "shared_links_token_check" CHECK (("token" ~ '^[a-f0-9]{64}$'::"text")),
    CONSTRAINT "shared_links_view_count_check" CHECK (("view_count" >= 0))
);


ALTER TABLE "public"."shared_links" OWNER TO "postgres";


ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."brands"
    ADD CONSTRAINT "brands_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_brand_idempotency_key" UNIQUE ("brand_id", "idempotency_key");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_id_brand_key" UNIQUE ("id", "brand_id");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_brand_name_key" UNIQUE ("brand_id", "name");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_id_brand_key" UNIQUE ("id", "brand_id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_brand_email_key" UNIQUE ("brand_id", "email");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_id_brand_key" UNIQUE ("id", "brand_id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_id_brand_key" UNIQUE ("id", "brand_id");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_errors"
    ADD CONSTRAINT "import_errors_batch_row_key" UNIQUE ("batch_id", "row_number");



ALTER TABLE ONLY "public"."import_errors"
    ADD CONSTRAINT "import_errors_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_brand_provider_event_key" UNIQUE ("brand_id", "provider_event_id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shared_links"
    ADD CONSTRAINT "shared_links_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."shared_links"
    ADD CONSTRAINT "shared_links_token_key" UNIQUE ("token");



CREATE UNIQUE INDEX "campaign_sends_brand_batch_key_idx" ON "public"."campaign_sends" USING "btree" ("brand_id", "batch_key") WHERE ("batch_key" IS NOT NULL);



CREATE INDEX "campaign_sends_brand_status_idx" ON "public"."campaign_sends" USING "btree" ("brand_id", "status", "created_at" DESC);



CREATE UNIQUE INDEX "campaign_sends_one_active_per_campaign_idx" ON "public"."campaign_sends" USING "btree" ("campaign_id") WHERE (("is_backfill" = false) AND ("status" <> ALL (ARRAY['failed'::"public"."send_status", 'canceled'::"public"."send_status"])));



COMMENT ON INDEX "public"."campaign_sends_one_active_per_campaign_idx" IS 'Zero-double-send guard. At most one live (non-backfill) send per campaign may hold a non-terminal-failure status. Concurrent confirms collide here, in the database, not in application code.';



CREATE UNIQUE INDEX "campaign_sends_provider_batch_idx" ON "public"."campaign_sends" USING "btree" ("provider_batch_id") WHERE ("provider_batch_id" IS NOT NULL);



CREATE UNIQUE INDEX "campaigns_brand_external_id_idx" ON "public"."campaigns" USING "btree" ("brand_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "campaigns_brand_status_idx" ON "public"."campaigns" USING "btree" ("brand_id", "status", "created_at" DESC);



CREATE INDEX "campaigns_source_batch_idx" ON "public"."campaigns" USING "btree" ("source_batch_id") WHERE ("source_batch_id" IS NOT NULL);



CREATE INDEX "contacts_brand_contactable_idx" ON "public"."contacts" USING "btree" ("brand_id") WHERE "is_contactable";



CREATE INDEX "contacts_brand_created_idx" ON "public"."contacts" USING "btree" ("brand_id", "created_at" DESC);



CREATE UNIQUE INDEX "contacts_brand_external_id_idx" ON "public"."contacts" USING "btree" ("brand_id", "external_id") WHERE ("external_id" IS NOT NULL);



CREATE INDEX "contacts_brand_signup_at_idx" ON "public"."contacts" USING "btree" ("brand_id", "signup_at") WHERE ("signup_at" IS NOT NULL);



CREATE INDEX "contacts_raw_attrs_gin_idx" ON "public"."contacts" USING "gin" ("raw_attrs");



CREATE UNIQUE INDEX "import_batches_brand_checksum_idx" ON "public"."import_batches" USING "btree" ("brand_id", "file_checksum") WHERE (("file_checksum" IS NOT NULL) AND ("status" = 'completed'::"public"."import_status"));



CREATE INDEX "import_batches_brand_created_idx" ON "public"."import_batches" USING "btree" ("brand_id", "created_at" DESC);



CREATE INDEX "import_batches_brand_entity_created_idx" ON "public"."import_batches" USING "btree" ("brand_id", "entity", "created_at" DESC);



CREATE INDEX "import_errors_brand_batch_idx" ON "public"."import_errors" USING "btree" ("brand_id", "batch_id");



CREATE INDEX "message_events_brand_ts_idx" ON "public"."message_events" USING "btree" ("brand_id", "event_timestamp" DESC);



CREATE INDEX "message_events_campaign_ts_idx" ON "public"."message_events" USING "btree" ("campaign_id", "event_timestamp" DESC) WHERE ("campaign_id" IS NOT NULL);



CREATE INDEX "message_events_contact_ts_idx" ON "public"."message_events" USING "btree" ("contact_id", "event_timestamp" DESC) WHERE ("contact_id" IS NOT NULL);



CREATE INDEX "message_events_send_type_idx" ON "public"."message_events" USING "btree" ("campaign_send_id", "event_type");



CREATE INDEX "message_events_source_batch_idx" ON "public"."message_events" USING "btree" ("source_batch_id") WHERE ("source_batch_id" IS NOT NULL);



CREATE INDEX "message_events_suppressing_contact_idx" ON "public"."message_events" USING "btree" ("contact_id") WHERE ("event_type" = ANY (ARRAY['bounce'::"text", 'bounced'::"text", 'complaint'::"text", 'unsubscribe'::"text", 'unsubscribed'::"text"]));



CREATE INDEX "profiles_brand_id_idx" ON "public"."profiles" USING "btree" ("brand_id");



CREATE INDEX "shared_links_brand_campaign_idx" ON "public"."shared_links" USING "btree" ("brand_id", "campaign_id");



CREATE OR REPLACE TRIGGER "brands_set_updated_at" BEFORE UPDATE ON "public"."brands" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "campaign_sends_guard_immutable" BEFORE UPDATE ON "public"."campaign_sends" FOR EACH ROW EXECUTE FUNCTION "public"."campaign_sends_guard_immutable"();



CREATE OR REPLACE TRIGGER "campaign_sends_set_updated_at" BEFORE UPDATE ON "public"."campaign_sends" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "campaigns_set_updated_at" BEFORE UPDATE ON "public"."campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "contacts_set_updated_at" BEFORE UPDATE ON "public"."contacts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "import_batches_set_updated_at" BEFORE UPDATE ON "public"."import_batches" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "message_events_reject_update" BEFORE UPDATE ON "public"."message_events" FOR EACH ROW EXECUTE FUNCTION "public"."message_events_reject_update"();



CREATE OR REPLACE TRIGGER "profiles_guard_immutable" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."profiles_guard_immutable"();



CREATE OR REPLACE TRIGGER "profiles_set_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "shared_links_set_updated_at" BEFORE UPDATE ON "public"."shared_links" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_campaign_fkey" FOREIGN KEY ("campaign_id", "brand_id") REFERENCES "public"."campaigns"("id", "brand_id");



ALTER TABLE ONLY "public"."campaign_sends"
    ADD CONSTRAINT "campaign_sends_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_parent_campaign_fkey" FOREIGN KEY ("parent_campaign_id", "brand_id") REFERENCES "public"."campaigns"("id", "brand_id");



ALTER TABLE ONLY "public"."campaigns"
    ADD CONSTRAINT "campaigns_source_batch_fkey" FOREIGN KEY ("source_batch_id", "brand_id") REFERENCES "public"."import_batches"("id", "brand_id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."contacts"
    ADD CONSTRAINT "contacts_source_batch_fkey" FOREIGN KEY ("source_batch_id", "brand_id") REFERENCES "public"."import_batches"("id", "brand_id");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."import_errors"
    ADD CONSTRAINT "import_errors_batch_fkey" FOREIGN KEY ("batch_id", "brand_id") REFERENCES "public"."import_batches"("id", "brand_id");



ALTER TABLE ONLY "public"."import_errors"
    ADD CONSTRAINT "import_errors_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_campaign_fkey" FOREIGN KEY ("campaign_id", "brand_id") REFERENCES "public"."campaigns"("id", "brand_id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_contact_fkey" FOREIGN KEY ("contact_id", "brand_id") REFERENCES "public"."contacts"("id", "brand_id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_send_fkey" FOREIGN KEY ("campaign_send_id", "brand_id") REFERENCES "public"."campaign_sends"("id", "brand_id");



ALTER TABLE ONLY "public"."message_events"
    ADD CONSTRAINT "message_events_source_batch_fkey" FOREIGN KEY ("source_batch_id", "brand_id") REFERENCES "public"."import_batches"("id", "brand_id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."shared_links"
    ADD CONSTRAINT "shared_links_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id");



ALTER TABLE ONLY "public"."shared_links"
    ADD CONSTRAINT "shared_links_campaign_fkey" FOREIGN KEY ("campaign_id", "brand_id") REFERENCES "public"."campaigns"("id", "brand_id");



ALTER TABLE ONLY "public"."shared_links"
    ADD CONSTRAINT "shared_links_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE "public"."brands" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "brands_insert_denied" ON "public"."brands" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "brands_select_own" ON "public"."brands" FOR SELECT TO "authenticated" USING (("id" = "public"."auth_brand_id"()));



CREATE POLICY "brands_update_own_owner" ON "public"."brands" FOR UPDATE TO "authenticated" USING ((("id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role"))) WITH CHECK ((("id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role")));



ALTER TABLE "public"."campaign_sends" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaign_sends_insert_own_brand_owner" ON "public"."campaign_sends" FOR INSERT TO "authenticated" WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role") AND ("status" = 'pending'::"public"."send_status") AND ("requested_by" = ( SELECT "auth"."uid"() AS "uid")) AND ("is_backfill" = false)));



COMMENT ON POLICY "campaign_sends_insert_own_brand_owner" ON "public"."campaign_sends" IS 'Owners confirm a send by inserting a pending, non-backfill row attributed to themselves. The is_backfill = false clause is load-bearing, not tidiness: the double-send guard index is predicated on it, so without this clause an owner could opt a row out of the guard and two concurrent confirms would both succeed. Historical sends are written by service_role, which bypasses this policy.';



CREATE POLICY "campaign_sends_select_own_brand" ON "public"."campaign_sends" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "campaign_sends_update_denied" ON "public"."campaign_sends" FOR UPDATE TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaigns_insert_own_brand" ON "public"."campaigns" FOR INSERT TO "authenticated" WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("status" = 'draft'::"public"."campaign_status")));



CREATE POLICY "campaigns_select_own_brand" ON "public"."campaigns" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "campaigns_update_own_brand" ON "public"."campaigns" FOR UPDATE TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"())) WITH CHECK (("brand_id" = "public"."auth_brand_id"()));



ALTER TABLE "public"."contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "contacts_insert_own_brand" ON "public"."contacts" FOR INSERT TO "authenticated" WITH CHECK (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "contacts_select_own_brand" ON "public"."contacts" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "contacts_update_own_brand" ON "public"."contacts" FOR UPDATE TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"())) WITH CHECK (("brand_id" = "public"."auth_brand_id"()));



ALTER TABLE "public"."import_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_batches_insert_own_brand" ON "public"."import_batches" FOR INSERT TO "authenticated" WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("uploaded_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "import_batches_select_own_brand" ON "public"."import_batches" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "import_batches_update_own_brand" ON "public"."import_batches" FOR UPDATE TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"())) WITH CHECK (("brand_id" = "public"."auth_brand_id"()));



ALTER TABLE "public"."import_errors" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_errors_insert_own_brand" ON "public"."import_errors" FOR INSERT TO "authenticated" WITH CHECK (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "import_errors_select_own_brand" ON "public"."import_errors" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "import_errors_update_denied" ON "public"."import_errors" FOR UPDATE TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."message_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "message_events_insert_denied" ON "public"."message_events" FOR INSERT TO "authenticated" WITH CHECK (false);



CREATE POLICY "message_events_select_own_brand" ON "public"."message_events" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "message_events_update_denied" ON "public"."message_events" FOR UPDATE TO "authenticated" USING (false) WITH CHECK (false);



ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_insert_own_brand_owner" ON "public"."profiles" FOR INSERT TO "authenticated" WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role")));



CREATE POLICY "profiles_select_same_brand" ON "public"."profiles" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "profiles_update_self_or_owner" ON "public"."profiles" FOR UPDATE TO "authenticated" USING ((("brand_id" = "public"."auth_brand_id"()) AND (("id" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."auth_role"() = 'owner'::"public"."user_role")))) WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND (("id" = ( SELECT "auth"."uid"() AS "uid")) OR ("public"."auth_role"() = 'owner'::"public"."user_role"))));



ALTER TABLE "public"."shared_links" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "shared_links_insert_own_brand_owner" ON "public"."shared_links" FOR INSERT TO "authenticated" WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role") AND ("created_by" = ( SELECT "auth"."uid"() AS "uid"))));



CREATE POLICY "shared_links_select_own_brand" ON "public"."shared_links" FOR SELECT TO "authenticated" USING (("brand_id" = "public"."auth_brand_id"()));



CREATE POLICY "shared_links_update_own_brand_owner" ON "public"."shared_links" FOR UPDATE TO "authenticated" USING ((("brand_id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role"))) WITH CHECK ((("brand_id" = "public"."auth_brand_id"()) AND ("public"."auth_role"() = 'owner'::"public"."user_role")));



GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



REVOKE ALL ON FUNCTION "public"."auth_brand_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."auth_brand_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_brand_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."auth_role"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."auth_role"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auth_role"() TO "service_role";



GRANT ALL ON FUNCTION "public"."campaign_sends_guard_immutable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."campaign_sends_guard_immutable"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."create_shared_link"("p_campaign_id" "uuid", "p_password" "text", "p_expires_at" timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."create_shared_link"("p_campaign_id" "uuid", "p_password" "text", "p_expires_at" timestamp with time zone) TO "authenticated";
GRANT ALL ON FUNCTION "public"."create_shared_link"("p_campaign_id" "uuid", "p_password" "text", "p_expires_at" timestamp with time zone) TO "service_role";



REVOKE ALL ON FUNCTION "public"."event_severity"("p_event_type" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."event_severity"("p_event_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."event_severity"("p_event_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."event_severity"("p_event_type" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_shared_campaign_results"("p_token" "text", "p_password" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."message_events_reject_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."message_events_reject_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."profiles_guard_immutable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."profiles_guard_immutable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."rls_auto_enable"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



GRANT ALL ON TABLE "public"."brands" TO "service_role";
GRANT SELECT,UPDATE ON TABLE "public"."brands" TO "authenticated";



GRANT ALL ON TABLE "public"."campaign_sends" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."campaign_sends" TO "authenticated";



GRANT ALL ON TABLE "public"."campaigns" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."campaigns" TO "authenticated";



GRANT ALL ON TABLE "public"."message_events" TO "service_role";
GRANT SELECT ON TABLE "public"."message_events" TO "authenticated";



GRANT ALL ON TABLE "public"."campaign_performance" TO "anon";
GRANT ALL ON TABLE "public"."campaign_performance" TO "authenticated";
GRANT ALL ON TABLE "public"."campaign_performance" TO "service_role";



GRANT ALL ON TABLE "public"."contacts" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."contacts" TO "authenticated";



GRANT ALL ON TABLE "public"."contact_latest_status" TO "anon";
GRANT ALL ON TABLE "public"."contact_latest_status" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_latest_status" TO "service_role";



GRANT ALL ON TABLE "public"."contact_sendability" TO "anon";
GRANT ALL ON TABLE "public"."contact_sendability" TO "authenticated";
GRANT ALL ON TABLE "public"."contact_sendability" TO "service_role";



GRANT ALL ON TABLE "public"."import_batches" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."import_batches" TO "authenticated";



GRANT ALL ON TABLE "public"."import_errors" TO "service_role";
GRANT SELECT,INSERT ON TABLE "public"."import_errors" TO "authenticated";



GRANT ALL ON TABLE "public"."profiles" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."profiles" TO "authenticated";



GRANT ALL ON TABLE "public"."shared_links" TO "service_role";
GRANT SELECT,INSERT,UPDATE ON TABLE "public"."shared_links" TO "authenticated";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";







