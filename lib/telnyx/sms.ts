import { db } from '../db';
import { env, assertE164, toE164 } from '../env';
import { resolveTopic } from '../telegram/topics';
import { inboundSmsCard, orderChangeCard, smsAutoSentCard, smsDraftCard } from '../telegram/cards';
import type { TextCardPayload } from '../telegram/cards';
import { draftFallback, draftSmsReply, smsAgentDeps } from '../agent/sms';
import { proposeChange } from '../agent/order-change';
import { identifyCaller, orderLinesFor, recentOrdersFor } from '../qbo/lookup';
import { recordQuoteRequest } from '../quote-requests';
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
  /** Present on a failed delivery receipt, and the only place the real reason appears. */
  errors?: Array<{ code?: string | number; title?: string; detail?: string }>;
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
async function claimEvent(eventId: string, eventType: string, occurredAt: string): Promise<boolean> {
  // event_type is NOT NULL and was missing here, so EVERY inbound SMS webhook
  // threw on this line: no message row, no card, no reply, and no delivery
  // receipt either, which is what hid a separate carrier problem for a day.
  // The voice path never had this because it upserts a whole row object; this
  // one built its own literal and left the column out. Fixed 2026-08-03.
  const { data, error } = await db()
    .from('telnyx_events')
    .upsert(
      { id: eventId, event_type: eventType, occurred_at: occurredAt },
      { onConflict: 'id', ignoreDuplicates: true },
    )
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
  displayName: string | null,
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

  await deps.reply(contact.phone, payload.text ?? null, threadId, media.length > 0, contact.display_name);
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
  displayName: string | null,
): Promise<void> {
  try {
    // An MMS is a picture of something, usually a damaged pallet or a purchase
    // order. Whatever the text says, the attachment is the message, and the
    // agent cannot see it.
    const draft = hasMedia
      ? draftFallback('the message has an attachment the agent cannot see')
      : await draftSmsReply(body, smsAgentDeps());

    // Record it, do not just decline to answer. Suppressing this one reply was
    // all that used to happen, so the next inbound text started clean and
    // nothing stopped a human, or the voice agent's text_me_the_list, texting
    // them afterwards. The stamp is what the door reads.
    if (draft.intent === 'opt_out') {
      const { error } = await db()
        .from('contacts')
        .update({ opted_out_at: new Date().toISOString() })
        .eq('phone', phone)
        .is('opted_out_at', null); // first opt-out wins, so the date stays the date they asked
      if (error) console.error('[sms] failed to record opt-out:', error.message);
      return;
    }

    // The other direction, and the reason START must not share a branch with
    // STOP: without this the door stays shut forever and the customer has no way
    // back in short of someone editing the database by hand.
    if (draft.intent === 'opt_in') {
      const { error } = await db()
        .from('contacts')
        .update({ opted_out_at: null })
        .eq('phone', phone)
        .not('opted_out_at', 'is', null);
      if (error) console.error('[sms] failed to clear opt-out:', error.message);
      return;
    }

    // Covers both triggers in one check: draftSmsReply maps the `quote`
    // template's hit to intent 'pricing', the same value the model uses for a
    // pricing question, so a template match and a model classification land
    // here identically. Recording the work item and replying to the customer
    // are independent outcomes, so a failure here must not skip the reply below.
    if (draft.intent === 'pricing') {
      const wants = body?.trim();
      if (wants) {
        try {
          await recordQuoteRequest({ phone, source: 'sms', wants, callerName: displayName });
        } catch (err) {
          console.error(`[sms-agent] recordQuoteRequest for ${phone} failed:`, err);
        }
      }
    }

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

    // A change request gets the order and its lines on the card, plus an Apply
    // button when the message named a quantity clearly enough to parse one. The
    // lookup is best effort: if it throws or finds nothing, the card still goes
    // out carrying their words, which is strictly better than no card.
    const payload =
      draft.intent === 'order_change'
        ? await orderChangePayload({ phone, body, draft })
        : await smsDraftCard({
            phone,
            intent: draft.intent,
            reply: draft.reply,
            reason: draft.reason,
          });

    await db().from('outbox').insert({ thread_id: threadId, kind: 'text', payload });
  } catch (err) {
    console.error(`[sms-agent] reply for ${phone} failed:`, err);
  }
}

/**
 * The statuses where a quantity change is still worth proposing.
 *
 * Mirrors CHANGEABLE in Akme's requantify.ts, and is only an optimisation: the
 * endpoint re-checks the real status on every apply, so a stale copy here shows
 * a button that refuses on tap rather than one that changes something it should
 * not. Kept in step anyway, because a button that never works is noise.
 */
const CHANGEABLE = new Set(['awaiting_approval', 'quote_sent', 'negotiating']);

