import { afterEach, describe, expect, it, vi } from 'vitest';

// db is touched directly by the topics.ts/cards.ts/route.ts tests below
// (resolveIndexTopic, repairTopic, resolveTopic, learnContactName,
// quoteRequestCard, executeAction), so the mock preserves the real `unwrap`
// (pure, no I/O) and only replaces `db` itself -- same idiom tests/sms.test.ts
// uses for lib/telnyx/sms.ts.
vi.mock('../lib/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/db')>();
  return { ...actual, db: vi.fn() };
});

// Only the methods the new tests below actually drive are replaced;
// TelegramError and every other telegram.* method stay real so the existing
// planRetry tests keep exercising the real error class.
vi.mock('../lib/telegram/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/telegram/client')>();
  return {
    ...actual,
    telegram: {
      ...actual.telegram,
      createForumTopic: vi.fn(),
      editForumTopic: vi.fn(),
      editMessageText: vi.fn(),
    },
  };
});

// lib/quote-requests.ts is Karim's (do not edit); executeAction's Done-button
// case calls markQuoteRequestHandled from it, stubbed here the same way
// tests/sms.test.ts stubs modules it depends on but does not own.
vi.mock('../lib/quote-requests', () => ({ markQuoteRequestHandled: vi.fn() }));

import {
  detectInboundReply,
  executeAction,
  type TelegramCallbackQuery,
  type TelegramMessage,
  type TelegramUpdate,
} from '../app/api/telegram/route';
import { db } from '../lib/db';
import { markQuoteRequestHandled } from '../lib/quote-requests';
import { CALLBACK_ACTIONS, quoteRequestCard, type MarkQuoteHandledParams } from '../lib/telegram/cards';
import { telegram, TelegramError } from '../lib/telegram/client';
import { planRetry, TokenBucket } from '../lib/telegram/outbox';
import {
  formatPhoneForDisplay,
  learnContactName,
  QUOTE_REQUESTS_TOPIC,
  repairTopic,
  resolveIndexTopic,
  resolveTopic,
} from '../lib/telegram/topics';
import type { CallbackAction, Contact } from '../lib/types';

const OUR_CHAT = '-100123456789';
const mockedDb = vi.mocked(db);

afterEach(() => {
  vi.resetAllMocks();
});

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

// --- Shared DB fakes for the tests below. Same idiom as tests/sms.test.ts's ---
// --- makeChain/queueFrom, copied rather than imported so this file has no ----
// --- cross-file coupling to another agent's test file. -----------------------

