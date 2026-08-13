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
  smsAutoSentCard: vi.fn((input: { intent: string; reply: string }) => ({
    text: `auto:${input.intent}:${input.reply}`,
  })),
  smsDraftCard: vi.fn(async (input: { phone: string; intent: string; reply: string; reason: string }) => ({
    text: `draft:${input.intent}:${input.reply}:${input.reason}`,
  })),
}));
// recordQuoteRequest has its own owner and its own concerns (the DB row, the
// Telegram card, surviving Telegram being down); mocked at the boundary here
// so this file only proves the SMS pipeline calls it, with the right
// arguments, not what it does with them.
vi.mock('../lib/quote-requests', () => ({ recordQuoteRequest: vi.fn(async () => ({ id: 'qr_1' })) }));
// The shared crm_timeline writers hold their own db conversation (a party
// resolver RPC, then an insert into a Akme-owned table) and their own tests in
// tests/crm-timeline.test.ts. Mocked at the boundary for the same reason
// resolveTopic is: this file asserts an exact sequence of .from(table) calls,
// and threading two more tables through it would break these tests every time
// something unrelated in the timeline changed. What the SMS paths hand those
// writers is asserted in tests/crm-timeline-writers.test.ts.
vi.mock('../lib/crm/timeline', () => ({
  noteInboundSms: vi.fn(async () => {}),
  noteOutboundSms: vi.fn(async () => {}),
}));

import { db } from '../lib/db';
import { resolveTopic } from '../lib/telegram/topics';
import { recordQuoteRequest } from '../lib/quote-requests';
import {
  handleTelnyxSmsEvent,
  sendSms,
  smsEventDeps,
  type SmsEventDeps,
  type TelnyxWebhookBody,
} from '../lib/telnyx/sms';

const mockedDb = vi.mocked(db);
const mockedRecordQuoteRequest = vi.mocked(recordQuoteRequest);

/**
 * These tests are about claiming events, resolving contacts and routing topics.
 * The SMS agent runs after all of that and talks to a model, so it is stubbed
 * out here and covered on its own in tests/sms-agent.test.ts. A vi.fn(), not a
 * bare arrow, so the handful of tests that care can assert what it was called
 * with (namely: did the resolved contact's display name make it through).
 */
function noAgent(): SmsEventDeps {
  return { reply: vi.fn(async () => {}) };
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
  // The door in sendSms fails closed on an unset SMS_ALLOWLIST, so every test
  // that sends has to opt its recipient in. That is the guard working: before
  // this existed, three of these tests passed while the codebase could text any
  // number in the world. `*` here rather than a list, because these tests are
  // about message handling and the allowlist has its own tests below.
  vi.stubEnv('SMS_ALLOWLIST', '*');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockedDb.mockReset();
  mockedRecordQuoteRequest.mockClear();
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

    const deps = noAgent();
    await handleTelnyxSmsEvent(inboundEvent(), deps);

    expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'messages', 'outbox']);
    // The contact's known display name has to reach replyWithAgent, or a
    // repeat texter's quote request would file under their phone number alone.
    expect(deps.reply).toHaveBeenCalledWith('+14155550111', 'hey', 42, false, 'Known Caller');
  });
});

