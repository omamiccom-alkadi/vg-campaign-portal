// =============================================================================
// poll-send-events — pull delivery reports and append them to message_events
// =============================================================================
// The dispatcher does not push. Reports are read with
// GET /v1/messages/{batch_id}/events?since=<last event_id>.
//
// Its docs say: "The report stream is clean and complete: every event is
// delivered exactly once and in order." Both .cursorrules and the brief say
// that is untrue, and that the stream will be messy and out of order in places.
// So nothing here relies on it:
//
//   * duplicates are absorbed by the unique index on
//     (brand_id, provider_event_id) via ON CONFLICT DO NOTHING, exactly as the
//     CSV backfill does — the live webhook and the backfill hit the same key;
//   * order is never inferred from arrival. event_timestamp is taken from the
//     payload and contact_latest_status ranks by it, so a 'delivered' arriving
//     after an 'unsubscribed' cannot resurrect a contact;
//   * the cursor is an efficiency device. Losing it re-reads pages; it cannot
//     duplicate a row or change a status.
//
// message_events denies INSERT to authenticated clients, so this runs as
// service_role — and therefore resolves every identifier scoped to the brand
// taken from the caller's JWT, never from the request.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

// Only these four exist on the live path; message_events_event_type_check
// permits them alongside the historical CSV vocabulary.
const LIVE_TYPES = new Set(['delivered', 'bounced', 'opened', 'unsubscribed']);