async function orderChangePayload(input: {
  phone: string;
  body: string | null;
  draft: { intent: string; reply: string; reason: string };
}): Promise<TextCardPayload> {
  const { phone, body, draft } = input;
  const base = { phone, intent: draft.intent, reply: draft.reply, reason: draft.reason };

  try {
    const identity = await identifyCaller(phone);
    const orders = identity?.customer_id ? await recentOrdersFor(identity.customer_id, 5) : [];
    const order = orders.find((o) => CHANGEABLE.has(o.status)) ?? null;
    if (!order) return orderChangeCard({ ...base, order: null, lines: [], proposal: null });

    const lines = await orderLinesFor(order.id);
    return orderChangeCard({
      ...base,
      order: { id: order.id, reference: order.reference, status: order.status },
      lines,
      proposal: proposeChange(body, lines),
    });
  } catch (err) {
    // Never lose the card over a failed lookup. The message is the thing that
    // has to reach a human; the order context is what makes that easier.
    console.error(`[sms-agent] order lookup for ${phone} failed:`, err);
    return orderChangeCard({ ...base, order: null, lines: [], proposal: null });
  }
}

/** `message.sent` / `message.finalized`: the delivery receipt for an outbound send. */
/** Telnyx's own words for a send that did not arrive. */
const FAILED_STATUSES = new Set(['delivery_failed', 'sending_failed', 'expired']);

async function handleDeliveryReceipt(payload: TelnyxMessagePayload): Promise<void> {
  const status = payload.to?.[0]?.status ?? null;
  const to = payload.to?.[0]?.phone_number ?? null;
  const { error } = await db().from('messages').update({ provider_status: status }).eq('provider_id', payload.id);
  if (error) throw new Error(`handleDeliveryReceipt: ${error.message}`);

  if (!status || !FAILED_STATUSES.has(status)) return;

  // Say it out loud. Telnyx accepting a message and the carrier delivering it
  // are different events a second apart, so "sent" is true at the moment we say
  // it and can be false immediately after. On 2026-08-03 every text to a
  // T-Mobile number came back delivery_failed with error 40010 (the number was not yet linked to its campaign), while the phone agent had already told the caller it
  // was sent. Writing the failure to a column nobody reads is how that goes
  // unnoticed for a day.
  const reason = payload.errors?.[0];
  const lines = [
    `⚠️ <b>Text failed to deliver</b>${to ? ` to ${formatE164(to)}` : ''}`,
    `<i>${status}</i>`,
  ];
  if (reason) lines.push('', `${reason.title ?? ''}${reason.detail ? `: ${reason.detail}` : ''}`.trim());

  const threadId = to ? await resolveTopic(to).catch(() => null) : null;
  const { error: outboxError } = await db()
    .from('outbox')
    .insert({ thread_id: threadId, kind: 'text', payload: { text: lines.join('\n') } });
  if (outboxError) console.error('[sms] could not report a failed delivery:', outboxError.message);
}

/** Display only, and deliberately forgiving: a malformed number still gets reported. */
function formatE164(phone: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : phone;
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
  const isNew = await claimEvent(id, event_type, occurred_at);
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

export class SmsBlocked extends Error {}

/**
 * Who we are allowed to text at all, checked at the door below.
 *
 * Unset means NOBODY, which is deliberate: an empty allowlist has to fail
 * closed, or forgetting to configure it silently means "text the world". `*`
 * turns it off, and typing that is the moment someone decides this line may
 * reach real customers.
 *
 * Same shape and same reasoning as Akme's AUTOPILOT_ALLOWLIST, which exists
 * because that CRM would otherwise have emailed strangers.
 */
function mayTextRecipient(to: string): boolean {
  const raw = (process.env.SMS_ALLOWLIST ?? '').trim();
  if (!raw) return false;
  if (raw === '*') return true;
  return raw
    .split(',')
    .map((entry) => toE164(entry.trim()))
    .some((entry) => entry === to);
}

/**
 * Sends an SMS or MMS (pass `media`). Insert-then-send-then-record on purpose:
 * a send that succeeds but is never recorded is worse than a recorded send
 * that failed, because the second is visible and the first is not.
 *
 * THIS IS THE DOOR. Nothing else in the codebase talks to Telnyx messaging, and
 * four different callers reach it: the SMS autopilot, a human tapping Send on a
 * Telegram card, a human replying inside a contact's topic, and the voice
 * agent's text_me_the_list tool mid-call. So the two checks below are the only
 * ones that hold for all of them, and they live here rather than at any
 * decision point. Akme's email CRM had exactly this bug in reverse: mayWriteTo
 * was called from one branch, so a human tapping Send could mail a stranger.
 *
 * What is NOT checked here, on purpose: the content guards over money and day
 * commitments. Those exist to stop the MACHINE making a promise, and a human
 * tapping Send is allowed to quote a price. Guarding content here would break
 * the one path that is supposed to be able to say anything. The door is about
 * WHO may be reached; the decision point is about what the machine may say.
 */
export async function sendSms(toPhone: string, body: string, media: MediaItem[] = []): Promise<Message> {
  const to = assertE164(toPhone, 'sendSms to');

  if (!mayTextRecipient(to)) {
    throw new SmsBlocked(
      (process.env.SMS_ALLOWLIST ?? '').trim()
        ? `${to} is not on SMS_ALLOWLIST`
        : 'SMS_ALLOWLIST is unset, so no message may be sent to anyone',
    );
  }

  const contact = await resolveContact(to);

  // An opt-out outranks everything, including a human tap. Carriers enforce STOP
  // at the campaign level too, but that is someone else's guarantee.
  if (contact.opted_out_at) {
    throw new SmsBlocked(`${to} opted out at ${contact.opted_out_at}`);
  }

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