function makeChain(result: { data: unknown; error: { message: string } | null }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.insert = vi.fn(self);
  chain.update = vi.fn(self);
  chain.upsert = vi.fn(self);
  chain.single = vi.fn(() => Promise.resolve(result));
  chain.maybeSingle = vi.fn(() => Promise.resolve(result));
  chain.then = (resolve: (v: typeof result) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return chain;
}

const ok = (data: unknown) => ({ data, error: null });

function queueFrom(chains: Record<string, unknown>[]) {
  const queue = [...chains];
  const fromMock = vi.fn(() => queue.shift());
  mockedDb.mockReturnValue({ from: fromMock } as never);
  return fromMock;
}

function contactRow(overrides: Partial<Contact> = {}): Contact {
  return {
    phone: '+14155550111',
    display_name: null,
    customer_id: null,
    telegram_topic_id: null,
    topic_created_at: null,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

describe('resolveTopic: never General for a first-time contact', () => {
  // Regression guard for this file's own export. tests/sms.test.ts already
  // covers the consumer side (a brand new SMS sender never lands in
  // General), but that suite mocks resolveTopic away entirely, so resolveTopic
  // itself -- the thing that actually opens the topic -- has never been
  // unit tested directly before this.
  it('opens a real topic for a brand new phone instead of returning null', async () => {
    queueFrom([
      makeChain(ok(null)), // getOrCreateContact: upsert (result unused, only .error is)
      makeChain(ok(contactRow({ telegram_topic_id: null }))), // getOrCreateContact: select().single()
      makeChain(ok(null)), // createAndStoreTopic: update contacts
    ]);
    vi.mocked(telegram.createForumTopic).mockResolvedValue({ message_thread_id: 4242, name: 'x' });

    const threadId = await resolveTopic('+14155550111');

    expect(threadId).toBe(4242);
    expect(telegram.createForumTopic).toHaveBeenCalledWith(formatPhoneForDisplay('+14155550111'));
  });

  it('reuses the stored topic id for a known contact without creating a new one', async () => {
    queueFrom([
      makeChain(ok(null)), // upsert
      makeChain(ok(contactRow({ telegram_topic_id: 77 }))), // select().single()
    ]);

    const threadId = await resolveTopic('+14155550111');

    expect(threadId).toBe(77);
    expect(telegram.createForumTopic).not.toHaveBeenCalled();
  });
});

describe('repairTopic: recovering a deleted topic', () => {
  it('recreates a dead CONTACT topic by looking up contactByThreadId', async () => {
    queueFrom([
      makeChain(ok(contactRow({ phone: '+14155550111', telegram_topic_id: 111 }))), // contactByThreadId
      makeChain(ok(null)), // recreateTopic: clear mapping
      makeChain(ok(contactRow({ phone: '+14155550111', display_name: null }))), // recreateTopic: reload
      makeChain(ok(null)), // createAndStoreTopic: update
    ]);
    vi.mocked(telegram.createForumTopic).mockResolvedValue({ message_thread_id: 222, name: 'x' });

    const newId = await repairTopic(111);
    expect(newId).toBe(222);
  });

  // THE BUG: an index topic (e.g. Quote Requests) has no contacts row at all,
  // so contactByThreadId returns null and the original repairTopic threw
  // unconditionally. Reproduced against the pre-fix implementation (see the
  // task report for the actual failing `pnpm vitest run` output) before this
  // fallback was added; this is that reproduction, kept as the regression test.
  it('recreates a dead INDEX topic instead of throwing "no contact maps to thread"', async () => {
    queueFrom([
      makeChain(ok(null)), // contactByThreadId: no contact owns this thread
      makeChain(ok({ key: QUOTE_REQUESTS_TOPIC })), // indexTopicKeyByThreadId: found
      makeChain(ok(null)), // recreateIndexTopic: persist new id
    ]);
    vi.mocked(telegram.createForumTopic).mockResolvedValue({ message_thread_id: 333, name: 'x' });

    const newId = await repairTopic(999);

    expect(newId).toBe(333);
    expect(telegram.createForumTopic).toHaveBeenCalledTimes(1);
  });

  it('still throws when neither a contact nor an index topic maps to the thread', async () => {
    queueFrom([
      makeChain(ok(null)), // contactByThreadId: nothing
      makeChain(ok(null)), // indexTopicKeyByThreadId: nothing either
    ]);

    await expect(repairTopic(123456)).rejects.toThrow(/no contact or index topic maps to thread 123456/);
  });
});

describe('resolveIndexTopic: standing topics like Quote Requests', () => {
  it('creates the topic once and reuses the stored id on the next call', async () => {
    queueFrom([
      makeChain(ok(null)), // read: not created yet
      makeChain(ok([{ key: QUOTE_REQUESTS_TOPIC }])), // claim: won
      makeChain(ok(null)), // persist the new thread id
    ]);
    vi.mocked(telegram.createForumTopic).mockResolvedValue({ message_thread_id: 900, name: 'x' });

    const first = await resolveIndexTopic(QUOTE_REQUESTS_TOPIC);
    expect(first).toBe(900);
    expect(telegram.createForumTopic).toHaveBeenCalledTimes(1);

    queueFrom([makeChain(ok({ value: '900' }))]); // read: already created
    const second = await resolveIndexTopic(QUOTE_REQUESTS_TOPIC);
    expect(second).toBe(900);
    expect(telegram.createForumTopic).toHaveBeenCalledTimes(1); // still just once total
  });

  it('handles concurrent first-use without creating two topics', async () => {
    let storedValue: string | null = null;
    let claimWinnerPicked = false;

    // A hand-rolled, STATEFUL fake (not the FIFO queue above): two logical
    // callers genuinely interleave here, so the fake has to behave like the
    // real unique-constrained table would, not replay a fixed script.
    const statefulChain = () => {
      const chain: Record<string, unknown> = {};
      chain.select = vi.fn(() => chain);
      chain.eq = vi.fn(() => chain);
      chain.maybeSingle = vi.fn(async () => ({
        data: storedValue !== null ? { value: storedValue } : null,
        error: null,
      }));
      chain.upsert = vi.fn(() => ({
        select: vi.fn(async () => {
          if (claimWinnerPicked) return { data: [], error: null };
          claimWinnerPicked = true;
          return { data: [{ key: QUOTE_REQUESTS_TOPIC }], error: null };
        }),
      }));
      chain.update = vi.fn((patch: { value: string }) => ({
        eq: vi.fn(async () => {
          storedValue = patch.value;
          return { data: null, error: null };
        }),
      }));
      return chain;
    };
    mockedDb.mockReturnValue({ from: vi.fn(() => statefulChain()) } as never);

    vi.mocked(telegram.createForumTopic).mockImplementation(async () => {
      // A real network call takes long enough that the loser's claim attempt
      // genuinely races the winner's write, rather than this being an
      // artifact of mock scheduling. 20ms vs. the poll's 150ms retry gives
      // ample margin either way.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { message_thread_id: 555, name: 'Quote Requests' };
    });

    const [a, b] = await Promise.all([
      resolveIndexTopic(QUOTE_REQUESTS_TOPIC),
      resolveIndexTopic(QUOTE_REQUESTS_TOPIC),
    ]);

    expect(a).toBe(555);
    expect(b).toBe(555);
    expect(telegram.createForumTopic).toHaveBeenCalledTimes(1);
  });
});

describe('learnContactName: renaming a topic when a name is learned later', () => {
  it("updates display_name and renames the contact's existing topic", async () => {
    queueFrom([makeChain(ok(contactRow({ telegram_topic_id: 77, display_name: 'Jane Diaz' })))]);

    await learnContactName('+14155550111', 'Jane Diaz');

    expect(telegram.editForumTopic).toHaveBeenCalledWith(77, `Jane Diaz${' · '}${formatPhoneForDisplay('+14155550111')}`);
  });

  it('updates the name but does not touch Telegram when there is no topic yet', async () => {
    queueFrom([makeChain(ok(contactRow({ telegram_topic_id: null, display_name: 'Jane Diaz' })))]);

    await learnContactName('+14155550111', 'Jane Diaz');

    expect(telegram.editForumTopic).not.toHaveBeenCalled();
  });

  it('keeps the combined title within 128 characters, truncating the name and never the number', async () => {
    const longName = 'A'.repeat(200);
    queueFrom([makeChain(ok(contactRow({ telegram_topic_id: 88, display_name: longName })))]);

    await learnContactName('+14155550111', longName);

    const [, title] = vi.mocked(telegram.editForumTopic).mock.calls[0];
    expect(title.length).toBeLessThanOrEqual(128);
    expect(title.endsWith(formatPhoneForDisplay('+14155550111'))).toBe(true);
  });
});

describe('quoteRequestCard: the work item, not the conversation', () => {
  it('renders who, phone, channel, wants and a Done button wired through callback_actions', async () => {
    const insertChain = makeChain(ok({ id: 'cba-1' }));
    queueFrom([insertChain]);

    const payload = await quoteRequestCard({
      id: 'qr-1',
      who: 'Jane Diaz',
      phone: '+14155550111',
      source: 'call',
      wants: '200 medium boxes',
    });

    expect(payload.text).toContain('Jane Diaz');
    expect(payload.text).toContain(formatPhoneForDisplay('+14155550111'));
    expect(payload.text).toContain('📞 Call');
    expect(payload.text).toContain('200 medium boxes');
    expect(payload.reply_markup).toEqual({ inline_keyboard: [[{ text: 'Done', callback_data: 'cba-1' }]] });
    expect(insertChain.insert).toHaveBeenCalledWith({
      action: CALLBACK_ACTIONS.MARK_QUOTE_HANDLED,
      params: { id: 'qr-1' } satisfies MarkQuoteHandledParams,
    });
  });

  it('does not show the phone number twice when no name is known, and labels the SMS channel', async () => {
    queueFrom([makeChain(ok({ id: 'cba-2' }))]);
    const phone = formatPhoneForDisplay('+14155550111');

    const payload = await quoteRequestCard({
      id: 'qr-2',
      who: phone,
      phone: '+14155550111',
      source: 'sms',
      wants: 'pallet wrap',
    });

    expect(payload.text.split(phone).length - 1).toBe(1); // appears exactly once
    expect(payload.text).toContain('💬 Text');
  });

  it("escapes HTML in a customer's wants so an injected string cannot break the card", async () => {
    queueFrom([makeChain(ok({ id: 'cba-3' }))]);

    const payload = await quoteRequestCard({
      id: 'qr-3',
      who: 'Test Customer',
      phone: '+14155550111',
      source: 'sms',
      wants: '<script>alert(1)</script> and 6 boxes <18x18x16>',
    });

    expect(payload.text).not.toContain('<script>');
    expect(payload.text).toContain('&lt;script&gt;');
    expect(payload.text).toContain('&lt;18x18x16&gt;');
  });
});

describe('executeAction: MARK_QUOTE_HANDLED (the Done button)', () => {
  function callbackActionRow(overrides: Partial<CallbackAction> = {}): CallbackAction {
    return {
      id: 'cba-1',
      action: CALLBACK_ACTIONS.MARK_QUOTE_HANDLED,
      params: { id: 'qr-1' } satisfies MarkQuoteHandledParams,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      created_at: new Date().toISOString(),
      ...overrides,
    };
  }

  function callbackQuery(overrides: Partial<TelegramCallbackQuery> = {}): TelegramCallbackQuery {
    return {
      id: 'cbq-1',
      data: 'cba-1',
      from: { id: 555, is_bot: false, username: 'karim' },
      message: {
        message_id: 10,
        chat: { id: -100123456789, type: 'supergroup' },
        text: '<b>Quote requested</b>\nJane · (415) 555-0111 · 📞 Call\n\nneed 200 boxes',
      },
      ...overrides,
    };
  }

  it('marks the request handled and edits the card on the first tap', async () => {
    vi.mocked(markQuoteRequestHandled).mockResolvedValue(true);

    const toast = await executeAction(callbackActionRow(), callbackQuery());

    expect(markQuoteRequestHandled).toHaveBeenCalledWith('qr-1', 'karim');
    expect(toast).toBe('Marked handled');
    expect(telegram.editMessageText).toHaveBeenCalledTimes(1);
    const [messageId, text, extra] = vi.mocked(telegram.editMessageText).mock.calls[0];
    expect(messageId).toBe(10);
    expect(text).toContain('✅');
    expect(extra).toEqual({ reply_markup: { inline_keyboard: [] } });
  });

  it('a double tap is a no-op: markQuoteRequestHandled returning false skips the edit', async () => {
    vi.mocked(markQuoteRequestHandled).mockResolvedValue(false);

    const toast = await executeAction(callbackActionRow(), callbackQuery());

    expect(toast).toBe('Already marked handled');
    expect(telegram.editMessageText).not.toHaveBeenCalled();
  });
});
