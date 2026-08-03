import { env } from '../../../lib/env';
import { db } from '../../../lib/db';
import type {
  ApplyOrderChangeParams,
  CallBackParams,
  CallbackActionName,
  MarkQuoteHandledParams,
  SendSmsParams,
  TextCardPayload,
} from '../../../lib/telegram/cards';
import { CALLBACK_ACTIONS, escapeHtml } from '../../../lib/telegram/cards';
import { telegram } from '../../../lib/telegram/client';
import { contactByThreadId } from '../../../lib/telegram/topics';
import type { CallbackAction, Message } from '../../../lib/types';

/**
 * The bot webhook. Telegram publishes no IP ranges for webhook senders, so the
 * secret token header plus a hard chat_id filter is the entire door: anything
 * that fails either check is dropped with a bland 200, never a status code
 * that would help an attacker tell "wrong secret" from "wrong chat" apart.
 */

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
  first_name?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramMessage {
  message_id: number;
  message_thread_id?: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  // Service-message fields: present instead of real content, never both.
  forum_topic_created?: unknown;
  forum_topic_closed?: unknown;
  forum_topic_reopened?: unknown;
  forum_topic_edited?: unknown;
  general_forum_topic_hidden?: unknown;
  general_forum_topic_unhidden?: unknown;
  pinned_message?: unknown;
}

