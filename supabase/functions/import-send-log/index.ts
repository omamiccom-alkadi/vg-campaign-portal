// =============================================================================
// import-send-log — service-role backfill of historical sends
// =============================================================================
// campaign_sends is the money table, and its INSERT policy deliberately only
// permits an owner to create a row with status='pending' and
// requested_by=auth.uid(). Historical sends are neither: they land as 'sent'
// with is_backfill=true. The 20260914161149 migration states the consequence
// outright — "The app cannot set is_backfill... backfill runs as service_role"
// — and that is what keeps the live double-send guard byte-identical to what it
// was before backfill support existed.
//
// Two schema details shape everything below:
//
//   * campaign_sends_one_active_per_campaign_idx is scoped to
//     `is_backfill = false`, so these rows never occupy the live send slot. A
//     backfill row can therefore never block a real send, and vice versa.
//
//   * campaign_sends_count_matches_snapshot is `is_backfill or count =
//     jsonb_array_length(snapshot)`. Historical rows carry a count with no
//     recipient list, so the snapshot is an empty array and the equality is
//     exempted — while staying fully strict for live sends, where the money is.
//
// Idempotency is the unique index on (brand_id, batch_key), via ON CONFLICT DO
// NOTHING. Not DO UPDATE: campaign_sends_guard_immutable() raises on any update
// touching recipient_count or recipient_snapshot, so a DO UPDATE that touched
// either would abort the import.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// A historical send cannot still be in flight, so 'pending' and 'in_flight'
// are refused rather than imported: they would describe a send this system is
// supposed to be driving, and it is not.
const HISTORICAL_STATUSES = new Set(['sent', 'failed', 'canceled']);
const LIVE_ONLY_STATUSES = new Set(['pending', 'in_flight']);

const ISO_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/;

// deno-lint-ignore no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

// idempotency_key is `check (length(btrim(idempotency_key)) between 8 and 200)`.
// Prefixing guarantees the minimum is met for a short batch_key, and makes a
// backfill key impossible to mistake for a client-generated live one.
const IDEMPOTENCY_PREFIX = 'backfill:';
const IDEMPOTENCY_MAX = 200;

// recipient_count is `integer` with `check (recipient_count >= 0)`.
const INT4_MAX = 2147483647;

const MAX_ROWS_PER_REQUEST = 500;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

