import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The door between a customer's text and Akme, and the whole of the reply path.
 *
 * Before this existed, every inbound text ran this repo's own SMS agent, which
 * drafted a reply and put a Send button in Telegram. That is the ping Karim got
 * on 2026-08-19 when he texted the business asking to order: nothing was wrong,
 * the text had simply never been wired to the engine that knows about orders.
 *
 * What these tests pin now is that there is ONE WRITER. Every sentence a
 * customer reads was written in Akme, by the deal engine or by the desk, and
 * the only words this repo still owns are the carrier's: the registered HELP
 * reply. The four desk outcomes are the whole of the path, and the two that are
 * easy to collapse into one are the reason the type has four cases: the desk
 * saying "I did nothing" (safe, and it now hands over its own holding line) and
 * the desk not answering at all (NOT safe, because it may have recorded a quote
 * as sent one millisecond after the socket closed).
 */
function makeChain(result: { data: unknown; error: { message: string; code?: string } | null }) {
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.select = vi.fn(self);
  chain.eq = vi.fn(self);
  chain.is = vi.fn(self);
  chain.not = vi.fn(self);
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
  deskDeclinedCard: vi.fn((input: { reason: string | null; reply: string | null }) => ({
    text: `declined:${input.reason}${input.reply ? '' : ':unsent'}`,
  })),
  deskSilentCard: vi.fn(() => ({ text: 'silent' })),
  deskDownCard: vi.fn((input: { reason: string }) => ({ text: `deskdown:${input.reason}` })),
  smsBlockedCard: vi.fn((input: { reason: string }) => ({ text: `blocked:${input.reason}` })),
  smsSendFailedCard: vi.fn((input: { reason: string }) => ({ text: `sendfailed:${input.reason}` })),
  attachmentOnlyCard: vi.fn(() => ({ text: 'attachment' })),
  orderChangeCard: vi.fn(async () => ({ text: 'orderchange' })),
}));
vi.mock('../lib/crm/timeline', () => ({
  noteInboundSms: vi.fn(async () => {}),
  noteOutboundSms: vi.fn(async () => {}),
}));
vi.mock('../lib/akme/desk', () => ({ askAkmeDesk: vi.fn() }));

import { db } from '../lib/db';
import { askAkmeDesk } from '../lib/akme/desk';
import { noteOutboundSms } from '../lib/crm/timeline';

import { smsEventDeps } from '../lib/telnyx/sms';
import { renderTemplate } from '../lib/agent/templates';

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

/** Every payload that reached the outbox, in order, whatever table came first. */
function outboxCards(): { text: string }[] {
  const out: { text: string }[] = [];
  fromMock.mock.calls.forEach((call, i) => {
    if (call[0] !== 'outbox') return;
    const chain = fromMock.mock.results[i].value as { insert: ReturnType<typeof vi.fn> };
    const row = chain.insert.mock.calls[0]?.[0] as { payload?: { text: string } } | undefined;
    if (row?.payload) out.push(row.payload);
  });
  return out;
}

