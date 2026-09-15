// =============================================================================
// dispatch-send — the only path that spends money
// =============================================================================
// The browser has already inserted the campaign_sends row. That is deliberate:
// the array the owner saw on the confirmation screen is the array stored in
// recipient_snapshot, so "the count on the confirmation screen is what the
// marketer is approving" is provable rather than argued, and two concurrent
// confirms collide on campaign_sends_one_active_per_campaign_idx inside
// Postgres with no check-then-write anywhere.
//
// This function does the four things the browser must not be trusted with:
//
//   1. Holds DISPATCHER_API_KEY, which never reaches the client.
//   2. Claims the send with a conditional UPDATE, so two concurrent dispatch
//      calls for one row cannot both reach the provider.
//   3. Re-scopes every snapshot id to the caller's brand. A tampered client
//      could have written any uuid it liked into the snapshot; ids that are not
//      this brand's contacts are dropped and counted, never messaged.
//   4. Re-filters through contact_sendability at send time, so someone who
//      unsubscribed between approval and dispatch is not contacted. The frozen
//      count stays as approved and the difference is recorded in
//      dispatch_summary.
//
// Net effect: tampering with the snapshot can only ever shrink the audience. It
// cannot reach a foreign contact, and it cannot reach a suppressed one.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// Chunk size for reading the snapshot back out of Postgres. Keeps each `in`
// list short enough not to grow a URL past what the gateway accepts.
const LOOKUP_CHUNK = 500;

