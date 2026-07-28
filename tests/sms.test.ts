import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyTelnyxWebhook } from '../lib/telnyx/signature';

/**
 * db() is mocked at the module boundary: every test wires up the exact
 * sequence of `.from(table)` calls the code under test makes, in order.
 * Supabase's query builder is thenable and also exposes .single()/.maybeSingle();
 * this fake supports both by resolving to the same fixed result either way.
 */
function makeChain(result: { data: unknown; error: { message: string; code?: string } | null }) {
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

vi.mock('../lib/db', () => ({ db: vi.fn() }));

// Mocked at the boundary rather than driven through the db fake: resolveTopic
// has its own db conversation and its own tests in tests/telegram.test.ts, and
// threading it through this file's exact-sequence fake would make these tests
// fail whenever unrelated topic logic changed.
vi.mock('../lib/telegram/topics', () => ({ resolveTopic: vi.fn(async () => 42) }));
vi.mock('../lib/telegram/cards', () => ({
  inboundSmsCard: vi.fn((input: { body: string | null }) => ({ text: input.body ?? '(empty)' })),
}));

import { db } from '../lib/db';
import { resolveTopic } from '../lib/telegram/topics';
import {
  handleTelnyxSmsEvent,
  sendSms,
  type SmsEventDeps,
  type TelnyxWebhookBody,
} from '../lib/telnyx/sms';

const mockedDb = vi.mocked(db);

/**
 * These tests are about claiming events, resolving contacts and routing topics.
 * The SMS agent runs after all of that and talks to a model, so it is stubbed
 * out here and covered on its own in tests/sms-agent.test.ts.
 */
function noAgent(): SmsEventDeps {
  return { reply: async () => {} };
}

// Shared across a test's whole call sequence so `fromCalls()` sees every
// `.from(table)` invocation regardless of how many times `db()` itself is called.
let fromMock: ReturnType<typeof vi.fn>;

function queueFrom(chains: Record<string, unknown>[]) {
  const queue = [...chains];
  fromMock = vi.fn(() => queue.shift());
  mockedDb.mockReturnValue({ from: fromMock } as never);
}

function fromCalls(): string[] {
  return fromMock.mock.calls.map((c) => c[0] as string);
}

beforeEach(() => {
  vi.stubEnv('TELNYX_API_KEY', 'test-key');
  vi.stubEnv('TELNYX_PUBLIC_KEY', 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=');
  vi.stubEnv('TELNYX_NUMBER', '+14155550100');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockedDb.mockReset();
});

function inboundEvent(overrides: Partial<TelnyxWebhookBody['data']['payload']> = {}): TelnyxWebhookBody {
  return {
    data: {
      id: 'evt_1',
      event_type: 'message.received',
      occurred_at: '2026-07-27T00:00:00Z',
      payload: {
        id: 'msg_provider_1',
        direction: 'inbound',
        from: { phone_number: '+14155550111' },
        to: [{ phone_number: '+14155550100' }],
        text: 'hey',
        type: 'SMS',
        ...overrides,
      },
    },
  };
}

describe('verifyTelnyxWebhook (signature rejection)', () => {
  it('rejects when the signature does not verify', () => {
    const result = verifyTelnyxWebhook('{"data":{}}', 'bm90LWEtcmVhbC1zaWc=', String(Math.floor(Date.now() / 1000)));
    expect(result.ok).toBe(false);
  });

  it('rejects a missing signature header outright', () => {
    const result = verifyTelnyxWebhook('{"data":{}}', null, String(Math.floor(Date.now() / 1000)));
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/missing/i);
  });
});

describe('handleTelnyxSmsEvent: dedupe', () => {
  it('no-ops on a duplicate event id', async () => {
    queueFrom([makeChain(ok([]))]); // upsert().select('id') -> empty rows = already claimed
    await handleTelnyxSmsEvent(inboundEvent());
    expect(fromCalls()).toEqual(['telnyx_events']);
  });
});

describe('handleTelnyxSmsEvent: topic routing', () => {
  // Regression guard. This shipped broken once: the outbox row took thread_id
  // straight from contact.telegram_topic_id, which is null for every first-time
  // sender. A null thread_id is not "unknown", it means General, and the drain
  // cannot repair it because an outbox row carries no phone number. So every new
  // number's first text landed in the General topic instead of opening its own,
  // which is the single behaviour this whole design exists to produce.
  it('routes a brand new sender into a resolved topic, never General', async () => {
    const outboxChain = makeChain(ok(null));
    queueFrom([
      makeChain(ok([{ id: 'evt_1' }])), // telnyx_events upsert: new
      makeChain(ok(null)), // contacts select: not found
      makeChain(ok(null)), // customers select: no match
      makeChain(
        ok({
          phone: '+14155550111',
          display_name: null,
          customer_id: null,
          telegram_topic_id: null, // the trap: no topic yet
          topic_created_at: null,
          created_at: 'now',
          updated_at: 'now',
        }),
      ), // contacts insert
      makeChain(ok(null)), // messages insert
      outboxChain, // outbox insert
    ]);

    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    expect(vi.mocked(resolveTopic)).toHaveBeenCalledWith('+14155550111');

    const inserted = (outboxChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      thread_id: number | null;
    };
    expect(inserted.thread_id).toBe(42); // the resolved topic, not null
  });
});

describe('handleTelnyxSmsEvent: inbound contact resolution', () => {
  it('creates a contact for a new sender', async () => {
    queueFrom([
      makeChain(ok([{ id: 'evt_1' }])), // telnyx_events upsert: genuinely new
      makeChain(ok(null)), // contacts select: not found
      makeChain(ok({ id: 'cust_1' })), // customers select: matched by phone
      makeChain(
        ok({
          phone: '+14155550111',
          display_name: null,
          customer_id: 'cust_1',
          telegram_topic_id: null,
          topic_created_at: null,
          created_at: 'now',
          updated_at: 'now',
        }),
      ), // contacts insert
      makeChain(ok(null)), // messages insert
      makeChain(ok(null)), // outbox insert
    ]);

    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'customers', 'contacts', 'messages', 'outbox']);
  });

  it('reuses an existing contact for a known sender', async () => {
    const existing = {
      phone: '+14155550111',
      display_name: 'Known Caller',
      customer_id: 'cust_1',
      telegram_topic_id: 42,
      topic_created_at: 'now',
      created_at: 'now',
      updated_at: 'now',
    };
    queueFrom([
      makeChain(ok([{ id: 'evt_1' }])), // telnyx_events upsert: new
      makeChain(ok(existing)), // contacts select: found
      makeChain(ok(null)), // messages insert
      makeChain(ok(null)), // outbox insert
    ]);

    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'messages', 'outbox']);
  });
});