export interface TelegramCallbackQuery {
  id: string;
  data?: string;
  /** Always present on a real callback_query; only tests construct one without it. */
  from: TelegramUser;
  message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

const SERVICE_MESSAGE_FIELDS = [
  'forum_topic_created',
  'forum_topic_closed',
  'forum_topic_reopened',
  'forum_topic_edited',
  'general_forum_topic_hidden',
  'general_forum_topic_unhidden',
  'pinned_message',
] as const satisfies readonly (keyof TelegramMessage)[];

function isServiceMessage(message: TelegramMessage): boolean {
  return SERVICE_MESSAGE_FIELDS.some((field) => message[field] !== undefined);
}

export interface InboundReplyCandidate {
  threadId: number;
  text: string;
}

/**
 * The reply-detection rule, applied in order: update.message present (not
 * edited_message) -> chat matches ours -> has a thread id (General and
 * untracked topics are excluded here) -> from a human -> real content, not a
 * service message. Whether that thread id maps to a KNOWN CONTACT is a DB
 * lookup, done by the caller after this, since this function stays pure and
 * therefore unit testable without a database.
 */
export function detectInboundReply(update: TelegramUpdate, ourChatId: string): InboundReplyCandidate | null {
  const message = update.message;
  if (!message) return null;
  if (String(message.chat.id) !== ourChatId) return null;
  if (message.message_thread_id === undefined) return null;
  if (message.from?.is_bot) return null;
  if (isServiceMessage(message)) return null;

  const text = (message.text ?? message.caption ?? '').trim();
  if (!text) return null;

  return { threadId: message.message_thread_id, text };
}

export async function POST(request: Request): Promise<Response> {
  const secret = request.headers.get('x-telegram-bot-api-secret-token');
  if (secret !== env('TELEGRAM_WEBHOOK_SECRET')) {
    console.warn('telegram webhook: rejected, bad secret token');
    return new Response('ok');
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return new Response('ok');
  }

  const ourChatId = env('TELEGRAM_CHAT_ID');

  if (update.callback_query) {
    const chatId = update.callback_query.message?.chat.id;
    if (chatId === undefined || String(chatId) !== ourChatId) {
      console.warn(`telegram webhook: dropped callback_query from foreign chat ${chatId}`);
      return new Response('ok');
    }
    await runCallbackAction(update.callback_query);
    return new Response('ok');
  }

  const candidate = detectInboundReply(update, ourChatId);
  if (!candidate) return new Response('ok');

  const contact = await contactByThreadId(candidate.threadId);
  if (!contact) return new Response('ok'); // thread not mapped to a tracked contact

  // sendSms does its own insert-then-send-then-record of the outbound
  // `messages` row (see lib/telnyx/sms.ts); this route only enriches that row
  // with the Telegram message id that triggered it, never re-inserts it.
  const sent = await forwardSms(contact.phone, candidate.text);
  const { error } = await db()
    .from('messages')
    .update({ telegram_message_id: update.message?.message_id ?? null })
    .eq('id', sent.id);
  if (error) throw new Error(`link outbound message ${sent.id} to telegram: ${error.message}`);

  return new Response('ok');
}

/**
 * sendSms lives in lib/telnyx/sms.ts, owned and built in parallel by another
 * agent. A dynamic import (resolved at call time, not at module load) keeps
 * this route's other exports, and this file's unit tests, independent of
 * whether that module exists on disk yet.
 */
async function forwardSms(phone: string, text: string): Promise<Message> {
  const { sendSms } = await import('../../../lib/telnyx/sms');
  return sendSms(phone, text);
}

async function runCallbackAction(cq: TelegramCallbackQuery): Promise<void> {
  if (!cq.data) {
    await telegram.answerCallbackQuery(cq.id, 'No action attached');
    return;
  }

  const res = await db().from('callback_actions').select('*').eq('id', cq.data).maybeSingle();
  if (res.error) throw new Error(`callback_actions lookup ${cq.data}: ${res.error.message}`);
  const row = res.data as CallbackAction | null;

  if (!row || new Date(row.expires_at).getTime() < Date.now()) {
    await telegram.answerCallbackQuery(cq.id, 'This button has expired');
    return;
  }

  try {
    const toast = await executeAction(row, cq);
    await telegram.answerCallbackQuery(cq.id, toast);
  } catch (err) {
    await telegram.answerCallbackQuery(cq.id, 'Action failed, see logs');
    throw err;
  }
}

export async function executeAction(row: CallbackAction, cq: TelegramCallbackQuery): Promise<string> {
  const action = row.action as CallbackActionName;
  switch (action) {
    case CALLBACK_ACTIONS.MARK_HANDLED: {
      // The card's own MarkHandledParams (call_id) isn't needed here: the
      // message to edit comes straight off the callback_query, not the row.
      const message = cq.message;
      if (message) {
        const original = message.text ?? '';
        await telegram.editMessageText(message.message_id, `${original}\n\n✅ <i>Handled</i>`, {
          reply_markup: { inline_keyboard: [] },
        });
      }
      return 'Marked handled';
    }
    case CALLBACK_ACTIONS.SEND_SMS: {
      const params = row.params as unknown as SendSmsParams;
      const { sendSms } = await import('../../../lib/telnyx/sms');
      await sendSms(params.phone, params.text);
      // Clear the keyboard so the same draft cannot be sent twice by a second
      // tap, which is the obvious way to double-text a customer.
      const message = cq.message;
      if (message) {
        await telegram.editMessageText(message.message_id, `${message.text ?? ''}\n\n✅ <i>Sent</i>`, {
          reply_markup: { inline_keyboard: [] },
        });
      }
      return 'Sent';
    }
    case CALLBACK_ACTIONS.CALL_BACK: {
      const params = row.params as unknown as CallBackParams;
      const payload: TextCardPayload = { text: `📞 Callback requested for ${params.phone}.` };
      const { error } = await db()
        .from('outbox')
        .insert({ thread_id: cq.message?.message_thread_id ?? null, kind: 'text', payload });
      if (error) throw new Error(`enqueue callback request: ${error.message}`);
      return 'Callback requested';
    }
    case CALLBACK_ACTIONS.APPLY_ORDER_CHANGE: {
      const params = row.params as unknown as ApplyOrderChangeParams;
      const by = cq.from.username ?? cq.from.first_name ?? String(cq.from.id);
      const { applyOrderChange } = await import('../../../lib/akme/order-change');
      const result = await applyOrderChange({
        orderId: params.order_id,
        sku: params.sku,
        qty: params.qty,
        actor: by,
      });

      // A refusal is left tappable on purpose. Akme refuses on the order's
      // CURRENT state, so "order is confirmed and can no longer be changed here"
      // is information, not a dead end, and the same tap after somebody moves the
      // order back is the right thing to do.
      if (!result.ok) return result.reason.slice(0, 200);

      const message = cq.message;
      if (message) {
        await telegram.editMessageText(
          message.message_id,
          `${message.text ?? ''}\n\n✅ <i>Applied by ${escapeHtml(by)}. ${escapeHtml(result.reference)} is back in negotiating for a re-quote.</i>`,
          { reply_markup: { inline_keyboard: [] } },
        );
      }
      return `Applied to ${result.reference}`;
    }
    case CALLBACK_ACTIONS.MARK_QUOTE_HANDLED: {
      const params = row.params as unknown as MarkQuoteHandledParams;
      const by = cq.from.username ?? cq.from.first_name ?? String(cq.from.id);
      // lib/quote-requests.ts is Karim's, not built here; dynamic import for the
      // same resilience-to-concurrent-editing reason as forwardSms above, and
      // markQuoteRequestHandled is the one function that may write handled_at,
      // per its own doc comment.
      const { markQuoteRequestHandled } = await import('../../../lib/quote-requests');
      const didHandle = await markQuoteRequestHandled(params.id, by);
      if (didHandle) {
        const message = cq.message;
        if (message) {
          await telegram.editMessageText(message.message_id, `${message.text ?? ''}\n\n✅ <i>Done</i>`, {
            reply_markup: { inline_keyboard: [] },
          });
        }
      }
      // A double tap (or two admins tapping at once) must not re-edit an
      // already-edited card or double-count the handling: markQuoteRequestHandled
      // is idempotent (is('handled_at', null)), and this mirrors that here.
      return didHandle ? 'Marked handled' : 'Already marked handled';
    }
    default:
      throw new Error(`unknown callback action: ${row.action}`);
  }
}
