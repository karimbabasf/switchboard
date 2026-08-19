import { db } from '../db';
import { activeIndexThreadIds } from '../crm/surface.ts';
import type { OutboxRow } from '../types';
import type { AudioCardPayload, EditCardPayload, TextCardPayload } from './cards';
import { telegram, TelegramError, type SentMessage } from './client';
import { repairTopic } from './topics';

/**
 * The only module that calls the Telegram send API. Everything is drained
 * from the `outbox` table because the Bot API caps a group at roughly 20
 * messages per MINUTE shared across every topic in it, and one finished call
 * card is already 3 messages (card, recording, edit). Nothing posts directly.
 */

const GROUP_RATE_LIMIT = 20;
const WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 30 * 60_000;

/**
 * Rolling-window token bucket enforcing the shared group ceiling locally, so a
 * burst of enqueued rows cannot blow past it before Telegram ever has to say
 * 429. Pure and deterministic (caller supplies `now`) so it can be unit
 * tested without real timers. It resets on a cold start, which is fine:
 * Telegram's own 429 + retry_after is the authoritative backstop regardless.
 */
export class TokenBucket {
  private sent: number[] = [];

  constructor(
    private readonly limit = GROUP_RATE_LIMIT,
    private readonly windowMs = WINDOW_MS,
  ) {}

  canSend(now: number): boolean {
    this.prune(now);
    return this.sent.length < this.limit;
  }

  record(now: number): void {
    this.sent.push(now);
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    while (this.sent.length > 0 && this.sent[0] < cutoff) this.sent.shift();
  }
}

const bucket = new TokenBucket();

export interface DrainResult {
  processed: number;
  sent: number;
  throttled: number;
  repaired: number;
  failed: number;
}

export interface RetryDecision {
  status: 'pending' | 'failed';
  attempts: number;
  delayMs: number;
}

/**
 * Decides what happens to a row after a failed send. A 429 is never the
 * row's fault: it always stays pending and honors Telegram's own retry_after
 * instead of our backoff curve or the attempt ceiling. Any other failure
 * counts toward MAX_ATTEMPTS and backs off exponentially (capped) until it
 * flips to 'failed'. Pure: no I/O, so it is unit testable directly.
 */
export function planRetry(attempts: number, err: TelegramError | Error): RetryDecision {
  const nextAttempts = attempts + 1;
  if (err instanceof TelegramError && err.isRateLimited) {
    return { status: 'pending', attempts: nextAttempts, delayMs: (err.retryAfter ?? 5) * 1000 };
  }
  const status = nextAttempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  return { status, attempts: nextAttempts, delayMs: backoffMs(nextAttempts) };
}

function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Drains up to `limit` pending rows, oldest-`next_attempt_at`-first. Never
 * loses a row: every outcome ends in either 'sent', a rescheduled 'pending'
 * with backoff, or 'failed' with last_error, all persisted before moving on.
 */
