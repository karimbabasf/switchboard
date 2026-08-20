import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The door between a customer's text and Akme's deal engine.
 *
 * Before this existed, every inbound text ran this repo's own SMS agent, which
 * drafted a reply and put a Send button in Telegram. That is the ping Karim got
 * on 2026-08-19 when he texted the business asking to order: nothing was wrong,
 * the text had simply never been wired to the engine that knows about orders.
 *
 * What these tests pin is the routing, and above all the two cases that are easy
 * to collapse into one: the desk saying "I did nothing" (safe to answer around)
 * and the desk not answering at all (NOT safe, because it may have recorded a
 * quote as sent one millisecond after the socket closed).
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
vi.mock('../lib/telegram/topics', () => ({ resolveTopic: vi.fn(async () => 42) }));
vi.mock('../lib/telegram/cards', () => ({
  inboundSmsCard: vi.fn((input: { body: string | null }) => ({ text: input.body ?? '(empty)' })),
  smsAutoSentCard: vi.fn((input: { intent: string; reply: string }) => ({
    text: `auto:${input.intent}:${input.reply}`,
  })),
  smsDraftCard: vi.fn(async (input: { intent: string; reply: string }) => ({
    text: `draft:${input.intent}:${input.reply}`,
  })),
  deskDownCard: vi.fn((input: { reason: string }) => ({ text: `deskdown:${input.reason}` })),
}));
vi.mock('../lib/quote-requests', () => ({ recordQuoteRequest: vi.fn(async () => ({ id: 'qr_1' })) }));
vi.mock('../lib/crm/timeline', () => ({
  noteInboundSms: vi.fn(async () => {}),
  noteOutboundSms: vi.fn(async () => {}),
}));
vi.mock('../lib/akme/desk', () => ({ askAkmeDesk: vi.fn() }));

import { db } from '../lib/db';
import { askAkmeDesk } from '../lib/akme/desk';
import { smsEventDeps } from '../lib/telnyx/sms';

const mockedDb = vi.mocked(db);
const mockedDesk = vi.mocked(askAkmeDesk);

const contact = {
  phone: '+14155550111',
  display_name: 'Jane Doe',
  customer_id: null,
  telegram_topic_id: 42,
  topic_created_at: 'now',
  created_at: 'now',
  updated_at: 'now',
};

let fromMock: ReturnType<typeof vi.fn>;

function queueFrom(chains: Record<string, unknown>[]) {
  const queue = [...chains];
  fromMock = vi.fn(() => queue.shift());
  mockedDb.mockReturnValue({ from: fromMock } as never);
}

function fromCalls(): string[] {
  return fromMock.mock.calls.map((c) => c[0] as string);
}

/** contacts(select) -> messages(insert) -> messages(update) -> outbox(insert). */
function sendChains() {
  const row = {
    id: 'msg_row_x',
    contact_phone: contact.phone,
    direction: 'outbound',
    body: 'reply body',
    media: [],
    provider_id: null,
    provider_status: null,
    created_at: 'now',
  };
  return [
    makeChain(ok(contact)),
    makeChain(ok(row)),
    makeChain(ok({ ...row, provider_id: 'telnyx_1', provider_status: 'sent' })),
    makeChain(ok(null)),
  ];
}

beforeEach(() => {
  vi.stubEnv('TELNYX_API_KEY', 'test-key');
  vi.stubEnv('TELNYX_NUMBER', '+14155550100');
  vi.stubEnv('SMS_ALLOWLIST', '*');
  vi.stubGlobal('fetch', vi.fn());
  mockedDesk.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockedDb.mockReset();
});

