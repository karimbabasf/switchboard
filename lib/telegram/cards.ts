import { db, unwrap } from '../db';
import type { Call, CallSummary, MediaItem, OutboxKind } from '../types';
import { formatPhoneForDisplay, getContact, resolveTopic } from './topics';

/**
 * Renderers that turn domain events into outbox payloads. Nothing here calls
 * Telegram directly, that is outbox.ts's job; these just produce the
 * `payload` shape a given outbox `kind` expects.
 */

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface TextCardPayload {
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

export interface AudioCardPayload {
  audio_url: string;
  caption?: string;
}

export interface EditCardPayload {
  message_id: number;
  text: string;
  reply_markup?: InlineKeyboardMarkup;
}

export const CALLBACK_ACTIONS = {
  MARK_HANDLED: 'mark_handled',
  CALL_BACK: 'call_back',
  SEND_SMS: 'send_sms',
  MARK_QUOTE_HANDLED: 'mark_quote_handled',
  APPLY_ORDER_CHANGE: 'apply_order_change',
} as const;

export type CallbackActionName = (typeof CALLBACK_ACTIONS)[keyof typeof CALLBACK_ACTIONS];

export interface MarkHandledParams {
  call_id: string;
}

export interface CallBackParams {
  phone: string;
}

export interface SendSmsParams {
  phone: string;
  text: string;
}

export interface MarkQuoteHandledParams {
  id: string;
}

export interface ApplyOrderChangeParams {
  order_id: string;
  sku: string;
  qty: number;
}

export interface OrderChangeCardInput {
  /** The customer's own words, which is what "make it 5" has to be read against. */
  body: string;
  /** Null when we could not tell which of their orders this is about. */
  order: { id: string; reference: string | null; status: string } | null;
  lines: { sku: string; name: string; qty: number; unit: string }[];
  /** Null whenever the message did not contain one clear enough to offer. */
  proposal: { sku: string; name: string; from: number; to: number } | null;
}

/**
 * A change request, with everything needed to act on it on one card.
 *
 * The order and its lines are here because the alternative is somebody opening
 * Akme in another window to find out what "make it 5" refers to. The Apply
 * button is here because the parse already happened and making a person retype a
 * number a machine already read is the whole thing this is meant to avoid.
 *
 * The button is frequently absent and that is the design working: no confident
 * number, no button. The card is still worth sending, because it carries their
 * words and their order.
 *
 * IT CARRIES NO DRAFT REPLY, as of 2026-08-24. It used to, with a Send button
 * beside Apply, and both of those are now wrong: the reply was a sentence this
 * repo wrote, and by the time this card exists Akme's desk has already answered
 * the customer, so a second tap would text them twice. What is left is what this
 * card was always for, which is acting on the order.
 */
export async function orderChangeCard(input: OrderChangeCardInput): Promise<TextCardPayload> {
  const lines = ['<b>Order change requested</b>'];

  if (input.order) {
    const ref = input.order.reference ?? input.order.id.slice(0, 8);
    lines.push(`<i>${escapeHtml(ref)} · ${escapeHtml(input.order.status.replace(/_/g, ' '))}</i>`);
  } else {
    lines.push('<i>No open order matched this number.</i>');
  }

  lines.push('', 'They wrote:', escapeHtml(input.body));

  if (input.lines.length) {
    lines.push('', ...input.lines.map((l) => `· ${escapeHtml(l.name)} x ${l.qty} ${escapeHtml(l.unit)}`));
  }

  const buttons: InlineKeyboardButton[] = [];
  if (input.proposal && input.order) {
    const p = input.proposal;
    lines.push('', `<b>Proposed</b>: ${escapeHtml(p.name)} ${p.from} to ${p.to}`);
    buttons.push(
      await makeCallbackButton(`Apply: ${p.name} to ${p.to}`, CALLBACK_ACTIONS.APPLY_ORDER_CHANGE, {
        order_id: input.order.id,
        sku: p.sku,
        qty: p.to,
      } satisfies ApplyOrderChangeParams),
    );
  }

  return buttons.length > 0
    ? { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons.map((b) => [b]) } }
    : { text: lines.join('\n') };
}

export interface SmsAutoSentCardInput {
  intent: string;
  reply: string;
}

/** What the agent already sent, so the team sees it without having to approve it. */
export function smsAutoSentCard(input: SmsAutoSentCardInput): TextCardPayload {
  return {
    text: [
      `✅ <b>Auto-replied</b> <i>(${escapeHtml(input.intent)})</i>`,
      '',
      escapeHtml(input.reply),
    ].join('\n'),
  };
}

export interface DeskDownCardInput {
  reason: string;
  body: string;
}

