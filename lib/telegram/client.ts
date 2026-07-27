import { env } from '../env';

/**
 * Thin Bot API wrapper. Deliberately not a library: the surface we use is six
 * methods, and the error shapes matter more than the ergonomics.
 */

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    readonly retryAfter?: number,
  ) {
    super(`${method}: ${code} ${description}`);
  }

  /** 429. The caller must back off rather than retry immediately. */
  get isRateLimited() {
    return this.code === 429;
  }

  /**
   * The topic this was addressed to no longer exists. Any group admin can
   * delete a topic permanently and Telegram offers no recovery, so callers must
   * clear the stored id and recreate rather than treating this as fatal.
   */
  get isTopicGone() {
    return (
      this.code === 400 &&
      /thread not found|TOPIC_DELETED|message thread not found/i.test(this.description)
    );
  }
}

async function call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = (await res.json()) as {
    ok: boolean;
    result?: T;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number };
  };
  if (!json.ok) {
    throw new TelegramError(
      method,
      json.error_code ?? res.status,
      json.description ?? 'unknown error',
      json.parameters?.retry_after,
    );
  }
  return json.result as T;
}

export const chatId = () => env('TELEGRAM_CHAT_ID');

export interface ForumTopic {
  message_thread_id: number;
  name: string;
}

export interface SentMessage {
  message_id: number;
  message_thread_id?: number;
}

export const telegram = {
  createForumTopic: (name: string) =>
    call<ForumTopic>('createForumTopic', { chat_id: chatId(), name }),

  deleteForumTopic: (message_thread_id: number) =>
    call<boolean>('deleteForumTopic', { chat_id: chatId(), message_thread_id }),

  /**
   * thread_id null targets the General topic, which is addressed by OMITTING
   * message_thread_id. Passing 1 does not work.
   */
  sendMessage: (thread_id: number | null, text: string, extra: Record<string, unknown> = {}) =>
    call<SentMessage>('sendMessage', {
      chat_id: chatId(),
      ...(thread_id === null ? {} : { message_thread_id: thread_id }),
      text,
      parse_mode: 'HTML',
      ...extra,
    }),

  sendAudio: (thread_id: number | null, audioUrl: string, extra: Record<string, unknown> = {}) =>
    call<SentMessage>('sendAudio', {
      chat_id: chatId(),
      ...(thread_id === null ? {} : { message_thread_id: thread_id }),
      audio: audioUrl,
      ...extra,
    }),

  editMessageText: (message_id: number, text: string, extra: Record<string, unknown> = {}) =>
    call<SentMessage>('editMessageText', {
      chat_id: chatId(),
      message_id,
      text,
      parse_mode: 'HTML',
      ...extra,
    }),

  answerCallbackQuery: (callback_query_id: string, text?: string) =>
    call<boolean>('answerCallbackQuery', { callback_query_id, ...(text ? { text } : {}) }),

  setMessageReaction: (message_id: number, emoji: string | null) =>
    call<boolean>('setMessageReaction', {
      chat_id: chatId(),
      message_id,
      reaction: emoji ? [{ type: 'emoji', emoji }] : [],
    }),

  raw: call,
};
