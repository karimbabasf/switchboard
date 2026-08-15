import { describe, expect, it, vi } from 'vitest';
import { runTool, type ToolDeps } from '../lib/agent/tools';
import { renderTemplate } from '../lib/agent/templates';
import type { NewQuoteRequest, QuoteRequestRow } from '../lib/quote-requests';
import type { CallFlow, VoiceStore } from '../lib/telnyx/voice';
import type { TelnyxCommands } from '../lib/telnyx/client';
import type { OpenInvoice } from '../lib/qbo/lookup';
import type { AkmeOrder, Responder } from '../lib/types';

const CALLER = '+14155550101';
const CALL_CONTROL_ID = 'leg-a';

function responder(id: string, ring_order = 0): Responder {
  return { id, name: id, phone: '+14155550001', ring_order, active: true } as Responder;
}

interface Options {
  stage?: CallFlow['stage'];
  responders?: Responder[];
  invoice?: OpenInvoice | null;
  order?: AkmeOrder | null;
  customerId?: string | null;
  /** Makes the SMS send throw, the way a carrier rejection does. */
  smsFails?: boolean;
  /** An offer already on record, as an ISO string. Null means none was ever made. */
  offeredAt?: string | null;
}

function testDeps(opts: Options = {}) {
  const flow: CallFlow = {
    call_control_id: CALL_CONTROL_ID,
    call_id: 'call-1',
    stage: opts.stage ?? 'assistant',
    wave: null,
    recording_started: true,
    escalation_offered_at: opts.offeredAt ?? null,
  };
  const responders = opts.responders ?? [responder('r1')];
  const posted: { phone: string; text: string }[] = [];
  const offers: string[] = [];

  const dial = vi.fn(async () => ({
    call_control_id: 'leg-b1',
    call_leg_id: 'leg-b1',
    call_session_id: 'sess-1',
  }));

  const store = {
    // Phone-aware, like the real one: supabaseStore filters call_flow on
    // calls.contact_phone, so a number that is not on a live call finds nothing.
    // The tools rely on exactly that to refuse a number the model invented, and a
    // mock that ignored its argument would let every one of those tests pass
    // against a gate that does nothing.
    activeAssistantCall: async (phone: string) =>
      flow.stage === 'assistant' && phone === CALLER ? { ...flow } : null,
    activeResponders: async () => responders,
    advanceStage: async (_id: string, from: CallFlow['stage'][], to: CallFlow['stage'], patch?: Partial<CallFlow>) => {
      if (!from.includes(flow.stage)) return null;
      Object.assign(flow, { stage: to }, patch ?? {});
      return { ...flow };
    },
    // Writes the stamp the consent gate reads, so a test that offers and then
    // escalates goes through the same state the real call does.
    recordEscalationOffer: async (id: string) => {
      offers.push(id);
      flow.escalation_offered_at = new Date().toISOString();
    },
    addLeg: async () => {},
  } as unknown as VoiceStore;

  const commands = { dial } as unknown as TelnyxCommands;

  const texted: { phone: string; body: string }[] = [];
  const quotes: NewQuoteRequest[] = [];

  const deps: ToolDeps = {
    store,
    commands,
    findInvoice: async () => opts.invoice ?? null,
    identify: async () => ({
      phone: CALLER,
      display_name: 'Maria Delgado',
      customer_id: opts.customerId === undefined ? 'cus-1' : opts.customerId,
      customer: null,
    }),
    recentOrders: async () => (opts.order ? [opts.order] : []),
    postToTeam: async (phone, text) => {
      posted.push({ phone, text });
    },
    sendText: async (phone, body) => {
      if (opts.smsFails) throw new Error('carrier rejected the message');
      texted.push({ phone, body });
    },
    recordQuote: async (input) => {
      quotes.push(input);
      return { id: `qr-${quotes.length}`, ...input } as unknown as QuoteRequestRow;
    },
  };

  return { deps, dial, flow, posted, commands, texted, quotes, offers };
}

