import { db } from '../db';
import { env, assertE164, toE164 } from '../env';
import { resolveTopic } from '../telegram/topics';
import { inboundSmsCard, smsAutoSentCard, smsDraftCard } from '../telegram/cards';
import { draftFallback, draftSmsReply, smsAgentDeps } from '../agent/sms';
import type { Contact, Message, MediaItem } from '../types';

/**
 * Telnyx SMS/MMS: inbound webhook processing and outbound sends.
 *
 * This module never SENDS to Telegram. Inbound messages land in the `outbox`
 * table and are drained elsewhere, because the Bot API caps a group at ~20
 * messages/minute shared across every topic. It does resolve the destination
 * topic, since only this module knows which contact the message belongs to.
 *
 * `lib/telnyx/client.ts` only wraps Call Control (voice commands); it has no
 * messaging support, so sending is a small self-contained POST here rather
 * than a shared import.
 */

const TELNYX_API_BASE = 'https://api.telnyx.com/v2';
const SEND_TIMEOUT_MS = 8000;

export class TelnyxMessagingError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`telnyx /messages: ${status} ${detail}`);
  }
}

interface SendMessageResult {
  id: string;
  [key: string]: unknown;
}

async function sendMessageRequest(params: {
  from: string;
  to: string;
  text: string;
  media_urls?: string[];
}): Promise<SendMessageResult> {
  const res = await fetch(`${TELNYX_API_BASE}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });

  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON body (gateway HTML, empty error). `text` below still carries it.
  }

  if (!res.ok) {
    const errors = (parsed as { errors?: { code?: string | number; title?: string; detail?: string }[] }).errors ?? [];
    const detail =
      errors.map((e) => [e.code, e.title, e.detail].filter(Boolean).join(' ')).join('; ') || text.slice(0, 300);
    throw new TelnyxMessagingError(res.status, detail || 'empty error body');
  }

  return (parsed as { data: SendMessageResult }).data;
}

export interface TelnyxMessagePayload {
  id: string; // Telnyx message resource id, becomes messages.provider_id
  direction: 'inbound' | 'outbound';
  from: { phone_number: string };
  to: Array<{ phone_number: string; status?: string }>;
  text: string | null;
  type: 'SMS' | 'MMS';
  media?: Array<{ url: string; content_type: string }>;
}

export interface TelnyxWebhookBody {
  data: {
    id: string; // webhook event id, the dedupe key (distinct from payload.id)
    event_type: string;
    occurred_at: string;
    payload: TelnyxMessagePayload;
  };
}

/**
 * Claims a webhook event for processing. Returns false if `data.id` has been
 * seen before (a Telnyx retry), in which case the caller must no-op: Telnyx
 * retries messaging webhooks up to 6 times on anything but a 2xx.
 */
async function claimEvent(eventId: string, occurredAt: string): Promise<boolean> {
  const { data, error } = await db()
    .from('telnyx_events')
    .upsert({ id: eventId, occurred_at: occurredAt }, { onConflict: 'id', ignoreDuplicates: true })
    .select('id');
  if (error) throw new Error(`claimEvent: ${error.message}`);
  return (data?.length ?? 0) > 0;
}

/** Read-only lookup. switchboard never writes to Akme's customers table. */
async function findCustomerIdByPhone(phone: string): Promise<string | null> {
  const { data, error } = await db().from('customers').select('id').eq('phone', phone).maybeSingle();
  if (error) throw new Error(`findCustomerIdByPhone: ${error.message}`);
  return data ? (data as { id: string }).id : null;
}

/**
 * Finds the contact row for phone, creating one if this is a new number.
 * Shared by inbound (new sender) and outbound (send to a number with no
 * history yet) since both need a contacts row to satisfy messages' FK.
 */
async function resolveContact(phone: string): Promise<Contact> {
  const existing = await db().from('contacts').select('*').eq('phone', phone).maybeSingle();
  if (existing.error) throw new Error(`resolveContact select: ${existing.error.message}`);
  if (existing.data) return existing.data as Contact;

  const customerId = await findCustomerIdByPhone(phone);
  const inserted = await db().from('contacts').insert({ phone, customer_id: customerId }).select('*').single();

  if (inserted.error) {
    // Lost a create race to a concurrent inbound message from the same new number.
    if (inserted.error.code === '23505') {
      const retry = await db().from('contacts').select('*').eq('phone', phone).single();
      if (retry.error) throw new Error(`resolveContact retry: ${retry.error.message}`);
      return retry.data as Contact;
    }
    throw new Error(`resolveContact insert: ${inserted.error.message}`);
  }
  return inserted.data as Contact;
}

/**
 * What happens after an inbound message is filed and shown in Telegram.
 *
 * Injectable because it is the one part of this path that talks to a model, and
 * because a test about resolving contacts should not be transitively asserting
 * on the SMS agent. Defaults to the real agent.
 */
export type AgentReply = (
  phone: string,
  body: string | null,
  threadId: number,
  hasMedia: boolean,
) => Promise<void>;

export interface SmsEventDeps {
  reply: AgentReply;
}

export function smsEventDeps(): SmsEventDeps {
  return { reply: replyWithAgent };
}

async function handleMessageReceived(
  payload: TelnyxMessagePayload,
  deps: SmsEventDeps,
): Promise<void> {
  const fromRaw = payload.from.phone_number;
  const fromPhone = toE164(fromRaw) ?? assertE164(fromRaw, 'inbound from');
  const contact = await resolveContact(fromPhone);

  const media: MediaItem[] = (payload.media ?? []).map((m) => ({ url: m.url, content_type: m.content_type }));

  const { error: insertError } = await db().from('messages').insert({
    contact_phone: contact.phone,
    direction: 'inbound',
    body: payload.text ?? null,
    media,
    provider_id: payload.id,
    provider_status: null,
  });
  if (insertError) throw new Error(`handleMessageReceived insert: ${insertError.message}`);

  // Resolve the topic HERE, not in the drain. A null thread_id is not "unknown",
  // it is a deliberate instruction to post in General, and the outbox row carries
  // no phone number, so the drain has no way to turn null into the right topic.
  // Without this every new number's first text lands in General instead of
  // opening its thread, which is the one thing this whole design exists to do.
  const threadId = await resolveTopic(contact.phone);

  const { error: outboxError } = await db()
    .from('outbox')
    .insert({
      thread_id: threadId,
      kind: 'text',
      payload: inboundSmsCard({ body: payload.text ?? null, media }),
    });
  if (outboxError) throw new Error(`handleMessageReceived outbox: ${outboxError.message}`);

  await deps.reply(contact.phone, payload.text ?? null, threadId, media.length > 0);
}

/**
 * Drafts a reply and either sends it or puts it in front of a human.
 *
 * Never throws into the webhook path. The inbound message is already stored and
 * already in Telegram by the time this runs, so a failure here costs an
 * automatic reply, not the message itself. Rethrowing would fail the whole event
 * and make Telnyx redeliver a text that is already filed.
 */
async function replyWithAgent(
  phone: string,
  body: string | null,
  threadId: number,
  hasMedia: boolean,
): Promise<void> {
  try {
    // An MMS is a picture of something, usually a damaged pallet or a purchase
    // order. Whatever the text says, the attachment is the message, and the
    // agent cannot see it.
    const draft = hasMedia
      ? draftFallback('the message has an attachment the agent cannot see')
      : await draftSmsReply(body, smsAgentDeps());

    if (draft.intent === 'opt_out') return;

    if (draft.autoSend) {
      await sendSms(phone, draft.reply);
      await db()
        .from('outbox')
        .insert({
          thread_id: threadId,
          kind: 'text',
          payload: smsAutoSentCard({ intent: draft.intent, reply: draft.reply }),
        });
      return;
    }

    await db()
      .from('outbox')
      .insert({
        thread_id: threadId,
        kind: 'text',
        payload: await smsDraftCard({
          phone,
          intent: draft.intent,
          reply: draft.reply,
          reason: draft.reason,
        }),
      });
  } catch (err) {
    console.error(`[sms-agent] reply for ${phone} failed:`, err);
  }
}

/** `message.sent` / `message.finalized`: the delivery receipt for an outbound send. */
async function handleDeliveryReceipt(payload: TelnyxMessagePayload): Promise<void> {
  const status = payload.to?.[0]?.status ?? null;
  const { error } = await db().from('messages').update({ provider_status: status }).eq('provider_id', payload.id);
  if (error) throw new Error(`handleDeliveryReceipt: ${error.message}`);
}

/**
 * Dispatches one already-signature-verified webhook body. Safe to call more
 * than once for the same event: claimEvent makes every event after the first
 * a no-op.
 */
export async function handleTelnyxSmsEvent(
  body: TelnyxWebhookBody,
  deps: SmsEventDeps = smsEventDeps(),
): Promise<void> {
  const { id, event_type, occurred_at, payload } = body.data;
  const isNew = await claimEvent(id, occurred_at);
  if (!isNew) return;

  switch (event_type) {
    case 'message.received':
      await handleMessageReceived(payload, deps);
      break;
    case 'message.sent':
    case 'message.finalized':
      await handleDeliveryReceipt(payload);
      break;
    default:
      break; // voice events and anything else land on a different route
  }
}

/**
 * Sends an SMS or MMS (pass `media`). Insert-then-send-then-record on purpose:
 * a send that succeeds but is never recorded is worse than a recorded send
 * that failed, because the second is visible and the first is not.
 */
export async function sendSms(toPhone: string, body: string, media: MediaItem[] = []): Promise<Message> {
  const to = assertE164(toPhone, 'sendSms to');
  const contact = await resolveContact(to);

  const inserted = await db()
    .from('messages')
    .insert({
      contact_phone: contact.phone,
      direction: 'outbound',
      body,
      media,
      provider_id: null,
      provider_status: null,
    })
    .select('*')
    .single();
  if (inserted.error) throw new Error(`sendSms insert: ${inserted.error.message}`);
  const row = inserted.data as Message;

  let sent: SendMessageResult;
  try {
    sent = await sendMessageRequest({
      from: env('TELNYX_NUMBER'),
      to,
      text: body,
      ...(media.length ? { media_urls: media.map((m) => m.url) } : {}),
    });
  } catch (err) {
    const { error: failError } = await db().from('messages').update({ provider_status: 'failed' }).eq('id', row.id);
    if (failError) throw new Error(`sendSms failure update: ${failError.message}`);
    throw err;
  }

  const { data: updated, error: updateError } = await db()
    .from('messages')
    .update({ provider_id: sent.id ?? null, provider_status: 'sent' })
    .eq('id', row.id)
    .select('*')
    .single();
  if (updateError) throw new Error(`sendSms record provider_id: ${updateError.message}`);
  return updated as Message;
}
