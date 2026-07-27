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
} as const;

export type CallbackActionName = (typeof CALLBACK_ACTIONS)[keyof typeof CALLBACK_ACTIONS];

export interface MarkHandledParams {
  call_id: string;
}

export interface CallBackParams {
  phone: string;
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
