// =============================================================================
// import-events — service-role writer for historical message_events
// =============================================================================
// message_events denies INSERT to authenticated clients on purpose: a client
// that could write receipts could fabricate delivery figures. That policy is
// asserted by the pgTAP suite and is not to be relaxed. This function is the
// only sanctioned write path for the CSV backfill, and it earns that by doing
// three things the browser cannot be trusted to do:
//
//   1. deriving brand_id server-side from the caller's JWT via profiles,
//      never from the request body;
//   2. resolving BOTH external identifiers scoped to that brand_id, because
//      the source files reuse one id space across brands — 12,407 contact ids
//      exist in both Kilele and Karoo, so an unscoped lookup would file one
//      brand's engagement history against another brand's customer;
//   3. holding the service-role key, which never reaches the client.
//
// The database backs this up structurally: message_events_campaign_fkey and
// message_events_contact_fkey are composite on (…, brand_id), so even a bug
// here is refused by Postgres rather than silently mis-attributed.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  // Preflight result is cacheable; 152 requests for the Kilele file should not
  // each pay for a round trip that never changes.
  'Access-Control-Max-Age': '86400',
};

// Mirrors message_events_event_type_check. The CHECK is the authority; this
// copy exists so a bad row is reported per-row instead of failing the batch.
const HISTORICAL_TYPES = new Set(['open', 'click', 'bounce', 'complaint', 'unsubscribe']);
const LIVE_TYPES = new Set(['delivered', 'bounced', 'opened', 'unsubscribed']);

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

// Postgres rejects NUL in text outright (22P05) and the other C0 controls are
// corruption rather than data. Same rule the contacts importer applies.
// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// Learned from production rather than chosen: at 2000 the worker was killed
// with "EarlyDrop" on the Kilele file. The client sends 500; this cap is the
// outer bound beyond which an invocation is not expected to survive.
const MAX_ROWS_PER_REQUEST = 1000;

// Kept at or below MAX_ROWS_PER_REQUEST so a lookup is a single query, and so
// the `in` list cannot grow a URL past what the gateway will accept.
const LOOKUP_CHUNK = 500;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

type IncomingRow = {
  rowNumber: number;
  eventId: string;
  contactExternalId: string | null;
  campaignExternalId: string | null;
  eventType: string;
  channel: string | null;
  occurredAt: string;
};

