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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