type IncomingRow = {
  rowNumber: number;
  batchKey: string;
  campaignExternalId: string;
  queuedAt: string;
  recipientCount: number | string;
  status: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in.' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

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

  // The live equivalent of this table is owner-only because it spends money.
  // Backfill is held to the same bar.
  if (profile.role !== 'owner') {
    return json({ error: 'Only an owner can import a send log.' }, 403);
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
  if (rows.length === 0) return json({ inserted: 0, duplicates: 0, rejected: [] });
  if (rows.length > MAX_ROWS_PER_REQUEST) {
    return json({ error: `Send at most ${MAX_ROWS_PER_REQUEST} rows per request.` }, 413);
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

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
  const valid: (IncomingRow & { count: number })[] = [];

  for (const row of rows) {
    const rowNumber = Number(row?.rowNumber ?? 0);
    const batchKey = String(row?.batchKey ?? '').trim();
    const campaignExternalId = String(row?.campaignExternalId ?? '').trim();
    const queuedAt = String(row?.queuedAt ?? '').trim();
    const status = String(row?.status ?? '').trim().toLowerCase();
    const rawCount = String(row?.recipientCount ?? '').trim();

    if (!batchKey) {
      rejected.push({ rowNumber, code: 'missing_batch_key', message: 'missing batch key, which is what makes re-importing this file safe' });
      continue;
    }
    if (CONTROL_CHARS.test(batchKey) || CONTROL_CHARS.test(campaignExternalId) || CONTROL_CHARS.test(queuedAt)) {
      rejected.push({ rowNumber, code: 'contained_control_characters', message: 'the row contains control characters that Postgres cannot store as text' });
      continue;
    }
    if (IDEMPOTENCY_PREFIX.length + batchKey.length > IDEMPOTENCY_MAX) {
      rejected.push({ rowNumber, code: 'batch_key_too_long', message: `batch key is ${batchKey.length} characters; with the backfill prefix that exceeds the ${IDEMPOTENCY_MAX}-character limit` });
      continue;
    }
    if (!campaignExternalId) {
      // campaign_id is NOT NULL here, unlike on message_events, so an
      // unattributable send cannot be stored at all. Rejecting is the only
      // honest outcome — a send with no campaign is not a send.
      rejected.push({ rowNumber, code: 'missing_campaign', message: 'no campaign named, and a send must belong to a campaign' });
      continue;
    }
    if (LIVE_ONLY_STATUSES.has(status)) {
      rejected.push({ rowNumber, code: 'live_status_in_backfill', message: `status '${status}' describes a send still in progress, which cannot be true of imported history` });
      continue;
    }
    if (!HISTORICAL_STATUSES.has(status)) {
      rejected.push({ rowNumber, code: 'unknown_status', message: `status '${status}' is not one the schema allows (${[...HISTORICAL_STATUSES].join(', ')})` });
      continue;
    }
    if (!ISO_TIMESTAMP.test(queuedAt) || Number.isNaN(Date.parse(queuedAt))) {
      rejected.push({ rowNumber, code: 'invalid_queued_at', message: `'${queuedAt}' is not an ISO-8601 timestamp with a timezone` });
      continue;
    }
    if (!/^\d+$/.test(rawCount)) {
      rejected.push({ rowNumber, code: 'invalid_recipient_count', message: `'${rawCount}' is not a whole number of recipients` });
      continue;
    }
    const count = Number(rawCount);
    if (count > INT4_MAX) {
      rejected.push({ rowNumber, code: 'recipient_count_too_large', message: `${rawCount} exceeds the largest value this column can hold` });
      continue;
    }

    valid.push({ ...row, batchKey, campaignExternalId, queuedAt, status, count });
  }

  // ---------------------------------------------------------------------------
  // Resolve campaigns, scoped to this brand
  // ---------------------------------------------------------------------------
  // brandId comes from profiles, never the request. CMP-014 exists as two
  // different campaigns in two brands, so an unscoped lookup here would
  // attribute one brand's spend to another's campaign.
  const campaignByExternal = new Map<string, string>();
  const wanted = [...new Set(valid.map((r) => r.campaignExternalId))];

  if (wanted.length > 0) {
    const { data, error } = await admin
      .from('campaigns')
      .select('id, external_id')
      .eq('brand_id', brandId)
      .in('external_id', wanted);
    if (error) return json({ error: 'Could not match campaigns for this brand.' }, 500);
    for (const c of data ?? []) campaignByExternal.set(c.external_id, c.id);
  }

  // ---------------------------------------------------------------------------
  // Build rows
  // ---------------------------------------------------------------------------
  const seen = new Set<string>();
  const payloadRows = [];
  let collapsed = 0;

  for (const row of valid) {
    if (seen.has(row.batchKey)) {
      // Identical repeats are collapsed silently; the client has already
      // rejected any repeat whose details differ.
      collapsed += 1;
      continue;
    }
    seen.add(row.batchKey);

    const campaignId = campaignByExternal.get(row.campaignExternalId);
    if (!campaignId) {
      rejected.push({
        rowNumber: row.rowNumber,
        code: 'unresolved_campaign',
        message: `no campaign '${row.campaignExternalId}' in this brand, so this send could not be attributed`,
      });
      continue;
    }

    payloadRows.push({
      brand_id: brandId,
      campaign_id: campaignId,
      batch_key: row.batchKey,
      idempotency_key: `${IDEMPOTENCY_PREFIX}${row.batchKey}`,
      is_backfill: true,
      status: row.status,
      recipient_count: row.count,
      // No real recipient list exists for history. is_backfill exempts this
      // row from the count = length check; it does not relax it for live sends.
      recipient_snapshot: [],
      // Deliberately NULL: nobody confirmed these sends in this system, and
      // is_backfill plus batch_key already identify them as imported.
      requested_by: null,
      // Set from the file so historical sends sit on their real dates. Left at
      // the default, every backfilled send would appear to have happened on
      // import day and any time-based figure would be wrong.
      created_at: row.queuedAt,
      dispatched_at: row.queuedAt,
      // Left NULL on purpose: the file records when a batch was queued, never
      // when it finished, and inventing a completion time would be a guess
      // presented as a fact.
      completed_at: null,
    });
  }

  if (payloadRows.length === 0) {
    return json({ inserted: 0, duplicates: 0, collapsed, rejected });
  }

  const { data: inserted, error: insertError } = await admin
    .from('campaign_sends')
    .upsert(payloadRows, { onConflict: 'brand_id,batch_key', ignoreDuplicates: true })
    .select('id');

  if (insertError) {
    return json(
      { error: 'Could not store these sends.', detail: insertError.message, code: insertError.code },
      500
    );
  }

  const insertedCount = inserted?.length ?? 0;

  return json({
    inserted: insertedCount,
    duplicates: payloadRows.length - insertedCount,
    collapsed,
    rejected,
  });
});