// Aliases, because the docs never state the event object's field names and the
// brief warns the reports are deliberately messy. Guessing one name and
// crashing on another would lose real delivery data.
const ID_KEYS = ['event_id', 'id', 'provider_event_id', 'eventId'];
const TYPE_KEYS = ['event_type', 'type', 'event', 'eventType', 'status'];
const TIME_KEYS = [
  'event_timestamp',
  'occurred_at',
  'timestamp',
  'occurred_at_utc',
  'created_at',
  'time',
  'ts',
];
const RECIPIENT_KEYS = [
  'recipient_id',
  'contact_id',
  'recipient',
  'external_id',
  'external_contact_id',
  'email',
  'to',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Caps per invocation, so a long backlog cannot exhaust the worker budget the
// way the events backfill did. Whatever is left is picked up next poll — the
// cursor is written after every page.
const MAX_PAGES = 15;
const MAX_SENDS = 20;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

function pick(row: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = row?.[key];
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') {
      // e.g. recipient: { id, email }
      const nested = pick(value as Record<string, unknown>, ['id', 'contact_id', 'external_id', 'email']);
      if (nested) return nested;
      continue;
    }
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
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

  // Reading reports changes no money and no audience, so an analyst may do it.
  // Brand scoping still applies in full.
  const brandId: string = profile.brand_id;

  let body: { sendId?: string };
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });

  // Which sends to poll. Always filtered by brand_id from the JWT, so a guessed
  // id belonging to another brand simply matches nothing.
  let query = admin
    .from('campaign_sends')
    .select('id, campaign_id, provider_batch_id, last_event_cursor')
    .eq('brand_id', brandId)
    .eq('is_backfill', false)
    .not('provider_batch_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(MAX_SENDS);

  if (body.sendId) query = query.eq('id', body.sendId);

  const { data: sends, error: sendsError } = await query;
  if (sendsError) return json({ error: 'Could not load sends to poll.' }, 500);
  if (!sends || sends.length === 0) {
    return json({ polled: 0, stored: 0, duplicates: 0, skipped: [], message: 'Nothing to poll yet.' });
  }

  let stored = 0;
  let duplicates = 0;
  let pagesRead = 0;
  const skipped: { code: string; count: number }[] = [];
  const bump = (code: string) => {
    const hit = skipped.find((s) => s.code === code);
    if (hit) hit.count += 1;
    else skipped.push({ code, count: 1 });
  };

  for (const send of sends) {
    let cursor: string | null = send.last_event_cursor ?? null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const endpoint = new URL(
        `${dispatcherBase.replace(/\/$/, '')}/v1/messages/${send.provider_batch_id}/events`
      );
      if (cursor) endpoint.searchParams.set('since', cursor);

      let response: Response;
      try {
        response = await fetch(endpoint.toString(), {
          headers: { Authorization: `Bearer ${dispatcherKey}` },
        });
      } catch (error) {
        return json(
          {
            error: `Could not reach the messaging provider: ${error instanceof Error ? error.message : 'unknown error'}`,
            stored,
            duplicates,
          },
          502
        );
      }

      const raw = await response.text();
      if (!response.ok) {
        return json(
          {
            error: `The provider refused the report request (HTTP ${response.status}): ${raw.slice(0, 200)}`,
            stored,
            duplicates,
          },
          502
        );
      }

      let parsed: { events?: Record<string, unknown>[]; next_cursor?: string | null; has_more?: boolean };
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json({ error: 'The provider returned something that is not JSON.', stored }, 502);
      }

      pagesRead += 1;
      const events = Array.isArray(parsed.events) ? parsed.events : [];

      if (events.length > 0) {
        // ---- resolve recipients, scoped to this brand ------------------------
        const refs = [...new Set(events.map((e) => pick(e, RECIPIENT_KEYS)).filter(Boolean))] as string[];
        const byId = new Map<string, string>();

        const uuids = refs.filter((r) => UUID_RE.test(r));
        const others = refs.filter((r) => !UUID_RE.test(r));

        if (uuids.length > 0) {
          const { data } = await admin
            .from('contacts')
            .select('id')
            .eq('brand_id', brandId)
            .in('id', uuids);
          for (const row of data ?? []) byId.set(row.id, row.id);
        }
        if (others.length > 0) {
          const { data } = await admin
            .from('contacts')
            .select('id, external_id, email')
            .eq('brand_id', brandId)
            .or(`external_id.in.(${others.join(',')}),email.in.(${others.join(',')})`);
          for (const row of data ?? []) {
            if (row.external_id) byId.set(row.external_id, row.id);
            if (row.email) byId.set(String(row.email).toLowerCase(), row.id);
          }
        }

        // ---- shape rows ------------------------------------------------------
        const payloadRows = [];
        for (const event of events) {
          const eventId = pick(event, ID_KEYS);
          const type = (pick(event, TYPE_KEYS) ?? '').toLowerCase();
          const at = pick(event, TIME_KEYS);
          const ref = pick(event, RECIPIENT_KEYS);

          if (!eventId) {
            bump('no_event_id');
            continue;
          }
          if (!LIVE_TYPES.has(type)) {
            bump(`unknown_type:${type || 'blank'}`);
            continue;
          }
          if (!at || Number.isNaN(Date.parse(at))) {
            // Without a payload timestamp this event cannot be ordered, and
            // substituting arrival time is the one thing .cursorrules forbids.
            bump('no_usable_timestamp');
            continue;
          }

          const contactId =
            (ref && (byId.get(ref) ?? byId.get(ref.toLowerCase()))) ?? null;
          if (ref && !contactId) bump('unresolved_contact');

          payloadRows.push({
            brand_id: brandId,
            campaign_send_id: send.id,
            // Both links are set, and they agree by construction because
            // campaign_id is read off this send row rather than the payload.
            // campaign_send_id is the precise fact; campaign_id is what
            // campaign_performance aggregates on, so without it these live
            // receipts would never reach the dashboard.
            campaign_id: send.campaign_id,
            contact_id: contactId,
            provider_event_id: eventId,
            event_type: type,
            event_timestamp: new Date(at).toISOString(),
            payload: { source: 'dispatcher_poll', batch_id: send.provider_batch_id, event },
          });
        }

        if (payloadRows.length > 0) {
          const { data: inserted, error: insertError } = await admin
            .from('message_events')
            .upsert(payloadRows, {
              onConflict: 'brand_id,provider_event_id',
              ignoreDuplicates: true,
            })
            .select('id');

          if (insertError) {
            return json(
              { error: 'Could not store these delivery reports.', detail: insertError.message, stored },
              500
            );
          }

          const count = inserted?.length ?? 0;
          stored += count;
          duplicates += payloadRows.length - count;
        }
      }

      // Advance and persist after every page, so an interruption resumes here
      // rather than restarting the batch.
      const next = parsed.next_cursor ?? pick(events[events.length - 1] ?? {}, ID_KEYS);
      if (next) {
        cursor = next;
        await admin
          .from('campaign_sends')
          .update({ last_event_cursor: cursor, last_polled_at: new Date().toISOString() })
          .eq('id', send.id)
          .eq('brand_id', brandId);
      }

      if (!parsed.has_more) break;
    }

    await admin
      .from('campaign_sends')
      .update({ last_polled_at: new Date().toISOString() })
      .eq('id', send.id)
      .eq('brand_id', brandId);
  }

  return json({ polled: sends.length, pagesRead, stored, duplicates, skipped });
});