describe('sendSms: the door', () => {
  // These four cover the ONLY function in the codebase that talks to Telnyx
  // messaging. Four callers reach it (the autopilot, a human tapping Send on a
  // card, a human replying in a topic, and the voice agent's text_me_the_list
  // mid-call), and before 2026-08-03 none of them were checked: every guard sat
  // at the point a reply was decided. Akme's email CRM had the identical hole,
  // where mayWriteTo lived in one branch and a human tap could mail a stranger.

  it('sends to nobody when SMS_ALLOWLIST is unset, rather than to everybody', async () => {
    // The fail-closed direction matters more than the check. An allowlist that
    // defaults to open means forgetting to configure it texts the world, and
    // that failure is silent and unbounded.
    vi.stubEnv('SMS_ALLOWLIST', '');
    await expect(sendSms('+14155550111', 'hi there')).rejects.toThrow(/unset, so no message may be sent/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('refuses a number that is not on the list', async () => {
    vi.stubEnv('SMS_ALLOWLIST', '+14155550999');
    await expect(sendSms('+14155550111', 'hi there')).rejects.toThrow(/not on SMS_ALLOWLIST/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('refuses an opted-out contact even when they are on the allowlist', async () => {
    // Opt-out outranks the allowlist and outranks a human tap. Carriers also
    // enforce STOP at the campaign level, but that is someone else's guarantee
    // and it cannot be asserted here.
    vi.stubEnv('SMS_ALLOWLIST', '*');
    queueFrom([makeChain(ok({ ...contactFixture(), opted_out_at: '2026-08-02T10:00:00Z' }))]);
    await expect(sendSms('+14155550111', 'hi there')).rejects.toThrow(/opted out at/i);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('lets an allowlisted, non-opted-out number through', async () => {
    // The negative tests above are only meaningful if the positive path works,
    // otherwise a door that rejects everything would pass all three.
    vi.stubEnv('SMS_ALLOWLIST', '+14155550111');
    const contact = contactFixture();
    const row = {
      id: 'msg_row_ok',
      contact_phone: contact.phone,
      direction: 'outbound',
      body: 'hi there',
      media: [],
      provider_id: null,
      provider_status: null,
      telegram_message_id: null,
      created_at: 'now',
    };
    queueFrom([
      makeChain(ok(contact)),
      makeChain(ok(row)),
      makeChain(ok({ ...row, provider_id: 'telnyx_ok', provider_status: 'sent' })),
    ]);
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'telnyx_ok' } }), { status: 200 }),
    );

    await expect(sendSms('+14155550111', 'hi there')).resolves.toMatchObject({ provider_status: 'sent' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

function contactFixture() {
  return {
    phone: '+14155550111',
    display_name: null,
    customer_id: null,
    telegram_topic_id: null,
    topic_created_at: null,
    opted_out_at: null,
    created_at: 'now',
    updated_at: 'now',
  };
}

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

describe('replyWithAgent (via smsEventDeps): a pricing text becomes a work item', () => {
  const contact = {
    phone: '+14155550111',
    display_name: null,
    customer_id: null,
    telegram_topic_id: 42,
    topic_created_at: 'now',
    created_at: 'now',
    updated_at: 'now',
  };

  /** contacts(select, found) -> messages(insert) -> messages(update): the same shape sendSms's own tests use above. */
  function autoSendChains(providerId: string) {
    const insertedRow = {
      id: 'msg_row_x',
      contact_phone: contact.phone,
      direction: 'outbound',
      body: 'reply body',
      media: [],
      provider_id: null,
      provider_status: null,
      telegram_message_id: null,
      created_at: 'now',
    };
    return [
      makeChain(ok(contact)), // resolveContact inside sendSms
      makeChain(ok(insertedRow)), // messages insert
      makeChain(ok({ ...insertedRow, provider_id: providerId, provider_status: 'sent' })), // messages update
      makeChain(ok(null)), // outbox insert: smsAutoSentCard
    ];
  }

  it('a quote-template match auto-sends and records the request in the customer\'s own words', async () => {
    queueFrom(autoSendChains('telnyx_a'));
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ data: { id: 'telnyx_a' } }), { status: 200 }),
    );

    await smsEventDeps().reply(contact.phone, 'how much for a pallet of tape', 42, false, 'Jane Doe');

    expect(fromCalls()).toEqual(['contacts', 'messages', 'messages', 'outbox']); // the auto-send path ran for real
    expect(mockedRecordQuoteRequest).toHaveBeenCalledWith({
      phone: contact.phone,
      source: 'sms',
      wants: 'how much for a pallet of tape',
      callerName: 'Jane Doe',
    });
  });

  it('a model pricing classification records the CUSTOMER\'s words, not the drafted reply', async () => {
    vi.stubEnv('NEAR_AI_API_KEY', 'test-key');
    const nearAiResponse = {
      choices: [
        {
          message: {
            tool_calls: [
              {
                function: {
                  name: 'draft_sms_reply',
                  arguments: JSON.stringify({ intent: 'pricing', reply: 'I will get a quote over to you.' }),
                },
              },
            ],
          },
        },
      ],
    };
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify(nearAiResponse), { status: 200 }));
    queueFrom([makeChain(ok(null))]); // outbox insert: smsDraftCard. autoSend is false, so nothing else runs.

    const inbound = 'I need forty cases of tape for a job next month, what would that run me';
    await smsEventDeps().reply(contact.phone, inbound, 42, false, null);

    expect(fromCalls()).toEqual(['outbox']); // never reaches sendSms or Telnyx
    expect(mockedRecordQuoteRequest).toHaveBeenCalledWith({
      phone: contact.phone,
      source: 'sms',
      wants: inbound, // the customer's own words, never draft.reply
      callerName: null,
    });
  });

  it('does not record a quote request for an hours template match', async () => {
    queueFrom(autoSendChains('telnyx_b'));
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ data: { id: 'telnyx_b' } }), { status: 200 }),
    );

    await smsEventDeps().reply(contact.phone, 'what are your hours', 42, false, null);

    expect(mockedRecordQuoteRequest).not.toHaveBeenCalled();
  });
});