/**
 * Akme's door did not answer, so nobody answered.
 *
 * Deliberately carries NO draft and NO Send button. The point of this card is
 * that the state is unknown: Akme claims a quote send before it returns the
 * words, so it may have recorded a quote as sent that never left. Offering a
 * one-tap reply here would invite somebody to send a second answer over the
 * first without knowing there was one. Read the thread, then reply by hand.
 */
export function deskDownCard(input: DeskDownCardInput): TextCardPayload {
  return {
    text: [
      '⚠️ <b>Akme did not answer, and neither did we</b>',
      `<i>${escapeHtml(input.reason)}</i>`,
      '',
      'They wrote:',
      escapeHtml(input.body),
      '',
      'Nothing was sent. Check the order in Akme before replying: a quote may already be recorded as sent.',
    ].join('\n'),
  };
}

export interface DeskSilentCardInput {
  body: string;
}

/**
 * Akme took the message and said nothing back to the customer.
 *
 * This used to be a normal outcome and a quiet `return`. As of 2026-08-20 the
 * deal engine always answers a customer who wrote in, so silence is a defect:
 * a branch that escalated without a holding line, or a reply that came back
 * empty. A real customer sat in that hole for over an hour on 2026-08-20 and
 * nothing anywhere said so.
 *
 * Carries NO draft and NO Send button, for the same reason deskDownCard does
 * not: Akme has already posted whatever card it wanted a person to see, and a
 * one-tap reply here would talk over it.
 */
export function deskSilentCard(input: DeskSilentCardInput): TextCardPayload {
  return {
    text: [
      '⚠️ <b>The desk took this and said nothing</b>',
      '',
      'They wrote:',
      escapeHtml(input.body),
      '',
      'Akme handled the message and returned no reply, which it should never do. The customer is waiting. Answer them here, then check why the engine went quiet.',
    ].join('\n'),
  };
}

export interface DeskDeclinedCardInput {
  /** Akme's own word for why, or null when it did not give one. */
  reason: string | null;
  body: string;
  /** The holding line Akme wrote and this repo sent, or null if it sent nothing. */
  reply: string | null;
}

/**
 * Akme read the message and did not take it.
 *
 * This used to be invisible, because a decline fell through to a local drafter
 * and the customer got a template. There is no drafter now, so a decline is
 * either Akme's own holding line going out or nothing going out at all, and
 * both need saying: the first so nobody answers twice, the second because a
 * customer is sitting in silence.
 *
 * No Send button, for the same reason deskSilentCard has none. Whatever should
 * be said next is a person's sentence, typed in the topic.
 */
export function deskDeclinedCard(input: DeskDeclinedCardInput): TextCardPayload {
  const lines = [
    input.reply ? '💬 <b>The desk declined, and sent its holding line</b>' : '⚠️ <b>The desk declined and nothing was sent</b>',
    `<i>${escapeHtml(input.reason ?? 'no reason given')}</i>`,
    '',
    'They wrote:',
    escapeHtml(input.body),
  ];
  if (input.reply) lines.push('', 'We sent:', escapeHtml(input.reply));
  else lines.push('', 'Nobody has answered them. Reply here.');
  return { text: lines.join('\n') };
}

export interface SmsBlockedCardInput {
  phone: string;
  /** The words that were written and then refused at the door. */
  reply: string;
  reason: string;
}

/**
 * The desk wrote a reply and this repo refused to send it.
 *
 * SMS_ALLOWLIST is enforced here and Akme deliberately holds no copy of it, so
 * Akme's turn can report a clean send for a number the door then refuses. That
 * landed in a console.error inside a catch that swallowed everything until
 * 2026-08-24. By the time it happens the desk has spent a model call and may
 * have claimed a quote against the order, so the refusal is not a detail.
 *
 * The words are shown in full: the point is that a person can see what the
 * customer did NOT receive, and decide whether the allowlist is the bug.
 */
export function smsBlockedCard(input: SmsBlockedCardInput): TextCardPayload {
  return {
    text: [
      '🚫 <b>A reply was written and then blocked at the door</b>',
      `<i>${escapeHtml(input.reason)}</i>`,
      '',
      `Nothing reached ${escapeHtml(formatPhoneForDisplay(input.phone))}. It would have said:`,
      escapeHtml(input.reply),
      '',
      'Check SMS_ALLOWLIST. Akme may already hold a quote against this order.',
    ].join('\n'),
  };
}

export interface SmsSendFailedCardInput {
  phone: string;
  /** The words that were written and never reached the wire. */
  reply: string;
  reason: string;
}

