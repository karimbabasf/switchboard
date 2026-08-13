import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Call, CallSummary } from '../lib/types';
import type { CallSummaryEntry, InboundSmsEntry, OutboundSmsEntry, TimelineRow } from '../lib/crm/timeline';

/**
 * The three switchboard writers that fill the shared crm_timeline from live
 * traffic: an inbound text as the webhook files it, an outbound text as it
 * leaves the door, and a call as soon as its summary is stored.
 *
 * All three are ADDITIVE. None may change what its path already did, and none
 * may drop a text or strand a call when the timeline write fails, so the
 * failure case is tested as hard as the happy one. What the writers then send
 * to Postgres is tests/crm-timeline.test.ts's job; this file only proves the
 * three paths call them, with the right event, exactly once.
 */

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_STORAGE_BUCKET = 'recordings';

// Typed with the real signatures, so an argument these tests assert on cannot
// drift from the writer that receives it without tsc saying so.
const timeline = vi.hoisted(() => ({
  noteInboundSms: vi.fn<(input: InboundSmsEntry) => Promise<TimelineRow>>(),
  noteOutboundSms: vi.fn<(input: OutboundSmsEntry) => Promise<TimelineRow>>(),
  noteCallSummary: vi.fn<(input: CallSummaryEntry) => Promise<TimelineRow>>(),
}));
vi.mock('../lib/crm/timeline', () => timeline);

const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db', () => ({
  db: () => dbBox.client,
  unwrap: (res: { data: unknown; error: { message: string } | null }, what: string) => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data;
  },
}));

// Same boundary mocks tests/sms.test.ts uses, and for the same reason: these
// modules hold their own db conversations and their own tests.
vi.mock('../lib/telegram/topics', () => ({ resolveTopic: vi.fn(async () => 42) }));
vi.mock('../lib/telegram/cards', () => ({
  inboundSmsCard: vi.fn((input: { body: string | null }) => ({ text: input.body ?? '(empty)' })),
}));
vi.mock('../lib/quote-requests', () => ({ recordQuoteRequest: vi.fn(async () => ({ id: 'qr_1' })) }));
vi.mock('../lib/worker/summarize', () => ({ summarizeCall: vi.fn() }));

import { handleTelnyxSmsEvent, sendSms, type SmsEventDeps, type TelnyxWebhookBody } from '../lib/telnyx/sms';
import { runWorker } from '../lib/worker/run';
import { summarizeCall } from '../lib/worker/summarize';

// ---------------------------------------------------------------------------
// The queued-chain db fake from tests/sms.test.ts: each test wires up the exact
// sequence of .from(table) calls the code under test makes, in order.
// ---------------------------------------------------------------------------
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

let fromMock: ReturnType<typeof vi.fn>;

function queueFrom(chains: Record<string, unknown>[]) {
  const queue = [...chains];
  fromMock = vi.fn(() => queue.shift());
  dbBox.client = { from: fromMock };
}

function fromCalls(): string[] {
  return fromMock.mock.calls.map((c) => c[0] as string);
}

const CONTACT = {
  phone: '+14155550111',
  display_name: 'Jane Doe',
  customer_id: 'cust_1',
  telegram_topic_id: 42,
  topic_created_at: 'now',
  opted_out_at: null,
  created_at: '2026-08-13T17:00:00.000Z',
  updated_at: '2026-08-13T17:00:00.000Z',
};

function inboundEvent(overrides: Partial<TelnyxWebhookBody['data']['payload']> = {}): TelnyxWebhookBody {
  return {
    data: {
      id: 'evt_1',
      event_type: 'message.received',
      occurred_at: '2026-08-13T17:00:00.000Z',
      payload: {
        id: 'msg_provider_1',
        direction: 'inbound',
        from: { phone_number: '+14155550111' },
        to: [{ phone_number: '+14155550100' }],
        text: 'do you deliver to Capital City',
        type: 'SMS',
        ...overrides,
      },
    },
  };
}

/** The four chains a known sender's inbound text consumes, in order. */
function inboundChains(outboxChain = makeChain(ok(null))) {
  return [
    makeChain(ok([{ id: 'evt_1' }])), // telnyx_events upsert: genuinely new
    makeChain(ok(CONTACT)), // contacts select: known sender
    makeChain(ok({ id: 'msg-row-1' })), // messages insert, returning the row the timeline points at
    outboxChain, // outbox insert
  ];
}

function noAgent(): SmsEventDeps {
  return { reply: vi.fn(async () => {}) };
}

