import { describe, expect, it } from 'vitest';

// db is never touched by the functions under test below (they are pure),
// but every module in the import chain (route.ts -> cards.ts/topics.ts) reads
// from it at the top level, so it is mocked the same way tests/sms.test.ts
// mocks it: no real Supabase credentials required to run this suite.
import { vi } from 'vitest';
vi.mock('../lib/db', () => ({ db: vi.fn(), unwrap: vi.fn() }));

import { detectInboundReply, type TelegramMessage, type TelegramUpdate } from '../app/api/telegram/route';
import { TelegramError } from '../lib/telegram/client';
import { planRetry, TokenBucket } from '../lib/telegram/outbox';

const OUR_CHAT = '-100123456789';

function baseMessage(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 1,
    message_thread_id: 42,
    chat: { id: -100123456789, type: 'supergroup' },
    from: { id: 999, is_bot: false },
    text: 'call them back',
    ...overrides,
  };
}

describe('detectInboundReply: the reply-detection rule, applied in order', () => {
  it('accepts a plain human reply in a tracked topic', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage() };
    expect(detectInboundReply(update, OUR_CHAT)).toEqual({ threadId: 42, text: 'call them back' });
  });

  it('rejects an edited_message, never treating an edit as a new reply', () => {
    const update: TelegramUpdate = { update_id: 1, edited_message: baseMessage() };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a message from a different chat', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: baseMessage({ chat: { id: -999, type: 'supergroup' } }),
    };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a message with no thread id (General or an untracked topic)', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ message_thread_id: undefined }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it("rejects the bot's own echo", () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ from: { id: 1, is_bot: true } }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a forum_topic_created service message', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ forum_topic_created: {} }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a forum_topic_closed service message', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ forum_topic_closed: {} }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a forum_topic_reopened service message', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ forum_topic_reopened: {} }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a general_forum_topic_hidden service message', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ general_forum_topic_hidden: {} }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects a pinned_message service message', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ pinned_message: {} }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('rejects empty or whitespace-only text', () => {
    const update: TelegramUpdate = { update_id: 1, message: baseMessage({ text: '   ' }) };
    expect(detectInboundReply(update, OUR_CHAT)).toBeNull();
  });

  it('falls back to caption when text is absent (an MMS-style reply)', () => {
    const update: TelegramUpdate = {
      update_id: 1,
      message: baseMessage({ text: undefined, caption: 'see attached' }),
    };
    expect(detectInboundReply(update, OUR_CHAT)).toEqual({ threadId: 42, text: 'see attached' });
  });
});

describe('planRetry: rate-limit backoff', () => {
  it('stays pending and honors retry_after on a 429', () => {
    const err = new TelegramError('sendMessage', 429, 'Too Many Requests', 17);
    expect(planRetry(7, err)).toEqual({ status: 'pending', attempts: 8, delayMs: 17_000 });
  });

  it('defaults to a 5s wait when Telegram gives no retry_after', () => {
    const err = new TelegramError('sendMessage', 429, 'Too Many Requests');
    expect(planRetry(0, err).delayMs).toBe(5000);
  });

  it('never flips a rate-limited row to failed, even past the normal attempt ceiling', () => {
    const err = new TelegramError('sendMessage', 429, 'Too Many Requests', 3);
    expect(planRetry(50, err).status).toBe('pending');
  });

  it('backs off exponentially for a non-rate-limit failure, starting at 30s', () => {
    const decision = planRetry(0, new Error('network blip'));
    expect(decision).toEqual({ status: 'pending', attempts: 1, delayMs: 30_000 });
  });

  it('doubles the backoff on each subsequent non-rate-limit failure', () => {
    expect(planRetry(1, new Error('still broken')).delayMs).toBe(60_000);
    expect(planRetry(2, new Error('still broken')).delayMs).toBe(120_000);
  });

  it('flips to failed once MAX_ATTEMPTS is reached on a non-rate-limit failure', () => {
    const decision = planRetry(7, new Error('still broken'));
    expect(decision).toEqual({ status: 'failed', attempts: 8, delayMs: expect.any(Number) });
  });

  it('caps the exponential backoff at 30 minutes instead of growing unbounded', () => {
    // Uncapped, attempt 7 would compute to 1,920,000ms; the cap must win.
    const decision = planRetry(6, new Error('still broken'));
    expect(decision.status).toBe('pending');
    expect(decision.delayMs).toBe(30 * 60_000);
  });
});

describe('TokenBucket: local group-rate budget', () => {
  it('allows sends up to the limit within one window, then blocks', () => {
    const bucket = new TokenBucket(3, 60_000);
    const now = 1_000_000;
    expect(bucket.canSend(now)).toBe(true);
    bucket.record(now);
    expect(bucket.canSend(now)).toBe(true);
    bucket.record(now);
    expect(bucket.canSend(now)).toBe(true);
    bucket.record(now);
    expect(bucket.canSend(now)).toBe(false); // a 4th send in the same instant is over budget
  });

  it('frees capacity once the window rolls past the oldest recorded send', () => {
    const bucket = new TokenBucket(1, 60_000);
    bucket.record(0);
    expect(bucket.canSend(30_000)).toBe(false); // still inside the 60s window
    expect(bucket.canSend(60_001)).toBe(true); // window has rolled past it
  });
});