/**
 * How much of a third party's error text a card is allowed to carry.
 *
 * Telegram caps a message at 4096 characters and a gateway answering with an
 * HTML page will spend all of it. The words the customer missed are the point
 * of the card, so the reason is what gets clipped.
 */
const FAILURE_REASON_LIMIT = 300;

/**
 * Strips anything credential-shaped out of text this repo did not write.
 *
 * Matched on the env var NAME rather than against a fixed list of values,
 * because a list drifts the moment somebody adds a secret and this card would
 * then be the thing that leaks it. Anything named like a credential, and long
 * enough to be one, is replaced wherever it appears. The Bearer sweep after it
 * catches a token that never came from the environment at all.
 */
function redactSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (!/SECRET|KEY|TOKEN|PASSWORD/.test(name)) continue;
    out = out.split(value).join('[redacted]');
  }
  return out.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, FAILURE_REASON_LIMIT);
}

/**
 * The desk wrote a reply and the carrier would not take it.
 *
 * Separate from smsBlockedCard on purpose. That one is this repo refusing on
 * purpose, and the fix is a config line. This one is Telnyx or the network
 * failing, and the fix is to send the same words again by hand.
 *
 * It was the last silent outcome on the reply path. A Telnyx 500 rethrew into
 * replyWithAgent's outer catch, which is a bare console.error, so until
 * 2026-08-24 the customer got nothing, `crm_timeline` got no outbound row,
 * Telegram showed only the inbound card, and nobody found out, while Akme had
 * already recorded the quote as sent.
 *
 * No Send button, for the same reason deskDownCard has none: the state on
 * Akme's side is unknown, and a one-tap reply invites a second answer over a
 * first nobody knew about.
 */
export function smsSendFailedCard(input: SmsSendFailedCardInput): TextCardPayload {
  return {
    text: [
      '❌ <b>A reply was written and the carrier refused it</b>',
      `<i>${escapeHtml(redactSecrets(input.reason))}</i>`,
      '',
      `Nothing reached ${escapeHtml(formatPhoneForDisplay(input.phone))}. It would have said:`,
      escapeHtml(input.reply),
      '',
      'Nobody has answered them. Send this by hand, and read the order in Akme first: a quote may already be recorded as sent.',
    ].join('\n'),
  };
}

export interface AttachmentOnlyCardInput {
  attachments: number;
}

/**
 * A picture and no words, which nothing in this system can read.
 *
 * It is usually a damaged pallet or a purchase order, and the attachment IS the
 * message. It is deliberately never sent to Akme: a text-only reader answering
 * it would be answering something it cannot see. So nothing is sent, and this
 * card is what stops that silence being invisible. The attachment itself is
 * already in the topic on the inbound card above it.
 */
export function attachmentOnlyCard(input: AttachmentOnlyCardInput): TextCardPayload {
  return {
    text: [
      '📎 <b>An attachment with no words</b>',
      '',
      `${input.attachments} attachment${input.attachments === 1 ? '' : 's'} and nothing written. Nobody can read it but a person, so nothing was sent and nothing was asked of Akme.`,
    ].join('\n'),
  };
}

export interface InboundSmsCardInput {
  body: string | null;
  media: MediaItem[];
}

export function inboundSmsCard(input: InboundSmsCardInput): TextCardPayload {
  const parts: string[] = [];
  if (input.body?.trim()) parts.push(escapeHtml(input.body.trim()));
  if (input.media.length > 0) {
    parts.push(`📎 ${input.media.length} attachment${input.media.length === 1 ? '' : 's'}`);
  }
  if (parts.length === 0) parts.push('<i>(empty message)</i>');
  return { text: parts.join('\n\n') };
}

export interface CompletedCallCardInput {
  callId: string;
  contactPhone: string;
  displayName: string | null;
  durationSec: number | null;
  summary: CallSummary;
}

/**
 * A finished call's card: headline, caller, duration, action items, plus two
 * buttons. Buttons never carry a JSON payload, callback_data is capped at 64
 * bytes by Telegram, so each button carries a `callback_actions` row id and
 * the row holds the real params.
 */
export async function completedCallCard(input: CompletedCallCardInput): Promise<TextCardPayload> {
  const who = input.displayName?.trim() || formatPhoneForDisplay(input.contactPhone);
  const { summary } = input;

  const lines = [`<b>${escapeHtml(summary.headline)}</b>`, `${escapeHtml(who)} · ${formatDuration(input.durationSec)}`];

  if (summary.caller_wanted.trim()) {
    lines.push('', `<b>Wanted:</b> ${escapeHtml(summary.caller_wanted)}`);
  }
  if (summary.commitments.length > 0) {
    lines.push('', '<b>We committed to:</b>', ...summary.commitments.map((c) => `• ${escapeHtml(c)}`));
  }
  if (summary.action_items.length > 0) {
    lines.push('', '<b>Action items:</b>', ...summary.action_items.map((a) => `• ${escapeHtml(a)}`));
  }
  if (summary.needs_followup) lines.push('', '⚠️ <i>Needs followup</i>');

  const [callBack, markHandled] = await Promise.all([
    makeCallbackButton('Call back', CALLBACK_ACTIONS.CALL_BACK, { phone: input.contactPhone } satisfies CallBackParams),
    makeCallbackButton('Mark handled', CALLBACK_ACTIONS.MARK_HANDLED, { call_id: input.callId } satisfies MarkHandledParams),
  ]);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[callBack, markHandled]] } };
}