describe('an inbound text goes to Akme first', () => {
  it('sends what the desk decided, and shows it on the thread', async () => {
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Quote AK-00042. Total $1,689.60 plus tax.' });
    queueFrom(sendChains());
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ data: { id: 'telnyx_1' } }), { status: 200 }),
    );

    await smsEventDeps().reply(contact.phone, '40 cases of clear tape please', 42, false, 'Jane Doe', 'msg-1');

    expect(fromCalls()).toEqual(['contacts', 'messages', 'messages', 'outbox']);
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.text).toBe('Quote AK-00042. Total $1,689.60 plus tax.');
  });

  // The idempotency key. Akme hashes the order id from the party and this
  // value, so a Telnyx webhook retry lands on the order it already opened.
  it('carries the message row id through as the source', async () => {
    mockedDesk.mockResolvedValue({ kind: 'declined' });
    queueFrom([makeChain(ok(null))]);
    vi.stubEnv('NEAR_AI_API_KEY', 'k');
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }] }), { status: 200 }),
    );

    await smsEventDeps().reply(contact.phone, 'hello there', 42, false, 'Jane Doe', 'msg-77');

    expect(mockedDesk).toHaveBeenCalledWith({
      phone: contact.phone,
      body: 'hello there',
      displayName: 'Jane Doe',
      messageId: 'msg-77',
    });
  });

  it('never drafts over a desk that said nothing, but does raise it', async () => {
    // Silence used to be a normal outcome here: an over-ceiling quote and an
    // escalation both posted a card on Akme's side and said nothing to the
    // customer. As of 2026-08-20 Akme always answers a customer who wrote in,
    // so silence is now a DEFECT rather than a design, and a quiet `return`
    // hides it. That is exactly how a real customer got over an hour of nothing
    // on 2026-08-20 without anybody noticing.
    //
    // Still no draft: two brains writing over each other is the failure the
    // door exists to stop. The card is the alarm, not a second answer.
    mockedDesk.mockResolvedValue({ kind: 'silent' });
    queueFrom([makeChain(ok(null))]); // outbox insert: the alarm card

    await smsEventDeps().reply(contact.phone, '200 cases of tape', 42, false, 'Jane Doe', 'msg-2');

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(fromCalls()).toContain('outbox');
  });

  it('falls back to the old drafter when the desk declines', async () => {
    // `declined` is Akme saying it did nothing: not armed for sms, or nothing to
    // add. The path that has been answering since July is still the whole system
    // in that case, so a customer is never left with silence.
    mockedDesk.mockResolvedValue({ kind: 'declined' });
    queueFrom([makeChain(ok(null))]); // outbox insert: the draft card
    vi.stubEnv('NEAR_AI_API_KEY', 'k');
    vi.mocked(fetch).mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
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
          }),
          { status: 200 },
        ),
    );

    const inbound = 'I need forty cases of tape for a job next month, what would that run me';
    await smsEventDeps().reply(contact.phone, inbound, 42, false, 'Jane Doe', 'msg-3');

    expect(mockedDesk).toHaveBeenCalled();
    expect(fromCalls()).toEqual(['outbox']); // the old path drafted and posted a card
  });

  it('sends NOTHING and asks for eyes when the door did not answer', async () => {
    // The case that must not be folded into `declined`. Akme claims a quote send
    // before it returns the words, so a timeout may mean a quote is recorded as
    // sent that never left. A fallback draft on top of that is two prices to one
    // customer.
    mockedDesk.mockResolvedValue({ kind: 'unreachable', reason: 'Akme did not answer in 20s' });
    queueFrom([makeChain(ok(null))]); // outbox insert: the desk-down card

    await smsEventDeps().reply(contact.phone, '40 cases of tape', 42, false, 'Jane Doe', 'msg-4');

    expect(fromCalls()).toEqual(['outbox']);
    const inserted = fromMock.mock.results[0].value as { insert: ReturnType<typeof vi.fn> };
    expect(inserted.insert.mock.calls[0][0].payload.text).toContain('deskdown:');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('what never reaches the deal engine', () => {
  it('keeps carrier keywords out of it', async () => {
    // STOP is a command to the compliance machinery, not conversation. A row
    // reading "STOP" on a deal timeline reads as a customer saying it mid-order.
    for (const keyword of ['STOP', 'stop', 'START', 'HELP']) {
      mockedDesk.mockClear();
      queueFrom([makeChain(ok(null)), makeChain(ok(null))]);
      await smsEventDeps().reply(contact.phone, keyword, 42, false, 'Jane Doe', 'msg-5');
      expect(mockedDesk, keyword).not.toHaveBeenCalled();
    }
  });

  it('keeps attachments out of it', async () => {
    // The photo of the damaged pallet IS the message, and a text-only reader
    // answering it would be answering something it cannot see.
    queueFrom([makeChain(ok(null))]);
    await smsEventDeps().reply(contact.phone, 'see attached', 42, true, 'Jane Doe', 'msg-6');
    expect(mockedDesk).not.toHaveBeenCalled();
  });

  it('keeps an empty text out of it', async () => {
    queueFrom([makeChain(ok(null))]);
    await smsEventDeps().reply(contact.phone, '   ', 42, false, 'Jane Doe', 'msg-7');
    expect(mockedDesk).not.toHaveBeenCalled();
  });
});
