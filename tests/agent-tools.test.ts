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
}

function testDeps(opts: Options = {}) {
  const flow: CallFlow = {
    call_control_id: CALL_CONTROL_ID,
    call_id: 'call-1',
    stage: opts.stage ?? 'assistant',
    wave: null,
    recording_started: true,
  };
  const responders = opts.responders ?? [responder('r1')];
  const posted: { phone: string; text: string }[] = [];

  const dial = vi.fn(async () => ({
    call_control_id: 'leg-b1',
    call_leg_id: 'leg-b1',
    call_session_id: 'sess-1',
  }));

  const store = {
    activeAssistantCall: async () => (flow.stage === 'assistant' ? { ...flow } : null),
    activeResponders: async () => responders,
    advanceStage: async (_id: string, from: CallFlow['stage'][], to: CallFlow['stage'], patch?: Partial<CallFlow>) => {
      if (!from.includes(flow.stage)) return null;
      Object.assign(flow, { stage: to }, patch ?? {});
      return { ...flow };
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

  return { deps, dial, flow, posted, commands, texted, quotes };
}

describe('runTool: escalate_to_human', () => {
  it('rings the responders using the existing wave code, not a Telnyx transfer', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'wants a person' }, t.deps);

    expect(t.dial).toHaveBeenCalled();
    // We own no transfer command at all, deliberately: escalation is
    // dial-and-bridge through the ring group that is already under test.
    expect((t.commands as Record<string, unknown>).transfer).toBeUndefined();
    expect(t.flow.stage).toBe('ringing');
  });

  it('returns something for the agent to say while the phone rings', async () => {
    const t = testDeps();
    const out = await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'upset' }, t.deps);
    expect(out.speech).toMatch(/moment|connecting|one second/i);
  });

  it('takes a message instead when nobody is on the rota', async () => {
    const t = testDeps({ responders: [] });
    const out = await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'wants a person' }, t.deps);

    expect(t.dial).not.toHaveBeenCalled();
    expect(out.speech).toMatch(/team|message/i);
    expect(t.posted).toHaveLength(1);
  });

  it('is idempotent, because a retried tool call must not dial twice', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x' }, t.deps);
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x' }, t.deps);
    expect(t.dial).toHaveBeenCalledTimes(1);
  });

  it('does not dial when the call already left the assistant stage', async () => {
    const t = testDeps({ stage: 'bridged' });
    await runTool('escalate_to_human', { caller_phone: CALLER, reason: 'x' }, t.deps);
    expect(t.dial).not.toHaveBeenCalled();
  });

  it('tolerates a caller number the model reformatted', async () => {
    const t = testDeps();
    await runTool('escalate_to_human', { caller_phone: '(415) 555-0101', reason: 'x' }, t.deps);
    expect(t.dial).toHaveBeenCalled();
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
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 41250, due_date: null, status: 'open' },
    });
    const out = await runTool('lookup_invoice', { caller_phone: CALLER, invoice_number: '1043' }, t.deps);

    expect(out.speech).not.toMatch(/\$|dollar|41250|412\.50|412/);
    expect(out.speech).toMatch(/open/i);
  });

  it('calls a zero balance paid', async () => {
    const t = testDeps({
      invoice: { qbo_id: 'i1', doc_number: '1043', balance_cents: 0, due_date: null, status: 'paid' },
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