describe('runTool: escalate_to_human', () => {
  it('rings the responders using the existing wave code, not a Telnyx transfer', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'wants a person', trigger: 'asked' }, t.deps);

    expect(t.dial).toHaveBeenCalled();
    // We own no transfer command at all, deliberately: escalation is
    // dial-and-bridge through the ring group that is already under test.
    expect((t.commands as Record<string, unknown>).transfer).toBeUndefined();
    expect(t.flow.stage).toBe('ringing');
  });

  it('returns something for the agent to say while the phone rings', async () => {
    const t = testDeps();
    const out = await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'upset', trigger: 'asked' }, t.deps);
    expect(out.speech).toMatch(/moment|connecting|one second/i);
  });

  it('takes a message instead when nobody is on the rota', async () => {
    const t = testDeps({ responders: [] });
    const out = await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'wants a person', trigger: 'asked' }, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
    // It used to be allowed to say "the team". It says "we" now (Karim,
    // 2026-08-03), so what this asserts is that the caller is told their request
    // survived, which is the thing that actually mattered here.
    expect(out.speech).toMatch(/got this down|taken this down|message/i);
    expect(out.speech).toMatch(/\bwe\b/i);
    expect(t.posted).toHaveLength(1);
  });

  it('is idempotent, because a retried tool call must not dial twice', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x', trigger: 'asked' }, t.deps);
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x', trigger: 'asked' }, t.deps);
    expect(t.dial).toHaveBeenCalledTimes(1);
  });

  it('does not dial when the call already left the assistant stage', async () => {
    const t = testDeps({ stage: 'bridged' });
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x', trigger: 'asked' }, t.deps);
    expect(t.dial).not.toHaveBeenCalled();
  });

  it('tolerates a caller number the model reformatted', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: '(415) 555-0101', reason: 'x', trigger: 'asked' }, t.deps);
    expect(t.dial).toHaveBeenCalled();
  });
});

/**
 * The 2026-08-15 defect, in tests.
 *
 * A caller said a delivery arrived damaged. The agent said "I can put you
 * through to someone on our team, would you like that? One moment, I'm
 * connecting you now" as one sentence and dialled. The caller never got the turn
 * the question implied. What follows pins the rule that came out of it: a dial
 * needs consent, and the server checks for it rather than believing the model.
 */
describe('escalation needs the caller to agree', () => {
  const UPSET = { caller_phone: CALLER, reason: 'damaged delivery' };

  it('does not dial on the agent own judgment, and asks instead', async () => {
    const t = testDeps();
    const out = await runTool('escalate_to_human', { ...UPSET, trigger: 'accepted' }, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
    expect(t.flow.stage).toBe('assistant');
    expect(out.speech).toMatch(/would you like/i);
  });

  it('refuses a missing trigger the same way, because an omission is not consent', async () => {
    const t = testDeps();
    const out = await runTool('escalate_to_human', UPSET, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
    expect(out.speech).toMatch(/would you like/i);
  });

  it('refuses a trigger it does not recognise, so a future prompt cannot fail open', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { ...UPSET, trigger: 'ASKED!' }, t.deps);
    expect(t.dial).not.toHaveBeenCalled();
  });

  it('records the offer it was forced to make, so the next yes works', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { ...UPSET, trigger: 'accepted' }, t.deps);
    expect(t.offers).toEqual([CALL_CONTROL_ID]);
  });

  it('dials once the offer is old enough to have been answered', async () => {
    const t = testDeps({ offeredAt: new Date(Date.now() - 10_000).toISOString() });
    await runTool('escalate_to_human', { ...UPSET, trigger: 'accepted' }, t.deps);

    expect(t.dial).toHaveBeenCalled();
    expect(t.flow.stage).toBe('ringing');
  });

  it('will not accept an offer made in the same breath, which is the actual bug', async () => {
    const t = testDeps();
    // offer_human then escalate_to_human with no caller turn in between: exactly
    // what one model turn emitting both looks like from the server side.
    await runTool('offer_human', UPSET, t.deps);
    await runTool('escalate_to_human', { ...UPSET, trigger: 'accepted' }, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
  });

  it('lets a direct ask through with no offer on record', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { ...UPSET, trigger: 'asked' }, t.deps);
    expect(t.dial).toHaveBeenCalled();
  });
});