// The provider documents 100,000 recipients per call. A larger send would need
// more than one call and therefore more than one batch_id, but
// provider_batch_id is write-once by trigger, so a multi-call send could not be
// recorded honestly in one row. Refusing is better than recording a send whose
// provider reference is only partly true.
const PROVIDER_RECIPIENT_LIMIT = 100000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Not signed in.' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const dispatcherBase = Deno.env.get('DISPATCHER_BASE_URL');
  const dispatcherKey = Deno.env.get('DISPATCHER_API_KEY');

  if (!dispatcherBase || !dispatcherKey) {
    return json({ error: 'The messaging provider is not configured on the server.' }, 500);
  }

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

  // Analysts can look. Only owners spend money. RLS refuses their INSERT too,
  // so this is the second of three refusals, not the only one.
  if (profile.role !== 'owner') {
    return json({ error: 'Only an owner can send a campaign.' }, 403);
  }

  const brandId: string = profile.brand_id;

  let body: { sendId?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Malformed request body.' }, 400);
  }
  if (!body.sendId) return json({ error: 'sendId is required.' }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // ---------------------------------------------------------------------------
  // Claim the send
  // ---------------------------------------------------------------------------
  // A conditional UPDATE, not a read-then-write: the `status = 'pending'`
  // predicate is evaluated by Postgres as part of the same statement that
  // changes it, so of two concurrent dispatch calls exactly one gets a row
  // back and the other gets none. Scoped to brand_id as well, so one brand
  // cannot dispatch another's send by guessing an id.
  const { data: claimed, error: claimError } = await admin
    .from('campaign_sends')
    .update({ status: 'in_flight', dispatched_at: new Date().toISOString() })
    .eq('id', body.sendId)
    .eq('brand_id', brandId)
    .eq('status', 'pending')
    .select('id, campaign_id, recipient_count, recipient_snapshot, idempotency_key')
    .maybeSingle();

  if (claimError) return json({ error: 'Could not start this send.' }, 500);

  if (!claimed) {
    // Either it is not ours, or it is no longer pending. Report which, without
    // leaking the existence of another brand's row.
    const { data: existing } = await admin
      .from('campaign_sends')
      .select('status, provider_batch_id, dispatch_summary')
      .eq('id', body.sendId)
      .eq('brand_id', brandId)
      .maybeSingle();

    if (!existing) return json({ error: 'That send does not belong to your brand.' }, 403);

    return json({
      alreadyHandled: true,
      status: existing.status,
      providerBatchId: existing.provider_batch_id,
      dispatchSummary: existing.dispatch_summary,
    });
  }

  const approved: string[] = Array.isArray(claimed.recipient_snapshot)
    ? claimed.recipient_snapshot.map((id: unknown) => String(id))
    : [];

  const fail = async (message: string, summary: Record<string, unknown> | null = null) => {
    await admin
      .from('campaign_sends')
      .update({
        status: 'failed',
        error_message: message.slice(0, 1000),
        completed_at: new Date().toISOString(),
        dispatch_summary: summary,
      })
      .eq('id', claimed.id)
      .eq('brand_id', brandId);
    return json({ error: message }, 502);
  };

  // ---------------------------------------------------------------------------
  // Re-scope to this brand, and re-check sendability at send time
  // ---------------------------------------------------------------------------
  const unique = [...new Set(approved)];
  const sendable = new Map<string, { email: string; externalId: string | null }>();

  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const slice = unique.slice(i, i + LOOKUP_CHUNK);

    // contact_sendability is security_invoker, so read it with the admin client
    // and filter on brand_id explicitly. is_sendable_now is the only sanctioned
    // audience gate: it re-evaluates suppressed_until against now() and the
    // absence of any bounce/complaint/unsubscribe event, neither of which
    // contacts.is_contactable can see.
    const { data, error } = await admin
      .from('contact_sendability')
      .select('contact_id, email, external_id')
      .eq('brand_id', brandId)
      .eq('is_sendable_now', true)
      .in('contact_id', slice);

    if (error) return await fail('Could not confirm who is still contactable.');

    for (const row of data ?? []) {
      sendable.set(row.contact_id, { email: row.email, externalId: row.external_id ?? null });
    }
  }

  // Anything approved but absent is either no longer sendable or not this
  // brand's contact at all. Separate the two so a tampered snapshot is visible
  // rather than filed as ordinary churn.
  const inBrand = new Set<string>();
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const slice = unique.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await admin
      .from('contacts')
      .select('id')
      .eq('brand_id', brandId)
      .in('id', slice);
    if (error) return await fail('Could not verify the approved recipients.');
    for (const row of data ?? []) inBrand.add(row.id);
  }

  const recipients = unique
    .filter((id) => sendable.has(id))
    .map((id) => {
      const contact = sendable.get(id)!;
      // Send our own ids alongside the address so the provider's receipts can
      // be mapped back to a contact either way.
      return { id, external_id: contact.externalId, email: contact.email };
    });

  const summary = {
    requested: claimed.recipient_count,
    dispatched: recipients.length,
    skipped_suppressed: unique.filter((id) => inBrand.has(id) && !sendable.has(id)).length,
    skipped_not_in_brand: unique.filter((id) => !inBrand.has(id)).length,
    provider_accepted: 0,
    provider_rejected: 0,
  };

  if (recipients.length > PROVIDER_RECIPIENT_LIMIT) {
    return await fail(
      `This send has ${recipients.length} recipients, above the provider's ` +
        `${PROVIDER_RECIPIENT_LIMIT} per-call limit. It was not sent.`,
      summary
    );
  }

  if (recipients.length === 0) {
    await admin
      .from('campaign_sends')
      .update({
        status: 'failed',
        error_message:
          'Nobody on the approved list is still contactable, so nothing was sent.',
        completed_at: new Date().toISOString(),
        dispatch_summary: summary,
      })
      .eq('id', claimed.id)
      .eq('brand_id', brandId);

    return json({ dispatched: 0, status: 'failed', dispatchSummary: summary });
  }

  // ---------------------------------------------------------------------------
  // Hand it to the provider
  // ---------------------------------------------------------------------------
  const { data: campaign } = await admin
    .from('campaigns')
    .select('name, external_id')
    .eq('id', claimed.campaign_id)
    .eq('brand_id', brandId)
    .maybeSingle();

  let response: Response;
  try {
    response = await fetch(`${dispatcherBase.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${dispatcherKey}`,
        'Content-Type': 'application/json',
        // Second layer under the database guard, keyed on the send row itself.
        // If this function is retried after a timeout, the provider delivers
        // once. The database prevents a second send from being created; this
        // prevents a single send from being delivered twice.
        'Idempotency-Key': claimed.id,
      },
      body: JSON.stringify({
        campaign: campaign?.external_id ?? campaign?.name ?? claimed.campaign_id,
        brand: brandId,
        recipients,
      }),
    });
  } catch (error) {
    // Network failure. The send stays 'failed' and therefore releases the
    // guard slot, so the owner can retry — and the Idempotency-Key means a
    // request that actually did arrive is not delivered twice.
    return await fail(
      `Could not reach the messaging provider: ${error instanceof Error ? error.message : 'unknown error'}`,
      summary
    );
  }

  const raw = await response.text();
  let parsed: { batch_id?: string; accepted?: unknown[]; rejected?: unknown[] } = {};
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = {};
  }

  if (!response.ok) {
    return await fail(
      `The messaging provider refused this send (HTTP ${response.status}): ${raw.slice(0, 300)}`,
      summary
    );
  }

  summary.provider_accepted = Array.isArray(parsed.accepted)
    ? parsed.accepted.length
    : recipients.length;
  summary.provider_rejected = Array.isArray(parsed.rejected) ? parsed.rejected.length : 0;

  const { error: finalError } = await admin
    .from('campaign_sends')
    .update({
      status: 'sent',
      provider_batch_id: parsed.batch_id ?? null,
      completed_at: new Date().toISOString(),
      dispatch_summary: summary,
    })
    .eq('id', claimed.id)
    .eq('brand_id', brandId);

  // The provider has it. A failure to record that is a reporting problem, not
  // a send problem, and must never be reported as a failed send — saying "not
  // sent" about messages already in flight would be the worse lie.
  if (finalError) {
    return json({
      status: 'sent',
      providerBatchId: parsed.batch_id ?? null,
      dispatchSummary: summary,
      warning:
        'The campaign was sent, but recording the result failed. The provider batch id is ' +
        `${parsed.batch_id ?? 'unknown'}.`,
    });
  }

  // Reflect it on the campaign so the dashboard stops calling it a draft.
  await admin
    .from('campaigns')
    .update({ status: 'sent' })
    .eq('id', claimed.campaign_id)
    .eq('brand_id', brandId);

  return json({
    status: 'sent',
    providerBatchId: parsed.batch_id ?? null,
    dispatchSummary: summary,
  });
});