/** No caller reads the row back; this only satisfies the writers' return type. */
function timelineRow(id: string): TimelineRow {
  return {
    id,
    party_id: 'party-1',
    channel: 'sms',
    direction: 'in',
    body: '',
    occurred_at: '2026-08-13T17:00:00.000Z',
    source_table: null,
    source_id: null,
    order_id: null,
    shadow: true,
    created_at: '2026-08-13T17:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  timeline.noteInboundSms.mockResolvedValue(timelineRow('tl-1'));
  timeline.noteOutboundSms.mockResolvedValue(timelineRow('tl-2'));
  timeline.noteCallSummary.mockResolvedValue(timelineRow('tl-3'));
  vi.stubEnv('TELNYX_API_KEY', 'test-key');
  vi.stubEnv('TELNYX_NUMBER', '+14155550100');
  vi.stubEnv('SMS_ALLOWLIST', '*');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('an inbound text lands on the timeline', () => {
  it('appends one sms-in event pointing at the messages row that owns the truth', async () => {
    queueFrom(inboundChains());

    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    expect(timeline.noteInboundSms).toHaveBeenCalledTimes(1);
    expect(timeline.noteInboundSms).toHaveBeenCalledWith({
      phone: '+14155550111',
      body: 'do you deliver to Capital City',
      messageId: 'msg-row-1',
      occurredAt: '2026-08-13T17:00:00.000Z', // the webhook's time, not this machine's
      displayName: 'Jane Doe',
    });
  });

  // Telnyx retries a messaging webhook up to 6 times on anything but a 2xx.
  // claimEvent is the first line of defence and the (source_table, source_id)
  // unique index is the second, proven in tests/crm-timeline.test.ts.
  it('appends one event in total when Telnyx redelivers the same message', async () => {
    queueFrom(inboundChains());
    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    queueFrom([makeChain(ok([]))]); // telnyx_events upsert: already claimed
    await handleTelnyxSmsEvent(inboundEvent(), noAgent());

    expect(timeline.noteInboundSms).toHaveBeenCalledTimes(1);
  });

  // A reading surface is not allowed to cost a customer their text.
  it('files the text and raises the card anyway when the timeline write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    timeline.noteInboundSms.mockRejectedValue(new Error('timeline is down'));
    const outboxChain = makeChain(ok(null));
    queueFrom(inboundChains(outboxChain));
    const deps = noAgent();

    await handleTelnyxSmsEvent(inboundEvent(), deps);

    expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'messages', 'outbox']);
    expect((outboxChain.insert as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ thread_id: 42 });
    expect(deps.reply).toHaveBeenCalledTimes(1);
  });

  it('passes an MMS with no text through, and lets the writer name it', async () => {
    queueFrom(inboundChains());

    await handleTelnyxSmsEvent(
      inboundEvent({ text: null, type: 'MMS', media: [{ url: 'https://x/1.jpg', content_type: 'image/jpeg' }] }),
      noAgent(),
    );

    expect(timeline.noteInboundSms.mock.calls[0][0]).toMatchObject({ body: null, messageId: 'msg-row-1' });
  });
});

describe('an outbound text lands on the timeline, whoever sent it', () => {
  /** The three chains sendSms consumes: contact, insert, record provider_id. */
  function sendChains() {
    const row = {
      id: 'msg-row-2',
      contact_phone: CONTACT.phone,
      direction: 'outbound',
      body: 'Hi, we are open 8 to 4 Monday to Friday.',
      media: [],
      provider_id: null,
      provider_status: null,
      telegram_message_id: null,
      created_at: '2026-08-13T17:05:00.000Z',
    };
    return [
      makeChain(ok(CONTACT)),
      makeChain(ok(row)),
      makeChain(ok({ ...row, provider_id: 'telnyx_ok', provider_status: 'sent' })),
    ];
  }

  it('appends one sms-out event after the send really succeeded', async () => {
    queueFrom(sendChains());
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { id: 'telnyx_ok' } }), { status: 200 }));

    await sendSms('+14155550111', 'Hi, we are open 8 to 4 Monday to Friday.');

    expect(timeline.noteOutboundSms).toHaveBeenCalledTimes(1);
    expect(timeline.noteOutboundSms).toHaveBeenCalledWith({
      phone: '+14155550111',
      body: 'Hi, we are open 8 to 4 Monday to Friday.',
      messageId: 'msg-row-2',
      occurredAt: '2026-08-13T17:05:00.000Z',
    });
  });

  // The row means "this reached the customer". A send Telnyx rejected did not.
  it('appends nothing when the send failed', async () => {
    queueFrom([...sendChains(), makeChain(ok(null))]); // the fourth chain is the failure update
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ errors: [{ code: 40010 }] }), { status: 400 }));

    await expect(sendSms('+14155550111', 'Hi, we are open 8 to 4 Monday to Friday.')).rejects.toThrow(/telnyx/i);

    expect(timeline.noteOutboundSms).not.toHaveBeenCalled();
  });

  // The text is already on the customer's phone by here and cannot be recalled.
  it('returns the sent message anyway when the timeline write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    timeline.noteOutboundSms.mockRejectedValue(new Error('timeline is down'));
    queueFrom(sendChains());
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: { id: 'telnyx_ok' } }), { status: 200 }));

    const sent = await sendSms('+14155550111', 'Hi, we are open 8 to 4 Monday to Friday.');

    expect(sent).toMatchObject({ provider_id: 'telnyx_ok', provider_status: 'sent' });
  });
});