describe('sendSms: outbound', () => {
  it('records the message row before sending, then records provider_id', async () => {
    const callOrder: string[] = [];
    const contact = {
      phone: '+14155550111',
      display_name: null,
      customer_id: null,
      telegram_topic_id: null,
      topic_created_at: null,
      created_at: 'now',
      updated_at: 'now',
    };
    const insertedRow = {
      id: 'msg_row_1',
      contact_phone: contact.phone,
      direction: 'outbound',
      body: 'hi there',
      media: [],
      provider_id: null,
      provider_status: null,
      telegram_message_id: null,
      created_at: 'now',
    };

    const contactsChain = makeChain(ok(contact));
    const insertChain = makeChain(ok(insertedRow));
    // Record ordering the moment the insert's result is actually read: sendSms's
    // insert call terminates on .single(), so that is the fixed point to hook.
    insertChain.single = vi.fn(() => {
      callOrder.push('db-insert-messages');
      return Promise.resolve(ok(insertedRow));
    });

    const updateChain = makeChain(ok({ ...insertedRow, provider_id: 'telnyx_msg_1', provider_status: 'sent' }));

    queueFrom([contactsChain, insertChain, updateChain]);

    vi.mocked(fetch).mockImplementation(async () => {
      callOrder.push('telnyx-fetch');
      return new Response(JSON.stringify({ data: { id: 'telnyx_msg_1' } }), { status: 200 });
    });

    const result = await sendSms('+14155550111', 'hi there');

    expect(callOrder).toEqual(['db-insert-messages', 'telnyx-fetch']);
    expect(result.provider_id).toBe('telnyx_msg_1');
    expect(fromCalls()).toEqual(['contacts', 'messages', 'messages']);
  });

  it('sends media_urls for MMS', async () => {
    const contact = {
      phone: '+14155550111',
      display_name: null,
      customer_id: null,
      telegram_topic_id: null,
      topic_created_at: null,
      created_at: 'now',
      updated_at: 'now',
    };
    const insertedRow = {
      id: 'msg_row_2',
      contact_phone: contact.phone,
      direction: 'outbound',
      body: 'pic',
      media: [{ url: 'https://example.com/a.jpg', content_type: 'image/jpeg' }],
      provider_id: null,
      provider_status: null,
      telegram_message_id: null,
      created_at: 'now',
    };

    queueFrom([
      makeChain(ok(contact)),
      makeChain(ok(insertedRow)),
      makeChain(ok({ ...insertedRow, provider_id: 'telnyx_msg_2', provider_status: 'sent' })),
    ]);

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const sentBody = JSON.parse(init!.body as string);
      expect(sentBody.media_urls).toEqual(['https://example.com/a.jpg']);
      return new Response(JSON.stringify({ data: { id: 'telnyx_msg_2' } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await sendSms('+14155550111', 'pic', [{ url: 'https://example.com/a.jpg', content_type: 'image/jpeg' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