/** The text Telnyx was asked to put on the wire, or null if it never was. */
function sentText(): string | null {
  const call = vi.mocked(fetch).mock.calls[0];
  if (!call) return null;
  return (JSON.parse(call[1]?.body as string) as { text: string }).text;
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

function telnyxAccepts() {
  vi.mocked(fetch).mockImplementation(
    async () => new Response(JSON.stringify({ data: { id: 'telnyx_1' } }), { status: 200 }),
  );
}

beforeEach(() => {
  vi.stubEnv('TELNYX_API_KEY', 'test-key');
  vi.stubEnv('TELNYX_NUMBER', '+14155550100');
  vi.stubEnv('SMS_ALLOWLIST', '*');
  vi.stubGlobal('fetch', vi.fn());
  mockedDesk.mockReset();
  vi.mocked(noteOutboundSms).mockClear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  mockedDb.mockReset();
});

describe('the four desk outcomes are the whole of the reply path', () => {
  it("sends the desk's words and writes nothing of its own", async () => {
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Hi, that is $24.42 a case. How many do you need?' });
    queueFrom(sendChains());
    telnyxAccepts();

    await smsEventDeps().reply(contact.phone, 'how much is the tape', 42, false, 'Jane Doe', 'msg-1');

    expect(fromCalls()).toEqual(['contacts', 'messages', 'messages', 'outbox']);
    expect(sentText()).toBe('Hi, that is $24.42 a case. How many do you need?');
  });

  it('sends the holding line Akme wrote on a decline, and never one of its own', async () => {
    mockedDesk.mockResolvedValue({
      kind: 'declined',
      reason: 'desk_wrote_nothing',
      reply: 'Hi, a person is picking this up now.',
    });
    queueFrom(sendChains());
    telnyxAccepts();

    await smsEventDeps().reply(contact.phone, 'anything', 42, false, 'Jane Doe', 'msg-2');

    expect(sentText()).toBe('Hi, a person is picking this up now.');
    expect(outboxCards()).toEqual([{ text: 'declined:desk_wrote_nothing' }]);
  });

  /**
   * A decline with no words is nobody waiting: the channel is simply not armed.
   *
   * This is the case that used to fall through to draftSmsReply, and it is where
   * "the team will price it" came from. There is no drafter left to fall through
   * to, so the assertion is the strongest available: nothing went on the wire.
   */
  it('sends nothing when a decline carries no words, and raises it instead', async () => {
    mockedDesk.mockResolvedValue({ kind: 'declined', reason: 'channel_not_armed', reply: null });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'what are your hours', 42, false, 'Jane Doe', 'msg-3');

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(outboxCards()).toEqual([{ text: 'declined:channel_not_armed:unsent' }]);
  });

  it('never drafts over a desk that said nothing, but does raise it', async () => {
    // Silence used to be a normal outcome here: an over-ceiling quote and an
    // escalation both posted a card on Akme's side and said nothing to the
    // customer. As of 2026-08-20 Akme always answers a customer who wrote in,
    // so silence is now a DEFECT rather than a design, and a quiet `return`
    // hides it. That is exactly how a real customer got over an hour of nothing
    // on 2026-08-20 without anybody noticing.
    mockedDesk.mockResolvedValue({ kind: 'silent' });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, '200 cases of tape', 42, false, 'Jane Doe', 'msg-4');

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(outboxCards()).toEqual([{ text: 'silent' }]);
  });

  it('stays silent and posts a card when the door is unreachable', async () => {
    // The case that must not be folded into `declined`. Akme claims a quote send
    // before it returns the words, so a timeout may mean a quote is recorded as
    // sent that never left. A second answer on top of that is two prices to one
    // customer.
    mockedDesk.mockResolvedValue({ kind: 'unreachable', reason: 'Akme did not answer in 20s' });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, '40 cases of tape', 42, false, 'Jane Doe', 'msg-5');

    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(outboxCards()).toEqual([{ text: 'deskdown:Akme did not answer in 20s' }]);
  });

  // The idempotency key. Akme hashes the order id from the party and this
  // value, so a Telnyx webhook retry lands on the order it already opened.
  it('carries the message row id through as the source', async () => {
    mockedDesk.mockResolvedValue({ kind: 'declined', reason: null, reply: null });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'hello there', 42, false, 'Jane Doe', 'msg-77');

    expect(mockedDesk).toHaveBeenCalledWith({
      phone: contact.phone,
      body: 'hello there',
      displayName: 'Jane Doe',
      messageId: 'msg-77',
      attachments: 0,
    });
  });

  it('tells Akme an attachment exists rather than answering around it', async () => {
    mockedDesk.mockResolvedValue({ kind: 'declined', reason: null, reply: null });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'is this the right one', 42, true, null, 'msg-6');

    expect(mockedDesk.mock.calls[0][0]).toMatchObject({ attachments: 1 });
  });

  /**
   * The deterministic bargaining stop stays HERE and its sentence does not.
   *
   * Karim's rule is zero tolerance, and a detector that has to survive a model
   * call is not a stop. What moved is the answer: this repo reports what it saw
   * and Akme writes the line, so a customer opening a negotiation gets one
   * voice rather than two.
   */
  it('reports bargaining as a hint instead of answering it', async () => {
    mockedDesk.mockResolvedValue({ kind: 'declined', reason: null, reply: null });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, "what's your best price on tape", 42, false, null, 'msg-7');

    expect(mockedDesk.mock.calls[0][0]).toMatchObject({ hint: 'bargaining' });
  });
});