export interface QuoteRequestCardInput {
  id: string;
  who: string;
  phone: string;
  source: 'call' | 'sms';
  wants: string;
}

/**
 * The work item, not the conversation: who is asking, how they reached us,
 * and what they said verbatim, plus a Done button. Lives in the standing
 * Quote Requests topic (lib/telegram/topics.ts's resolveIndexTopic), not the
 * contact's own topic, because a queue you have to open every contact's
 * topic to read is not a queue (see lib/quote-requests.ts).
 *
 * `wants` is a customer's own words, deliberately uncorrected, which makes it
 * the field on this card most likely to carry copy-pasted or dictated
 * punctuation like "<18x18x16>" -- escaped here for the same reason every
 * other card escapes customer-provided text.
 */
export async function quoteRequestCard(input: QuoteRequestCardInput): Promise<TextCardPayload> {
  const channel = input.source === 'call' ? '📞 Call' : '💬 Text';
  const phone = formatPhoneForDisplay(input.phone);
  // who is often just the same phone number reformatted (no name known yet);
  // showing it twice on one line would be noise, not signal.
  const identity = input.who === phone ? escapeHtml(phone) : `${escapeHtml(input.who)} · ${escapeHtml(phone)}`;

  const lines = [
    '<b>Quote requested</b>',
    `${identity} · ${channel}`,
    '',
    escapeHtml(input.wants),
    '',
    '<i>Tap Done once priced.</i>',
  ];

  const done = await makeCallbackButton('Done', CALLBACK_ACTIONS.MARK_QUOTE_HANDLED, {
    id: input.id,
  } satisfies MarkQuoteHandledParams);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[done]] } };
}

export interface OutboxPayload {
  thread_id: number | null;
  kind: OutboxKind;
  payload: Record<string, unknown>;
}

/**
 * Entry point the post-call worker (lib/worker/run.ts) calls once a call
 * reaches 'summarizing'. Async because it has to: resolving the contact's
 * topic (creating one if this is a first contact) and creating the button's
 * `callback_actions` rows are both real DB round trips, so this can never be
 * a synchronous function no matter how it is called.
 */
export async function callCard(call: Call): Promise<OutboxPayload[]> {
  const threadId = await resolveTopic(call.contact_phone);

  if (!call.summary) {
    // Shouldn't happen once the pipeline reaches 'summarizing', but a call
    // must never be silently dropped just because a summary is missing.
    const duration = formatDuration(call.duration_sec);
    const text = `<b>Call ${call.was_answered ? 'ended' : 'went to voicemail'}</b>\n${escapeHtml(formatPhoneForDisplay(call.contact_phone))} · ${duration}\n\n<i>No summary available.</i>`;
    const fallback: TextCardPayload = { text };
    return [{ thread_id: threadId, kind: 'text', payload: fallback as unknown as Record<string, unknown> }];
  }

  const contact = await getContact(call.contact_phone);
  const payload = await completedCallCard({
    callId: call.id,
    contactPhone: call.contact_phone,
    displayName: contact?.display_name ?? null,
    durationSec: call.duration_sec,
    summary: call.summary,
  });

  return [{ thread_id: threadId, kind: 'text', payload: payload as unknown as Record<string, unknown> }];
}

async function makeCallbackButton(
  text: string,
  action: CallbackActionName,
  params: Record<string, unknown>,
): Promise<InlineKeyboardButton> {
  const res = await db().from('callback_actions').insert({ action, params }).select('id').single();
  const row = unwrap(res, `makeCallbackButton: create row for ${action}`);
  const callback_data = (row as { id: string }).id;
  const bytes = Buffer.byteLength(callback_data, 'utf8');
  if (bytes > 64) throw new Error(`makeCallbackButton: callback_data for ${action} is ${bytes} bytes, over the 64 cap`);
  return { text, callback_data };
}

function formatDuration(durationSec: number | null): string {
  if (durationSec === null) return 'unanswered';
  const m = Math.floor(durationSec / 60);
  const s = durationSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