describe('runTool: offer_human', () => {
  it('asks, and never dials', async () => {
    const t = testDeps();
    const out = await runTool('offer_human', { caller_phone: CALLER, reason: 'upset' }, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
    expect(t.flow.stage).toBe('assistant');
    expect(out.speech).toMatch(/would you like/i);
    expect(out.speech).toMatch(/someone on our team/i);
  });

  it('stamps the call, which is what makes a later yes believable', async () => {
    const t = testDeps();
    await runTool('offer_human', { caller_phone: CALLER, reason: 'upset' }, t.deps);
    expect(t.offers).toEqual([CALL_CONTROL_ID]);
  });

  it('still asks when the stamp cannot be written, because the question is what the caller needs', async () => {
    const t = testDeps();
    (t.deps.store as unknown as { recordEscalationOffer: () => Promise<void> }).recordEscalationOffer = async () => {
      throw new Error('postgres is down');
    };
    const out = await runTool('offer_human', { caller_phone: CALLER, reason: 'upset' }, t.deps);
    expect(out.speech).toMatch(/would you like/i);
  });
});

describe('runTool: lookup_invoice', () => {
  it('says it cannot find it rather than inventing a status', async () => {
    const t = testDeps({ invoice: null });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '9999' }, t.deps);

    expect(out.speech).toMatch(/cannot find|do not see|no record/i);
    expect(out.speech).not.toMatch(/\bpaid\b|\bunpaid\b|\bopen\b/i);
  });

  it('never returns a dollar amount, because the agent may not quote prices', async () => {
    const t = testDeps({
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 41250, due_date: null, status: 'open', customer_id: 'cus-1' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, t.deps);

    expect(out.speech).not.toMatch(/\$|dollar|41250|412\.50|412/);
    expect(out.speech).toMatch(/open/i);
  });

  it('calls a zero balance paid', async () => {
    const t = testDeps({
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 0, due_date: null, status: 'paid', customer_id: 'cus-1' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, t.deps);
    expect(out.speech).toMatch(/paid/i);
  });
});

describe('runTool: check_order and take_message', () => {
  it('describes the recent order without saying what it cost', async () => {
    const t = testDeps({
      order: {
        id: 'o1',
        customer_id: 'cus-1',
        seq: 41,
        reference: 'AK-1041',
        status: 'confirmed',
        need_by: '2026-07-30',
        total_cents: 41250,
        created_at: '2026-07-25T10:00:00.000Z',
      },
    });
    const out = await runTool('check_order', { caller_phone: CALLER }, t.deps);

    expect(out.speech).toContain('AK-1041');
    expect(out.speech).not.toMatch(/\$|dollar|412/);
  });

  it('does not invent an order for a number with no account', async () => {
    const t = testDeps({ customerId: null });
    const out = await runTool('check_order', { caller_phone: CALLER }, t.deps);
    expect(out.speech).toMatch(/do not see an account/i);
  });

  it('puts the message in front of a human and reads the callback number back', async () => {
    const t = testDeps();
    const out = await runTool(
      'take_message',
      { caller_phone: CALLER, message: 'Needs a pallet of hand wrap Thursday', callback_number: '+14155550188' },
      t.deps,
    );

    expect(t.posted).toHaveLength(1);
    expect(t.posted[0].text).toContain('Needs a pallet of hand wrap Thursday');
    expect(out.speech).toContain('+14155550188');
  });

  it('asks again rather than filing an empty message', async () => {
    const t = testDeps();
    const out = await runTool('take_message', { caller_phone: CALLER, message: '', callback_number: '' }, t.deps);
    expect(t.posted).toHaveLength(0);
    expect(out.speech).toMatch(/\?$/);
  });

  it('files a pricing message on the quote queue as well as in the topic', async () => {
    const t = testDeps();
    await runTool(
      'take_message',
      { caller_phone: CALLER, message: 'How much is a pallet of hand wrap', callback_number: CALLER, caller_name: 'Maria' },
      t.deps,
    );

    // A pricing question left only as a sentence in one contact's thread is
    // invisible to anyone working the queue.
    expect(t.posted).toHaveLength(1);
    expect(t.quotes).toEqual([
      { phone: CALLER, source: 'call', wants: 'How much is a pallet of hand wrap', callerName: 'Maria' },
    ]);
  });

  it('does not turn every message into a quote request', async () => {
    const t = testDeps();
    await runTool(
      'take_message',
      { caller_phone: CALLER, message: 'Please call me back about the damaged pallet', callback_number: CALLER },
      t.deps,
    );

    expect(t.posted).toHaveLength(1);
    expect(t.quotes).toHaveLength(0);
  });
});

describe('runTool: text_me_the_list', () => {
  it('sends the reviewed catalogue template, never a second copy of the list', async () => {
    const t = testDeps();
    await runTool('text_me_the_list', { caller_phone: CALLER, wants: 'tape and hand wrap' }, t.deps);

    // Byte for byte the template. The last time this codebase kept its own copy
    // of the product list it named four products Akme does not sell.
    expect(t.texted).toEqual([{ phone: CALLER, body: renderTemplate('catalogue') }]);
  });

  it('records the quote request, which is the thing a human actually works from', async () => {
    const t = testDeps();
    await runTool(
      'text_me_the_list',
      { caller_phone: CALLER, wants: 'a pallet of machine wrap', caller_name: 'Maria' },
      t.deps,
    );

    expect(t.quotes).toEqual([
      { phone: CALLER, source: 'call', wants: 'a pallet of machine wrap', callerName: 'Maria' },
    ]);
  });

  it('quotes no price and sends no quote, because the agent may do neither', async () => {
    const t = testDeps();
    const out = await runTool('text_me_the_list', { caller_phone: CALLER, wants: 'pricing' }, t.deps);

    expect(t.texted[0].body).not.toMatch(/\$|\bper case\b.*\d|\d+\.\d\d/);
    expect(out.speech).not.toMatch(/\$|quote is|here is your quote/i);
  });

  it('gives the agent one sentence to say, not a JSON blob to narrate', async () => {
    const t = testDeps();
    const out = await runTool('text_me_the_list', { caller_phone: CALLER, wants: 'the list' }, t.deps);

    expect(Object.keys(out)).toEqual(['speech']);
    expect(out.speech).not.toMatch(/[{}[\]"]|:\s/);
    expect(out.speech.split(/[.?!]/).filter((s) => s.trim()).length).toBeLessThanOrEqual(2);
  });

  it('still records the request when the text will not go through', async () => {
    const t = testDeps({ smsFails: true });
    const out = await runTool('text_me_the_list', { caller_phone: CALLER, wants: 'the list' }, t.deps);

    // A carrier rejection must not lose the customer. The request is the product.
    expect(t.texted).toHaveLength(0);
    expect(t.quotes).toHaveLength(1);
    expect(out.speech).toMatch(/not go through|team/i);
  });

  it('asks for a number rather than texting nowhere', async () => {
    const t = testDeps();
    const out = await runTool('text_me_the_list', { caller_phone: 'unknown', wants: 'the list' }, t.deps);

    expect(t.texted).toHaveLength(0);
    expect(t.quotes).toHaveLength(0);
    expect(out.speech).toMatch(/\?$/);
  });

  it('defaults wants rather than filing an empty request the queue cannot read', async () => {
    const t = testDeps();
    await runTool('text_me_the_list', { caller_phone: CALLER }, t.deps);
    // recordQuoteRequest throws on an empty `wants`, and that throw would land
    // mid-sentence on a live call.
    expect(t.quotes[0].wants).toBeTruthy();
  });
});

/**
 * The tools against a caller who is trying it on.
 *
 * `caller_phone` is an argument, so the model writes it, so the prompt is the
 * only thing telling it to write the real one. These tests are what say the
 * prompt is not the only thing: they call every tool with a number that is not on
 * the call, the way a caller who says "check my colleague's order on 555 555
 * 0147" would get it filled in, and require the tool to do nothing.
 *
 * Karim, 2026-08-03: make sure the agent is not vulnerable to prompt injection
 * exposing anything sensitive it has access to. A rule in the prompt is a request
 * to a model. This is the part that holds when the request is ignored.
 */
describe('runTool: a number that is not on this call', () => {
  const SOMEBODY_ELSE = '+15555550147';

  it('will not look up an order for it', async () => {
    const t = testDeps({
      order: {
        id: 'o1',
        customer_id: 'cus-1',
        seq: 41,
        reference: 'AK-1041',
        status: 'confirmed',
        need_by: '2026-07-30',
        total_cents: 41250,
        created_at: '2026-07-25T10:00:00.000Z',
      },
    });
    const out = await runTool('check_order', { caller_phone: SOMEBODY_ELSE }, t.deps);

    expect(out.speech).toMatch(/only pull that up for the number you are calling from/i);
    expect(out.speech).not.toContain('AK-1041');
  });

  it('will not text it, which would be our 10DLC number messaging a stranger', async () => {
    const t = testDeps();
    const out = await runTool(
      'text_me_the_list',
      { caller_phone: SOMEBODY_ELSE, wants: 'the full product list' },
      t.deps,
    );

    expect(t.texted).toHaveLength(0);
    expect(t.quotes).toHaveLength(0);
    expect(out.speech).toMatch(/only pull that up for the number you are calling from/i);
  });

  it('will not file a message under it, which would rename somebody else', async () => {
    const t = testDeps();
    const out = await runTool(
      'take_message',
      { caller_phone: SOMEBODY_ELSE, message: 'call me back', callback_number: SOMEBODY_ELSE, caller_name: 'Dave' },
      t.deps,
    );

    expect(t.posted).toHaveLength(0);
    expect(out.speech).toMatch(/only pull that up for the number you are calling from/i);
  });

  it('will not look up an invoice for it', async () => {
    const t = testDeps({
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 0, due_date: null, status: 'paid', customer_id: 'cus-1' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: SOMEBODY_ELSE, invoice_number: '1043' }, t.deps);

    expect(out.speech).not.toMatch(/\bpaid\b|\bopen\b/i);
  });

  it('still lets the caller leave a different callback number, which is not a lookup', async () => {
    // The gate is on the identity, not on every number in the argument list. A
    // caller ringing from the office who wants a call back on their mobile is the
    // normal case and must keep working.
    const t = testDeps();
    const out = await runTool(
      'take_message',
      { caller_phone: CALLER, message: 'needs a call about a pallet', callback_number: SOMEBODY_ELSE },
      t.deps,
    );

    expect(t.posted).toHaveLength(1);
    expect(t.posted[0].text).toContain(SOMEBODY_ELSE);
    expect(out.speech).toContain(SOMEBODY_ELSE);
  });
});

describe('runTool: lookup_invoice belongs to the caller or to nobody', () => {
  it('will not read out an invoice that is on another account', async () => {
    const t = testDeps({
      invoice: { qbo_id: 'i9', doc_number: '1043', balance_cents: 41250, due_date: '2026-08-30', status: 'open', customer_id: 'cus-OTHER' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, t.deps);

    expect(out.speech).not.toMatch(/\bpaid\b|\bopen\b/i);
    expect(out.speech).not.toContain('2026-08-30');
  });

  it('says the same thing whether the invoice is missing or is somebody else\'s', async () => {
    // Two different sentences would answer "does invoice 1043 exist" for free,
    // and an invoice number is four digits anybody can count up to.
    const missing = testDeps({ invoice: null });
    const theirs = testDeps({
      invoice: { qbo_id: 'i9', doc_number: '1043', balance_cents: 41250, due_date: null, status: 'open', customer_id: 'cus-OTHER' },
    });

    const a = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, missing.deps);
    const b = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, theirs.deps);

    expect(a.speech).toBe(b.speech);
  });

  it('says it cannot find it when the caller has no account at all', async () => {
    const t = testDeps({
      customerId: null,
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 0, due_date: null, status: 'paid', customer_id: 'cus-1' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, t.deps);
    expect(out.speech).not.toMatch(/\bpaid\b/i);
  });
});
