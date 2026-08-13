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
import { classifyCallForTimeline } from '../lib/worker/conversation';

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
    // Speaker-labeled, which is what lib/worker/transcribe.ts really produces:
    // one line per utterance, tagged with the physical channel. The flat string
    // this used to hold is the fallback AssemblyAI only takes when it returns no
    // utterances, and it is now its own case below.
    transcript: 'Speaker 1: Akme, how can I help?\nSpeaker 2: hello, do you deliver to Capital City',
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
      caveat: null, // both sides spoke, so there is nothing for a reader to discount
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

// ---------------------------------------------------------------------------
// The door in front of the three writers.
//
// All three are ADDITIVE, which is exactly why one is needed: every event that
// arrives reaches them, and not every event is the customer talking. A carrier
// keyword is a command aimed at the compliance machinery, and a dialer that
// connects and never speaks is not a phone call anybody made. Both used to land
// on the customer's shared thread as if they had said it.
// ---------------------------------------------------------------------------

describe('a carrier keyword text never reaches the timeline', () => {
  for (const word of ['STOP', 'stop', 'STOPALL', ' Unsubscribe ', 'cancel', 'START', 'unstop', 'HELP', 'info', 'opt out']) {
    it(`files "${word.trim()}" in messages and writes no timeline event`, async () => {
      queueFrom(inboundChains());

      await handleTelnyxSmsEvent(inboundEvent({ text: word }), noAgent());

      // The book of record still gets it: only the reading surface is spared.
      expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'messages', 'outbox']);
      expect(timeline.noteInboundSms).not.toHaveBeenCalled();
    });
  }

  // Closing the timeline door must not close the opt-out one. replyWithAgent is
  // what stamps opted_out_at, and a STOP that never reaches it is a customer who
  // asked to leave and keeps getting texted.
  it('still hands a STOP to the reply path that records the opt-out', async () => {
    queueFrom(inboundChains());
    const deps = noAgent();

    await handleTelnyxSmsEvent(inboundEvent({ text: 'STOP' }), deps);

    expect(deps.reply).toHaveBeenCalledTimes(1);
    expect(deps.reply).toHaveBeenCalledWith('+14155550111', 'STOP', 42, false, 'Jane Doe');
  });

  // The keywords are whole-message words. A sentence containing one is speech.
  it('keeps a sentence that merely contains the word', async () => {
    queueFrom(inboundChains());

    await handleTelnyxSmsEvent(inboundEvent({ text: 'can you stop by with the pallet wrap' }), noAgent());

    expect(timeline.noteInboundSms).toHaveBeenCalledTimes(1);
  });
});

describe('a text with nothing in it never reaches the timeline', () => {
  it('writes no event when there is neither text nor an attachment', async () => {
    queueFrom(inboundChains());

    await handleTelnyxSmsEvent(inboundEvent({ text: null }), noAgent());

    expect(fromCalls()).toEqual(['telnyx_events', 'contacts', 'messages', 'outbox']);
    expect(timeline.noteInboundSms).not.toHaveBeenCalled();
  });

  it('writes no event for a whitespace-only body', async () => {
    queueFrom(inboundChains());

    await handleTelnyxSmsEvent(inboundEvent({ text: '   \n ' }), noAgent());

    expect(timeline.noteInboundSms).not.toHaveBeenCalled();
  });

  /**
   * A short code is five or six digits, so toE164 returns null and assertE164
   * throws before anything is filed. Pinned rather than fixed: it keeps carrier
   * and A2P traffic off the timeline, which is this change's job, but it does it
   * by dropping the message entirely, and claimEvent has already taken the id by
   * then so the Telnyx retry no-ops. A short-code text is currently invisible to
   * everyone. Making it visible is a contacts and messages FK question, not a
   * timeline one.
   */
  it('never reaches the writer from a short code, because the phone never parses', async () => {
    queueFrom([makeChain(ok([{ id: 'evt_1' }]))]); // only claimEvent runs

    await expect(
      handleTelnyxSmsEvent(inboundEvent({ from: { phone_number: '62792' } }), noAgent()),
    ).rejects.toThrow(/not E.164/);

    expect(timeline.noteInboundSms).not.toHaveBeenCalled();
  });
});

describe('classifyCallForTimeline decides what a conversation is', () => {
  it('drops a recording with no speech on it', () => {
    expect(classifyCallForTimeline(makeCall({ transcript: '   \n ' }))).toEqual({
      write: false,
      reason: expect.stringContaining('no speech'),
    });
  });

  it('drops a recording where the labels are there but every line is empty', () => {
    expect(classifyCallForTimeline(makeCall({ transcript: 'Speaker 1:\nSpeaker 2:  ' })).write).toBe(false);
  });

  // The dialer case: it connected, heard the greeting, and never said a word.
  it('drops a call where only one side ever spoke', () => {
    const call = makeCall({
      transcript: 'Speaker 1: Akme, how can I help?\nSpeaker 1: Hello? Anyone there?',
    });

    expect(classifyCallForTimeline(call)).toEqual({
      write: false,
      reason: expect.stringContaining('one side'),
    });
  });

  it('writes a call both sides spoke on, with nothing to discount', () => {
    expect(classifyCallForTimeline(makeCall())).toEqual({ write: true, caveat: null });
  });

  // Never a drop. duration_sec spans ring, disclosure and speech, so a real
  // twelve second question sits under any threshold that would catch a dialer.
  it('writes a twelve second real call clean', () => {
    const call = makeCall({
      duration_sec: 12,
      transcript: 'Speaker 1: Akme, how can I help?\nSpeaker 2: hi do you deliver to Shelbyville',
    });

    expect(classifyCallForTimeline(call)).toEqual({ write: true, caveat: null });
  });

  // Cannot tell, so it is written and flagged rather than silently dropped.
  it('writes an unlabeled transcript with a caveat instead of dropping it', () => {
    const verdict = classifyCallForTimeline(makeCall({ transcript: 'hello, do you deliver to Capital City' }));

    expect(verdict.write).toBe(true);
    expect(verdict.write && verdict.caveat).toMatch(/not known whether the caller spoke/i);
  });

  it('writes a call that has no transcript field at all with a caveat, never dropping it silently', () => {
    expect(classifyCallForTimeline(makeCall({ transcript: null })).write).toBe(false);
  });
});

describe('the worker acts on the verdict', () => {
  it('advances a one-sided call without putting it on the customer thread', async () => {
    const calls = useCallsDb([
      makeCall({ transcript: 'Speaker 1: Akme, how can I help?\nSpeaker 1: Hello? Anyone there?' }),
    ]);
    vi.mocked(summarizeCall).mockResolvedValue(SUMMARY);

    const result = await runWorker(5, { drain: noDrain });

    // The call itself is untouched: the summary is stored, the row advances, and
    // the next step still builds the Telegram card a human reads.
    expect(result.advanced).toBe(1);
    expect(calls[0].status).toBe('summarizing');
    expect(calls[0].summary).toEqual(SUMMARY);
    expect(timeline.noteCallSummary).not.toHaveBeenCalled();
  });

  it('passes the caveat through to the writer when it cannot tell', async () => {
    useCallsDb([makeCall({ transcript: 'hello, do you deliver to Capital City' })]);
    vi.mocked(summarizeCall).mockResolvedValue(SUMMARY);

    await runWorker(5, { drain: noDrain });

    expect(timeline.noteCallSummary).toHaveBeenCalledTimes(1);
    expect(timeline.noteCallSummary.mock.calls[0][0].caveat).toMatch(/not known whether the caller spoke/i);
  });
});