// ---------------------------------------------------------------------------
// The call worker. A stateful `calls` fake, cut down from tests/worker.test.ts
// to the one step this file cares about: transcribing -> summarizing.
// ---------------------------------------------------------------------------
const SUMMARY: CallSummary = {
  headline: 'Asked whether we deliver to Capital City',
  caller_wanted: 'a delivery date for 20 boxes',
  commitments: [],
  action_items: ['confirm Thursday delivery'],
  needs_followup: true,
  sentiment: 'neutral',
};

function makeCall(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    contact_phone: '+14155550111',
    direction: 'inbound',
    provider_call_id: 'v3:abc',
    started_at: '2026-08-13T16:28:00.000Z',
    answered_at: '2026-08-13T16:28:05.000Z',
    ended_at: '2026-08-13T16:30:00.000Z',
    duration_sec: 115,
    was_answered: true,
    recording_url: null,
    storage_path: 'calls/call-1.mp3',
    transcript: 'hello, do you deliver to Capital City',
    summary: null,
    status: 'transcribing',
    attempts: 0,
    last_error: null,
    telegram_message_id: null,
    created_at: '2026-08-13T16:30:01.000Z',
    updated_at: '2026-08-13T16:30:01.000Z',
    ...overrides,
  };
}

function useCallsDb(seed: Call[]) {
  const calls = seed.map((c) => ({ ...c }) as Record<string, unknown>);

  function updateBuilder(patch: Record<string, unknown>) {
    const filters: Record<string, unknown> = {};
    let wantsSelect = false;
    const execute = async () => {
      const idx = calls.findIndex((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
      if (idx === -1) return wantsSelect ? { data: null, error: null } : { error: null };
      calls[idx] = { ...calls[idx], ...patch };
      return wantsSelect ? { data: { ...calls[idx] }, error: null } : { error: null };
    };
    const builder = {
      eq(column: string, value: unknown) {
        filters[column] = value;
        return builder;
      },
      select() {
        wantsSelect = true;
        return builder;
      },
      maybeSingle: execute,
      then: (onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
        execute().then(onFulfilled, onRejected),
    };
    return builder;
  }

  dbBox.client = {
    from(table: string) {
      if (table !== 'calls') throw new Error(`fake db: unhandled table "${table}"`);
      return {
        select: () => ({
          not: () => ({
            order: () => ({
              async limit(n: number) {
                return { data: calls.filter((c) => c.status !== 'posted' && c.status !== 'failed').slice(0, n), error: null };
              },
            }),
          }),
        }),
        update: updateBuilder,
      };
    },
  };
  return calls;
}

const noDrain = async () => ({ processed: 0, sent: 0, throttled: 0, repaired: 0, failed: 0 });

describe('a finished call lands on the timeline', () => {
  it('appends one call-in event once the summary is stored, stamped when the call happened', async () => {
    const calls = useCallsDb([makeCall()]);
    vi.mocked(summarizeCall).mockResolvedValue(SUMMARY);

    const result = await runWorker(5, { drain: noDrain });

    expect(result.advanced).toBe(1);
    expect(calls[0].status).toBe('summarizing'); // the summary is durable before the timeline hears about it
    expect(timeline.noteCallSummary).toHaveBeenCalledTimes(1);
    expect(timeline.noteCallSummary).toHaveBeenCalledWith({
      phone: '+14155550111',
      callId: 'call-1',
      summary: SUMMARY,
      occurredAt: '2026-08-13T16:30:00.000Z', // ended_at, not the worker's clock
    });
  });

  it('falls back to when the call started if it never got an end time', async () => {
    useCallsDb([makeCall({ ended_at: null })]);
    vi.mocked(summarizeCall).mockResolvedValue(SUMMARY);

    await runWorker(5, { drain: noDrain });

    expect(timeline.noteCallSummary.mock.calls[0][0]).toMatchObject({ occurredAt: '2026-08-13T16:28:00.000Z' });
  });

  // A timeline that is down must not send an already-summarized call back round
  // the retry loop, where MAX_ATTEMPTS would eventually mark it failed.
  it('advances the call anyway when the timeline write throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls = useCallsDb([makeCall()]);
    vi.mocked(summarizeCall).mockResolvedValue(SUMMARY);
    timeline.noteCallSummary.mockRejectedValue(new Error('timeline is down'));

    const result = await runWorker(5, { drain: noDrain });

    expect(result.advanced).toBe(1);
    expect(result.errored).toBe(0);
    expect(calls[0].status).toBe('summarizing');
    expect(calls[0].attempts).toBe(0); // the step succeeded, so its retry budget resets
  });

  it('writes nothing for a step that is not the summarize step', async () => {
    useCallsDb([makeCall({ status: 'summarizing', summary: SUMMARY })]);

    await runWorker(5, { drain: noDrain, callCard: async () => [] });

    expect(timeline.noteCallSummary).not.toHaveBeenCalled();
  });
});