describe('claimEvent writes a row the real table will actually accept', () => {
  // Why this test exists. On 2026-08-03 every single inbound SMS webhook threw
  // on its first line, because this upsert omitted `event_type` and that column
  // is NOT NULL. No message row, no card, no reply, and no delivery receipt
  // either, which then hid a completely separate carrier problem for a day.
  //
  // 323 tests were green through all of it. A mocked database does not enforce
  // NOT NULL, so the only thing that can catch this class of bug in a unit test
  // is asserting the SHAPE of what gets written against the columns the real
  // schema requires. That list is duplicated here on purpose: if a migration
  // adds a required column, this fails and names it, which is the whole point.
  const REQUIRED_COLUMNS = ['id', 'event_type', 'occurred_at'] as const;

  it('sends every NOT NULL column of telnyx_events', async () => {
    const upsert = vi.fn((_row: Record<string, unknown>) => ({
      select: async () => ({ data: [{ id: 'evt-1' }], error: null }),
    }));
    queueFrom([{ upsert }]);

    await handleTelnyxSmsEvent(inboundEvent(), noAgent()).catch(() => {});

    expect(upsert).toHaveBeenCalled();
    const row = upsert.mock.calls[0][0];
    for (const column of REQUIRED_COLUMNS) {
      expect(row[column], `telnyx_events.${column} is NOT NULL and was not sent`).not.toBeUndefined();
      expect(row[column], `telnyx_events.${column} is NOT NULL and was sent as null`).not.toBeNull();
    }
  });

  it('carries the real event_type through, not a placeholder', async () => {
    const upsert = vi.fn((_row: Record<string, unknown>) => ({
      select: async () => ({ data: [{ id: 'evt-1' }], error: null }),
    }));
    queueFrom([{ upsert }]);

    await handleTelnyxSmsEvent(inboundEvent(), noAgent()).catch(() => {});

    expect(upsert.mock.calls[0][0].event_type).toBe('message.received');
  });
});

describe('a failed delivery is reported, not just recorded', () => {
  function receipt(status: string, errors?: { title?: string; detail?: string }[]): TelnyxWebhookBody {
    return {
      data: {
        id: 'evt-dlr-1',
        event_type: 'message.finalized',
        occurred_at: '2026-08-03T18:00:00.000Z',
        payload: {
          id: 'msg-1',
          direction: 'outbound',
          from: { phone_number: '+14155550100' },
          to: [{ phone_number: '+14155550142', status }],
          text: 'anything',
          type: 'SMS',
          ...(errors ? { errors } : {}),
        },
      },
    };
  }

  const claimed = () => ({ upsert: () => ({ select: async () => ({ data: [{ id: 'evt-dlr-1' }], error: null }) }) });
  const updated = () => ({ update: () => ({ eq: async () => ({ error: null }) }) });

  it('raises a card carrying the carrier\'s actual reason', async () => {
    const insert = vi.fn(async (_row: { payload: { text: string } }) => ({ error: null }));
    queueFrom([claimed(), updated(), { insert }]);

    await handleTelnyxSmsEvent(
      receipt('delivery_failed', [
        { title: 'Not 10DLC registered', detail: 'The sending number is not 10DLC-registered but is required to be by the carrier.' },
      ]),
      noAgent(),
    );

    expect(insert).toHaveBeenCalledTimes(1);
    const text = insert.mock.calls[0][0].payload.text;
    expect(text).toContain('failed to deliver');
    expect(text).toContain('Not 10DLC registered');
    expect(text).toContain('(415) 555-0142'); // readable, not raw E.164
  });

  it('stays quiet on a delivered receipt, which is the common case', async () => {
    const insert = vi.fn(async () => ({ error: null }));
    queueFrom([claimed(), updated(), { insert }]);

    await handleTelnyxSmsEvent(receipt('delivered'), noAgent());

    expect(insert).not.toHaveBeenCalled();
  });
});
