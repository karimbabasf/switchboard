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

export interface SmsDraftCardInput {
  phone: string;
  intent: string;
  reply: string;
  /** Why this one is waiting for a tap instead of having gone already. */
  reason: string;
}

/**
 * A drafted reply the agent would not send on its own.
 *
 * The draft is shown in full, so the decision is "is this right" rather than
 * "what did it want to say". Tapping Send sends exactly this text; typing a
 * reply in the topic instead sends that, through the path that already exists.
 */
export async function smsDraftCard(input: SmsDraftCardInput): Promise<TextCardPayload> {
  const lines = [
    '<b>Draft reply</b>',
    `<i>${escapeHtml(input.intent)} · ${escapeHtml(input.reason)}</i>`,
    '',
    escapeHtml(input.reply),
    '',
    '<i>Send it, or just type your own reply here.</i>',
  ];

  const send = await makeCallbackButton('Send', CALLBACK_ACTIONS.SEND_SMS, {
    phone: input.phone,
    text: input.reply,
  } satisfies SendSmsParams);

  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[send]] } };
}

export interface ApplyOrderChangeParams {
  order_id: string;
  sku: string;
  qty: number;
}

export interface OrderChangeCardInput extends SmsDraftCardInput {
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
 */
export async function orderChangeCard(input: OrderChangeCardInput): Promise<TextCardPayload> {
  const lines = ['<b>Order change requested</b>'];

  if (input.order) {
    const ref = input.order.reference ?? input.order.id.slice(0, 8);
    lines.push(`<i>${escapeHtml(ref)} · ${escapeHtml(input.order.status.replace(/_/g, ' '))}</i>`);
  } else {
    lines.push('<i>No open order matched this number.</i>');
  }

  if (input.lines.length) {
    lines.push('', ...input.lines.map((l) => `· ${escapeHtml(l.name)} x ${l.qty} ${escapeHtml(l.unit)}`));
  }

  lines.push('', '<b>Draft reply</b>', escapeHtml(input.reply));

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

  buttons.push(
    await makeCallbackButton('Send reply', CALLBACK_ACTIONS.SEND_SMS, {
      phone: input.phone,
      text: input.reply,
    } satisfies SendSmsParams),
  );

  // One button per row: "Apply" changes an order and "Send reply" texts a
  // customer, and side by side at thumb width they are one mis-tap apart.
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons.map((b) => [b]) } };
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