export async function drainOutbox(limit: number): Promise<DrainResult> {
  const result: DrainResult = { processed: 0, sent: 0, throttled: 0, repaired: 0, failed: 0 };

  const res = await db()
    .from('outbox')
    .select('*')
    .eq('status', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('next_attempt_at', { ascending: true })
    .limit(limit);
  if (res.error) throw new Error(`drainOutbox: fetch pending: ${res.error.message}`);
  const rows = (res.data ?? []) as OutboxRow[];
  if (rows.length === 0) return result;

  // One read for the whole drain rather than one per row: there are four
  // standing topics and a drain is up to 20 messages.
  const indexThreads = await activeIndexThreadIds();

  for (const row of rows) {
    if (!bucket.canSend(Date.now())) break; // local budget exhausted; rest wait for the next drain
    result.processed++;
    try {
      const sent = await dispatch(row, indexThreads);
      bucket.record(Date.now());
      const { error } = await db()
        .from('outbox')
        .update({ status: 'sent', sent_message_id: sent.message_id })
        .eq('id', row.id);
      if (error) throw new Error(`persist sent outbox row ${row.id}: ${error.message}`);
      result.sent++;
    } catch (err) {
      await handleSendFailure(row, err, result, indexThreads);
    }
  }

  return result;
}

/**
 * Karim's mute policy, 2026-08-18: "the client topics we can just mute,
 * intervention or pings topic stays unmuted, and so does like confirmation of
 * orders".
 *
 * The Bot API (checked against 10.2 on 2026-08-18) has NO method that sets a
 * person's notification settings for a chat or a topic. `disable_notification`
 * on the send is the whole of what a bot can do: the message still arrives and
 * still marks the topic unread, it just makes no sound. Muting a topic outright
 * is a tap in Karim's own client, and docs/crm-surface.md in Akme carries the
 * steps rather than this pretending to have done it.
 *
 * An edit is never silent, because Telegram does not notify on an edit anyway.
 */
function silently(threadId: number | null, indexThreads: Set<number>): Record<string, unknown> {
  if (threadId === null || indexThreads.has(threadId)) return {};
  return { disable_notification: true };
}

function dispatch(row: OutboxRow, indexThreads: Set<number>): Promise<SentMessage> {
  const quiet = silently(row.thread_id, indexThreads);
  switch (row.kind) {
    case 'text': {
      const payload = row.payload as unknown as TextCardPayload;
      return telegram.sendMessage(row.thread_id, payload.text, { ...quiet, ...(payload.reply_markup ? { reply_markup: payload.reply_markup } : {}) });
    }
    case 'audio': {
      const payload = row.payload as unknown as AudioCardPayload;
      return telegram.sendAudio(row.thread_id, payload.audio_url, { ...quiet, ...(payload.caption ? { caption: payload.caption } : {}) });
    }
    case 'edit': {
      const payload = row.payload as unknown as EditCardPayload;
      return telegram.editMessageText(payload.message_id, payload.text, payload.reply_markup ? { reply_markup: payload.reply_markup } : {});
    }
    case 'document':
      // No renderer in cards.ts produces this kind yet; fail loudly rather than drop it.
      return Promise.reject(new Error(`outbox row ${row.id}: 'document' kind has no sender wired up`));
  }
}

async function handleSendFailure(
  row: OutboxRow,
  err: unknown,
  result: DrainResult,
  indexThreads: Set<number>,
): Promise<void> {
  if (err instanceof TelegramError && err.isTopicGone && row.thread_id !== null) {
    await repairAndRetry(row, result, indexThreads);
    return;
  }
  await persistFailure(row, err, result);
}

async function repairAndRetry(
  row: OutboxRow,
  result: DrainResult,
  indexThreads: Set<number>,
): Promise<void> {
  try {
    const newThreadId = await repairTopic(row.thread_id as number);
    // The repair minted a thread id that was not in the set read at the top of
    // the drain, so a standing topic recreated here would look like a customer
    // topic and go out silent. One extra read on a rare path is cheaper than
    // the queue arriving without a sound.
    const repaired: OutboxRow = { ...row, thread_id: newThreadId };
    const sent = await dispatch(repaired, indexThreads.has(row.thread_id as number)
      ? new Set([...indexThreads, newThreadId])
      : indexThreads);
    bucket.record(Date.now());
    const { error } = await db()
      .from('outbox')
      .update({ status: 'sent', sent_message_id: sent.message_id, thread_id: newThreadId })
      .eq('id', row.id);
    if (error) throw new Error(`persist repaired outbox row ${row.id}: ${error.message}`);
    result.sent++;
    result.repaired++;
  } catch (err) {
    // The one allowed repair-and-retry already happened above; anything past
    // this point is a normal failure, never a second repair attempt.
    await persistFailure(row, err, result);
  }
}

async function persistFailure(row: OutboxRow, err: unknown, result: DrainResult): Promise<void> {
  const decision = planRetry(row.attempts, err instanceof Error ? err : new Error(String(err)));
  const update: Record<string, unknown> = {
    attempts: decision.attempts,
    status: decision.status,
    last_error: err instanceof Error ? err.message : String(err),
  };
  if (decision.status === 'pending') {
    update.next_attempt_at = new Date(Date.now() + decision.delayMs).toISOString();
  }
  const { error } = await db().from('outbox').update(update).eq('id', row.id);
  if (error) throw new Error(`persist failure for outbox row ${row.id}: ${error.message}`);
  if (decision.status === 'failed') result.failed++;
  else result.throttled++;
}