Deno.serve(async (req) => {
  // Must be answered before any auth check, and with an explicit 200: the
  // browser sends this preflight with no Authorization header, and treats any
  // non-ok status as a CORS failure without ever sending the POST. This is why
  // config.toml sets verify_jwt = false and the token check lives below.
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  // The platform no longer pre-rejects anonymous callers, so this is now the
  // only thing standing between the internet and the service-role client. It
  // runs first, and nothing below it executes without a verified user.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in.' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Caller-scoped client: verifies the JWT and reads the profile under RLS, so
  // the identity we act on is the one Postgres would also see.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });

  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData?.user) return json({ error: 'Not signed in.' }, 401);

  const { data: profile, error: profileError } = await asCaller
    .from('profiles')
    .select('brand_id, role')
    .eq('id', userData.user.id)
    .maybeSingle();

  if (profileError) return json({ error: 'Could not load your account.' }, 500);
  if (!profile?.brand_id) return json({ error: 'Your account has no brand.' }, 403);

  // Events are money-adjacent reporting data. Analysts read; owners load.
  if (profile.role !== 'owner') {
    return json({ error: 'Only an owner can import events.' }, 403);
  }

  const brandId: string = profile.brand_id;

  let body: { batchId?: string; rows?: IncomingRow[] };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body.' }, 400);
  }

  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!body.batchId || !rows) return json({ error: 'batchId and rows are required.' }, 400);
  if (rows.length === 0) return json({ inserted: 0, duplicates: 0, rejected: [], warnings: [] });
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return json({ error: `Send at most ${MAX_ROWS_PER_REQUEST} rows per request.` }, 413);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // The batch id arrives from the client, so confirm it is this brand's before
  // writing it into 386,940 rows of audit trail.
  const { data: batch, error: batchError } = await admin
    .from('import_batches')
    .select('id')
    .eq('id', body.batchId)
    .eq('brand_id', brandId)
    .maybeSingle();

  if (batchError) return json({ error: 'Could not verify the import batch.' }, 500);
  if (!batch) return json({ error: 'That import batch does not belong to your brand.' }, 403);

  // ---------------------------------------------------------------------------
  // Validate
  // ---------------------------------------------------------------------------
  const rejected: { rowNumber: number; code: string; message: string }[] = [];
  const warnings: { rowNumber: number; code: string; message: string }[] = [];
  const valid: IncomingRow[] = [];

  for (const row of rows) {
    const eventId = String(row?.eventId ?? '').trim();
    const eventType = String(row?.eventType ?? '').trim().toLowerCase();
    const occurredAt = String(row?.occurredAt ?? '').trim();

    const rowNumber = Number(row?.rowNumber ?? 0);

    if (!eventId) {
      rejected.push({ rowNumber, code: 'missing_event_id', message: 'missing event id, so this event could not be deduplicated' });
      continue;
    }
    if (eventId.length > 200) {
      rejected.push({ rowNumber: row.rowNumber, code: 'event_id_too_long', message: `event id is ${eventId.length} characters; the limit is 200` });
      continue;
    }
    if (CONTROL_CHARS.test(eventId) || CONTROL_CHARS.test(eventType) || CONTROL_CHARS.test(occurredAt)) {
      rejected.push({ rowNumber: row.rowNumber, code: 'contained_control_characters', message: 'the row contains control characters that Postgres cannot store as text' });
      continue;
    }
    if (!HISTORICAL_TYPES.has(eventType) && !LIVE_TYPES.has(eventType)) {
      rejected.push({ rowNumber: row.rowNumber, code: 'unknown_event_type', message: `event type '${eventType}' is not one the schema allows` });
      continue;
    }
    // Strict ISO only. A lenient parse here would move engagement between days.
    if (!ISO_TIMESTAMP.test(occurredAt) || Number.isNaN(Date.parse(occurredAt))) {
      rejected.push({ rowNumber: row.rowNumber, code: 'invalid_occurred_at', message: `'${occurredAt}' is not an ISO-8601 timestamp with a timezone` });
      continue;
    }
    valid.push({ ...row, eventId, eventType, occurredAt });
  }

  // ---------------------------------------------------------------------------
  // Resolve both identifiers, scoped to this brand
  // ---------------------------------------------------------------------------
  const contactIds = [...new Set(valid.map((r) => r.contactExternalId).filter(Boolean))] as string[];
  const campaignIds = [...new Set(valid.map((r) => r.campaignExternalId).filter(Boolean))] as string[];

  const contactByExternal = new Map<string, string>();
  const campaignByExternal = new Map<string, string>();

  // `.eq('brand_id', brandId)` on both lookups is the whole point of this
  // function. brandId came from profiles, not from the request.
  for (let i = 0; i < contactIds.length; i += LOOKUP_CHUNK) {
    const { data, error } = await admin
      .from('contacts')
      .select('id, external_id')
      .eq('brand_id', brandId)
      .in('external_id', contactIds.slice(i, i + LOOKUP_CHUNK));
    if (error) return json({ error: 'Could not match contacts for this brand.' }, 500);
    for (const c of data ?? []) contactByExternal.set(c.external_id, c.id);
  }

  for (let i = 0; i < campaignIds.length; i += LOOKUP_CHUNK) {
    const { data, error } = await admin
      .from('campaigns')
      .select('id, external_id')
      .eq('brand_id', brandId)
      .in('external_id', campaignIds.slice(i, i + LOOKUP_CHUNK));
    if (error) return json({ error: 'Could not match campaigns for this brand.' }, 500);
    for (const c of data ?? []) campaignByExternal.set(c.external_id, c.id);
  }

  // ---------------------------------------------------------------------------
  // Build rows
  // ---------------------------------------------------------------------------
  // Duplicate provider ids inside one request are collapsed here rather than
  // left to ON CONFLICT: the historical files carry 8,412 byte-identical
  // redeliveries in Kilele alone, and first-wins loses nothing when the
  // repeats are identical.
  const seen = new Set<string>();
  const payloadRows = [];

  for (const row of valid) {
    if (seen.has(row.eventId)) {
      warnings.push({ rowNumber: row.rowNumber, code: 'duplicate_in_request', message: `event id '${row.eventId}' already appeared in this upload; the repeat was skipped` });
      continue;
    }
    seen.add(row.eventId);

    const contactId = row.contactExternalId ? contactByExternal.get(row.contactExternalId) ?? null : null;
    const campaignId = row.campaignExternalId ? campaignByExternal.get(row.campaignExternalId) ?? null : null;

    // Unresolved references are warnings, not rejections: the event happened,
    // and dropping it would understate engagement. The unmatched id is kept in
    // the payload so the gap stays auditable.
    if (row.contactExternalId && !contactId) {
      warnings.push({ rowNumber: row.rowNumber, code: 'unresolved_contact', message: `no contact '${row.contactExternalId}' in this brand; the event was stored without a contact` });
    }
    if (row.campaignExternalId && !campaignId) {
      warnings.push({ rowNumber: row.rowNumber, code: 'unresolved_campaign', message: `no campaign '${row.campaignExternalId}' in this brand; the event was stored without a campaign` });
    }

    payloadRows.push({
      brand_id: brandId,
      contact_id: contactId,
      campaign_id: campaignId,
      provider_event_id: row.eventId,
      event_type: row.eventType,
      event_timestamp: row.occurredAt,
      source_batch_id: body.batchId,
      payload: {
        source: 'csv_backfill',
        channel: row.channel ?? null,
        external_contact_id: row.contactExternalId ?? null,
        campaign_external_id: row.campaignExternalId ?? null,
      },
    });
  }

  if (payloadRows.length === 0) {
    return json({ inserted: 0, duplicates: 0, rejected, warnings });
  }

  // ignoreDuplicates makes a re-upload a no-op instead of an error, which is
  // what makes this endpoint safe to retry after a network failure.
  const { data: inserted, error: insertError } = await admin
    .from('message_events')
    .upsert(payloadRows, {
      onConflict: 'brand_id,provider_event_id',
      ignoreDuplicates: true,
    })
    .select('id');

  if (insertError) {
    return json(
      { error: 'Could not store these events.', detail: insertError.message, code: insertError.code },
      500
    );
  }

  const insertedCount = inserted?.length ?? 0;

  return json({
    inserted: insertedCount,
    // Already present from an earlier run of the same file.
    duplicates: payloadRows.length - insertedCount,
    rejected,
    warnings,
  });
});