describe('the carrier machinery still answers itself', () => {
  it('answers HELP itself, without asking Akme', async () => {
    queueFrom(sendChains());
    telnyxAccepts();

    await smsEventDeps().reply(contact.phone, 'HELP', 42, false, 'Jane Doe', 'msg-8');

    expect(mockedDesk).not.toHaveBeenCalled();
    expect(sentText()).toBe(renderTemplate('help'));
  });

  it('still stamps an opt-out and sends nothing', async () => {
    const contacts = makeChain(ok(null));
    queueFrom([contacts]);

    await smsEventDeps().reply(contact.phone, 'STOP', 42, false, 'Jane Doe', 'msg-9');

    expect(fromCalls()).toEqual(['contacts']);
    expect(contacts.update).toHaveBeenCalledWith(expect.objectContaining({ opted_out_at: expect.any(String) }));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(mockedDesk).not.toHaveBeenCalled();
  });

  // Without this the door stays shut forever and the customer has no way back in
  // short of somebody editing the database by hand.
  it('clears the stamp on an opt-in and sends nothing', async () => {
    const contacts = makeChain(ok(null));
    queueFrom([contacts]);

    await smsEventDeps().reply(contact.phone, 'START', 42, false, 'Jane Doe', 'msg-10');

    expect(contacts.update).toHaveBeenCalledWith({ opted_out_at: null });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('keeps every carrier keyword off the desk', async () => {
    // STOP is a command to the compliance machinery, not conversation. A row
    // reading "STOP" on a deal timeline reads as a customer saying it mid-order.
    for (const keyword of ['STOP', 'stop', 'START', 'HELP']) {
      mockedDesk.mockClear();
      queueFrom(sendChains());
      telnyxAccepts();
      await smsEventDeps().reply(contact.phone, keyword, 42, false, 'Jane Doe', 'msg-11');
      expect(mockedDesk, keyword).not.toHaveBeenCalled();
    }
  });
});

describe('what never reaches the deal engine', () => {
  /**
   * A photo with no words is a damaged pallet or a purchase order, and it needs
   * a person's eyes. Nothing here can read it, so nothing here may answer it,
   * and the card is what stops that silence being invisible.
   */
  it('gives an attachment with no words to a person, not to the desk', async () => {
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, '   ', 42, true, 'Jane Doe', 'msg-12');

    expect(mockedDesk).not.toHaveBeenCalled();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(outboxCards()).toEqual([{ text: 'attachment' }]);
  });

  it('keeps an empty text with no attachment out of it', async () => {
    queueFrom([makeChain(ok(null))]);
    await smsEventDeps().reply(contact.phone, '   ', 42, false, 'Jane Doe', 'msg-13');
    expect(mockedDesk).not.toHaveBeenCalled();
    expect(fromCalls()).toEqual([]);
  });
});


/**
 * SMS_ALLOWLIST is enforced here, at the door, and Akme deliberately holds no
 * copy of it (decision 3 of the 2026-08-24 plan: the gate belongs where every
 * caller passes, and a second copy in Akme is drift this repo has paid for
 * once). So Akme's turn can report a clean send for a number this repo then
 * refuses. That used to land in a console.error inside a catch that swallowed
 * everything, and by the time it happens the desk has spent a model call and may
 * have claimed a quote against the order, so the refusal has to be visible.
 */
describe('a text the allowlist refuses is said out loud', () => {
  it("posts a card when the allowlist blocks the desk's reply", async () => {
    vi.stubEnv('SMS_ALLOWLIST', '+15550000000');
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Hi, that is $24.42 a case.' });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'how much', 42, false, 'Jane Doe', 'msg-14');

    // The blocked card and nothing else: an auto-sent card here would claim a
    // customer received a message that never left.
    expect(outboxCards()).toEqual([{ text: `blocked:${contact.phone} is not on SMS_ALLOWLIST` }]);
  });

  it('says a decline was blocked too, rather than reporting it as sent', async () => {
    vi.stubEnv('SMS_ALLOWLIST', '+15550000000');
    mockedDesk.mockResolvedValue({
      kind: 'declined',
      reason: 'desk_wrote_nothing',
      reply: 'Hi, a person is picking this up now.',
    });
    queueFrom([makeChain(ok(null)), makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'anything', 42, false, 'Jane Doe', 'msg-15');

    expect(outboxCards()).toEqual([
      { text: `blocked:${contact.phone} is not on SMS_ALLOWLIST` },
      { text: 'declined:desk_wrote_nothing:unsent' },
    ]);
  });

  // Nothing anywhere may claim a customer received a message that Telnyx never
  // accepted. Akme writes no outbound row on a live hand-back, and the door
  // writes one only after a send succeeds, so a block leaves the timeline
  // correctly empty rather than showing an answer nobody got.
  it('leaves no outbound timeline row when the send was blocked', async () => {
    vi.stubEnv('SMS_ALLOWLIST', '+15550000000');
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Hi, that is $24.42 a case.' });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'how much', 42, false, 'Jane Doe', 'msg-16');

    expect(vi.mocked(noteOutboundSms)).not.toHaveBeenCalled();
  });

  // A carrier failure still costs the automatic reply and not the message: the
  // inbound text is already filed and already in Telegram, so this never
  // rethrows and Telnyx is never asked to redeliver. What changed on
  // 2026-08-24 is that it no longer costs the reply SILENTLY. The throw used to
  // land in replyWithAgent's outer catch, a bare console.error, so a Telnyx 500
  // meant nothing sent, no card, no timeline row, and nobody told, while Akme
  // had already recorded the quote as sent.
  it('swallows a send that failed for any other reason, and posts a card about it', async () => {
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Hi, that is $24.42 a case.' });
    queueFrom(sendChains());
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNRESET'));

    await expect(
      smsEventDeps().reply(contact.phone, 'how much', 42, false, 'Jane Doe', 'msg-17'),
    ).resolves.toBeUndefined();
    // The failure card and nothing else. An auto-sent card beside it would
    // claim a customer read something the carrier never accepted.
    expect(outboxCards()).toEqual([{ text: 'sendfailed:ECONNRESET' }]);
    expect(vi.mocked(noteOutboundSms)).not.toHaveBeenCalled();
  });

  // A carrier refusal and this repo's own door refusing are different problems:
  // one is fixed by resending, the other by a config line. Two cards, because a
  // reader who cannot tell them apart looks in the wrong place first.
  it('keeps the carrier failure and the allowlist refusal on separate cards', async () => {
    vi.stubEnv('SMS_ALLOWLIST', '+15550000000');
    mockedDesk.mockResolvedValue({ kind: 'answer', reply: 'Hi, that is $24.42 a case.' });
    queueFrom([makeChain(ok(null))]);

    await smsEventDeps().reply(contact.phone, 'how much', 42, false, 'Jane Doe', 'msg-18');

    expect(outboxCards()).toEqual([{ text: `blocked:${contact.phone} is not on SMS_ALLOWLIST` }]);
  });

  // The decline path posts its own card AFTER the send, so a rethrow here used
  // to cost that card too: the operator lost both the reason Akme declined and
  // the fact that its holding line never left.
  it('keeps the declined card when the holding line fails at the carrier', async () => {
    mockedDesk.mockResolvedValue({
      kind: 'declined',
      reason: 'desk_wrote_nothing',
      reply: 'Hi, a person is picking this up now.',
    });
    queueFrom([...sendChains(), makeChain(ok(null))]);
    vi.mocked(fetch).mockRejectedValue(new Error('telnyx /messages: 500 internal error'));

    await smsEventDeps().reply(contact.phone, 'anything', 42, false, 'Jane Doe', 'msg-19');

    expect(outboxCards()).toEqual([
      { text: 'sendfailed:telnyx /messages: 500 internal error' },
      { text: 'declined:desk_wrote_nothing:unsent' },
    ]);
  });
});
