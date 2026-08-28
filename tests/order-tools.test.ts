import { describe, expect, it, vi } from 'vitest';

/**
 * The three order tools, at the boundary a caller can actually push on.
 *
 * Two things are being defended here and neither is the arithmetic, which
 * tests/orders.test.ts already covers.
 *
 * THE NUMBER IS AN ARGUMENT. Telnyx sends no call identity with a tool call, so
 * `caller_phone` is whatever the model wrote. `price_order` mints a token that
 * later opens the SMS door, so it is gated at mint time; `send_order_link` is
 * gated again at send time. The tests below drive both gates with a number that
 * is not on the call and assert that nothing is saved, nothing is drafted and
 * nothing is sent.
 *
 * EVERY REFUSAL CARRIES ITS OWN NEXT MOVE. Each refusal path is exercised and
 * matched against the exact sentence in lib/orders/refusals.ts, so a future edit
 * that turns one back into a bare no fails here rather than on a phone call.
 */

import { runTool, type ToolDeps } from '../lib/agent/tools';
import { SEND_LINK_NEXT_MOVE } from '../lib/orders/refusals';
import { DID_NOT_CATCH, WHICH_PRODUCTS } from '../lib/orders/pricing';
import { LARGE_ORDER_CENTS, type PhoneOrderDraft } from '../lib/orders/drafts';
import { QUOTE_TTL_MS, type QuoteRow, type QuoteVerdict } from '../lib/orders/quotes';
import type { CallFlow, VoiceStore } from '../lib/telnyx/voice';
import type { ProductId } from '../lib/orders/catalog';

const CALLER = '+14155550101';
const STRANGER = '+15555550147';
const CALL_CONTROL_ID = 'leg-a';

interface Options {
  /** What QuickBooks says is on the shelf. Absent means plenty of everything. */
  stock?: Partial<Record<ProductId, number>>;
  /** Makes the stock read throw, the way a QuickBooks outage does. */
  stockFails?: boolean;
  /** What claimQuote answers. Default is a live quote for the caller. */
  claim?: QuoteVerdict;
  /** Makes the SMS send throw, the way a carrier rejection does. */
  smsFails?: boolean;
  /** Nothing is on the phone with us. */
  noCall?: boolean;
}

function testDeps(opts: Options = {}) {
  const flow: CallFlow = {
    call_control_id: CALL_CONTROL_ID,
    call_id: 'call-1',
    stage: 'assistant',
    wave: null,
    recording_started: true,
    telnyx_conversation_id: 'conv-1',
    escalation_offered_at: null,
  };

  const savedQuotes: Record<string, unknown>[] = [];
  const drafts: Record<string, unknown>[] = [];
  const texted: { phone: string; body: string }[] = [];
  const stockCalls: ProductId[][] = [];

  const store = {
    // Phone-aware, like the real one and like tests/agent-tools.test.ts: a mock
    // that ignored its argument would let every gate test pass against a gate
    // that does nothing.
    activeAssistantCall: async (phone: string) =>
      !opts.noCall && phone === CALLER ? { ...flow } : null,
  } as unknown as VoiceStore;

  const liveQuote: QuoteRow = {
    token: 'live-token',
    call_id: CALL_CONTROL_ID,
    caller_phone: CALLER,
    lines: [{ product: 'machine-film', units: 2 }],
    fulfilment: 'delivery',
    subtotal_cents: 8580,
    short_stock: [],
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + QUOTE_TTL_MS).toISOString(),
    used_at: null,
  };

  const deps = {
    store,
    sendText: async (phone: string, body: string) => {
      if (opts.smsFails) throw new Error('carrier rejected the message');
      texted.push({ phone, body });
    },
    stockFor: async (ids: ProductId[]) => {
      stockCalls.push(ids);
      if (opts.stockFails) throw new Error('QuickBooks is down');
      const out = {} as Record<ProductId, number>;
      for (const id of ids) out[id] = opts.stock?.[id] ?? 9999;
      return out;
    },
    saveQuote: async (input: Record<string, unknown>) => {
      savedQuotes.push(input);
      return { token: `quote-${savedQuotes.length}` };
    },
    claimQuote: async (): Promise<QuoteVerdict> => opts.claim ?? { ok: true, quote: liveQuote },
    createDraft: async (input: Record<string, unknown>) => {
      drafts.push(input);
      const subtotal = input.subtotalCents as number;
      return {
        id: `draft-${drafts.length}`,
        token: `draft-token-${drafts.length}`,
        large_order: subtotal >= LARGE_ORDER_CENTS,
        ...input,
      } as unknown as PhoneOrderDraft;
    },
    orderLink: (token: string) => `https://akmeusa.com/order/${token}`,
  } as unknown as ToolDeps;

  return { deps, savedQuotes, drafts, texted, stockCalls, liveQuote };
}

// ---------------------------------------------------------------------------
// price_products
// ---------------------------------------------------------------------------

describe('price_products', () => {
  it('prices only what was named (rule 2)', async () => {
    const t = testDeps();
    const out = await runTool('price_products', { products: ['tan-tape'] }, t.deps);
    expect(out.speech).toMatch(/tan hot melt tape is twenty-four dollars and forty-two cents a case/);
    expect(out.speech).not.toMatch(/newsprint|cushion|stretch film|hand wrap/);
  });

  it('reads the whole list when they asked for the whole list', async () => {
    const t = testDeps();
    const out = await runTool('price_products', {}, t.deps);
    for (const said of ['stretch film', 'hand wrap film', 'tan hot melt tape', 'clear carton', 'newsprint', 'bubble cushion']) {
      expect(out.speech).toContain(said);
    }
  });

  it('answers the half we sell and drops what the model invented', async () => {
    const t = testDeps();
    const out = await runTool('price_products', { products: ['tan-tape', 'pallet-jack'] }, t.deps);
    expect(out.speech).toMatch(/tan hot melt tape/);
    expect(out.speech).not.toMatch(/pallet.jack/i);
  });

  it('asks, with a next move in it, when none of them were ours', async () => {
    const t = testDeps();
    const out = await runTool('price_products', { products: ['forklift', 'coffee'] }, t.deps);
    expect(out.speech).toBe(WHICH_PRODUCTS);
    expect(out.speech).toMatch(/which/i);
  });

  it('says no total and no quantity, whatever it was asked (rule 3)', async () => {
    const t = testDeps();
    const out = await runTool('price_products', { products: ['machine-film', 'newsprint'] }, t.deps);
    expect(out.speech).not.toMatch(/total|comes out|altogether/i);
  });
});

// ---------------------------------------------------------------------------
// price_order
// ---------------------------------------------------------------------------

describe('price_order', () => {
  const order = {
    caller_phone: CALLER,
    lines: [{ product: 'machine-film', units: 10 }],
    fulfilment: 'delivery',
  };

  it('reads the line, says the subtotal, then offers the link (rules 4 and 5)', async () => {
    const t = testDeps();
    const out = await runTool('price_order', order, t.deps);
    expect(out.speech).toMatch(/four hundred twenty-nine dollars/);
    expect(out.speech).toMatch(/Would you like me to send you the confirmation link\?$/);
    expect(out.subtotalCents).toBe(42900);
    expect(out.quoteToken).toBe('quote-1');
  });

  it('stores the quote in integer cents, bound to the number on the call', async () => {
    const t = testDeps();
    await runTool('price_order', order, t.deps);
    expect(t.savedQuotes).toHaveLength(1);
    expect(t.savedQuotes[0]).toMatchObject({
      callerPhone: CALLER,
      callId: CALL_CONTROL_ID,
      fulfilment: 'delivery',
      subtotalCents: 42900,
    });
    expect(Number.isInteger(t.savedQuotes[0].subtotalCents as number)).toBe(true);
  });

  it('refuses a number that is not on this call, and mints nothing', async () => {
    const t = testDeps();
    const out = await runTool('price_order', { ...order, caller_phone: STRANGER }, t.deps);
    expect(out.speech).toMatch(/only pull that up for the number you are calling from/i);
    expect(out.quoteToken).toBeUndefined();
    expect(t.savedQuotes).toHaveLength(0);
  });

  it('never lets a caller-supplied product reach QuickBooks', async () => {
    const t = testDeps();
    const out = await runTool(
      'price_order',
      {
        caller_phone: CALLER,
        lines: [{ product: "'; select * from customers; --", units: 1 }],
        fulfilment: 'delivery',
      },
      t.deps,
    );
    expect(out.speech).toBe(DID_NOT_CATCH);
    // The gate is the enum, and it sits BEFORE the stock read. Nothing was asked
    // of QuickBooks at all, in any form.
    expect(t.stockCalls).toHaveLength(0);
    expect(t.savedQuotes).toHaveLength(0);
  });

  it('asks again when the quantities did not survive the call', async () => {
    const t = testDeps();
    for (const lines of [undefined, [], [{ product: 'machine-film', units: 0 }], 'ten boxes']) {
      const out = await runTool('price_order', { ...order, lines }, t.deps);
      expect(out.speech).toBe(DID_NOT_CATCH);
    }
    expect(t.savedQuotes).toHaveLength(0);
  });

  it('prices without a fulfilment, because the form is where that gets asked', async () => {
    // The 2026-08-27 rehearsal failure, pinned. Requiring fulfilment spent two
    // turns on "delivery or will call?" before the caller heard a number, and
    // that call never reached send_order_link. Fulfilment changes no number in
    // the subtotal and the order page collects it, so its absence must cost the
    // caller nothing at all.
    const t = testDeps();
    const { fulfilment: _dropped, ...noFulfilment } = order;
    const out = await runTool('price_order', noFulfilment, t.deps);

    expect(out.subtotalCents).toBe(42900);
    expect(out.speech).toMatch(/four hundred twenty-nine dollars/);
    expect(out.quoteToken).toBe('quote-1');
    expect(t.savedQuotes).toHaveLength(1);
    expect(t.savedQuotes[0]).toMatchObject({ fulfilment: null, subtotalCents: 42900 });

    // And it must not ask. No question about delivery, no hedge, nothing at all
    // between the caller and their price.
    expect(out.speech).not.toMatch(/will call|picking (?:it|that) up|delivered|deliver/i);
    expect(out.speech).toMatch(/Would you like me to send you the confirmation link\?$/);
  });

  it('reads an unrecognised fulfilment as nobody said, and still prices', async () => {
    // Failing closed means never guessing which one, not refusing to price. The
    // assistant schema documents the two words rather than enumerating them, so
    // a third value is reachable and has to land softly.
    const t = testDeps();
    const out = await runTool('price_order', { ...order, fulfilment: 'whenever' }, t.deps);
    expect(out.subtotalCents).toBe(42900);
    expect(out.quoteToken).toBe('quote-1');
    expect(t.savedQuotes[0]).toMatchObject({ fulfilment: null });
  });

  it('keeps a fulfilment the caller volunteered', async () => {
    const t = testDeps();
    await runTool('price_order', { ...order, fulfilment: 'will call' }, t.deps);
    expect(t.savedQuotes[0]).toMatchObject({ fulfilment: 'willcall' });
  });

  it('says what we have when we are short, and still prices what they asked for (rule 8)', async () => {
    const t = testDeps({ stock: { 'tan-tape': 12 } });
    const out = await runTool(
      'price_order',
      { caller_phone: CALLER, lines: [{ product: 'tan-tape', units: 20 }], fulfilment: 'willcall' },
      t.deps,
    );
    expect(out.speech).toMatch(/do not currently have twenty cases of the tan hot melt tape, we have twelve/i);
    expect(out.speech).toMatch(/four hundred eighty-eight dollars and forty cents/);
    expect(out.shortStock).toEqual([{ product: 'tan-tape', wanted: 20, available: 12 }]);
  });

  it('prices the order in full when the stock read fails, and says nothing about it', async () => {
    // A STOCK FAILURE IS SOFT, and this is the test that pins it.
    //
    // `stockFor` stopped being a local QuickBooks read on 2026-08-27: this repo
    // holds no QBO credentials, so it is now a network call to Akme, with
    // Akme's outages and Akme's latency. There is a caller on the line while
    // it runs. So a rejection must cost them nothing: the subtotal is still
    // correct, the quote token is still live, `shortStock` is empty, and the
    // agent simply never mentions stock, which the brief already handles.
    const t = testDeps({ stockFails: true });
    const out = await runTool('price_order', order, t.deps);

    // The number is right, and it is the same number a healthy stock read gives.
    expect(out.subtotalCents).toBe(42900);
    expect(out.speech).toMatch(/four hundred twenty-nine dollars/);

    // The token is live, so send_order_link works on the very next turn. A quote
    // that could not be spent would turn a stock outage into a lost order.
    expect(out.quoteToken).toBe('quote-1');
    expect(t.savedQuotes).toHaveLength(1);
    expect(t.savedQuotes[0]).toMatchObject({ subtotalCents: 42900, callerPhone: CALLER });

    // Nothing about stock, and nothing about a fault. The caller is not told
    // that a system they have never heard of is down.
    expect(out.shortStock).toEqual([]);
    expect(out.speech).not.toMatch(/stock|available|do not currently have|trouble|sorry|system/i);

    // And the turn still ends where every priced order ends.
    expect(out.speech).toMatch(/Would you like me to send you the confirmation link\?$/);
  });

  it('survives a stock rejection that is not an Error at all', async () => {
    // A network layer can reject with a string, an object, or undefined. The
    // catch must not care, because the caller is mid sentence either way.
    const t = testDeps();
    const deps = { ...t.deps, stockFor: async () => Promise.reject('gateway timeout') } as ToolDeps;
    const out = await runTool('price_order', order, deps);
    expect(out.subtotalCents).toBe(42900);
    expect(out.quoteToken).toBe('quote-1');
    expect(out.shortStock).toEqual([]);
  });

  it('sounds exactly the same at five thousand dollars (rule 9)', async () => {
    const t = testDeps();
    const out = await runTool(
      'price_order',
      { caller_phone: CALLER, lines: [{ product: 'machine-film', units: 200 }], fulfilment: 'delivery' },
      t.deps,
    );
    expect(out.subtotalCents).toBe(858000);
    expect(out.subtotalCents).toBeGreaterThanOrEqual(LARGE_ORDER_CENTS);
    expect(out.speech).not.toMatch(/large|approval|manager|check with|hold on/i);
    expect(out.speech).toMatch(/Would you like me to send you the confirmation link\?$/);
  });
});

// ---------------------------------------------------------------------------
// send_order_link: every refusal, and the one success
// ---------------------------------------------------------------------------

describe('send_order_link refuses with a next move', () => {
  it('refuses with nothing to send when no quote was priced', async () => {
    const t = testDeps();
    const out = await runTool('send_order_link', { caller_phone: CALLER }, t.deps);
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.no_token);
    expect(t.texted).toHaveLength(0);
    expect(t.drafts).toHaveLength(0);
  });

  it('refuses a number that is not on this call, and drafts nothing', async () => {
    const t = testDeps();
    const out = await runTool(
      'send_order_link',
      { caller_phone: STRANGER, quoteToken: 'live-token' },
      t.deps,
    );
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.not_this_caller);
    expect(t.texted).toHaveLength(0);
    expect(t.drafts).toHaveLength(0);
  });

  it('refuses a stale quote and says it will price it again', async () => {
    const t = testDeps({ claim: { ok: false, reason: 'expired' } });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'old-token' },
      t.deps,
    );
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.expired);
    expect(t.texted).toHaveLength(0);
  });

  it('refuses a second send on the same quote, and does not text twice', async () => {
    const t = testDeps({ claim: { ok: false, reason: 'used' } });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.already_used);
    expect(out.speech).toMatch(/already/i);
    expect(t.texted).toHaveLength(0);
  });

  it('says so when the carrier refuses the text', async () => {
    const t = testDeps({ smsFails: true });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.sms_failed);
    // The draft was already written, and it is left alone: it simply expires in
    // forty-eight hours. Releasing the spent quote would reopen the double text.
    expect(t.drafts).toHaveLength(1);
  });

  it('takes the snake case spelling too, so a schema convention cannot cost a caller their link', async () => {
    const t = testDeps();
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quote_token: 'live-token' },
      t.deps,
    );
    expect(out.speech).not.toBe(SEND_LINK_NEXT_MOVE.no_token);
    expect(t.texted).toHaveLength(1);
  });
});

describe('send_order_link, the send', () => {
  it('drafts the order and texts the link to the number on the call', async () => {
    const t = testDeps();
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );

    expect(t.drafts).toHaveLength(1);
    expect(t.drafts[0]).toMatchObject({
      callerPhone: CALLER,
      callId: CALL_CONTROL_ID,
      fulfilment: 'delivery',
      subtotalCents: 8580,
    });

    expect(t.texted).toHaveLength(1);
    expect(t.texted[0].phone).toBe(CALLER);
    expect(t.texted[0].body).toContain('https://akmeusa.com/order/draft-token-1');
    expect(t.texted[0].body).toMatch(/^Akme USA/);
    expect(out.speech).toMatch(/on your phone now/i);
  });

  it('writes a draft with a null fulfilment when nobody said on the call', async () => {
    // The other half of the same fix. A quote taken without a fulfilment is
    // still spendable, and the draft carries the null through, so Akme's order
    // page opens with neither option preselected and the customer picks there.
    const t = testDeps({
      claim: { ok: true, quote: { ...testDeps().liveQuote, fulfilment: null } },
    });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );

    expect(t.drafts).toHaveLength(1);
    expect(t.drafts[0]).toMatchObject({ fulfilment: null, subtotalCents: 8580, callerPhone: CALLER });
    expect(t.texted).toHaveLength(1);
    expect(t.texted[0].body).toContain('https://akmeusa.com/order/draft-token-1');
    expect(out.speech).toMatch(/on your phone now/i);
  });

  it('flags a five thousand dollar order on the record and says nothing about it', async () => {
    const t = testDeps({
      claim: {
        ok: true,
        quote: {
          ...testDeps().liveQuote,
          lines: [{ product: 'machine-film', units: 200 }],
          subtotal_cents: 858000,
        },
      },
    });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );
    expect(t.drafts[0].subtotalCents).toBe(858000);
    expect(out.speech).not.toMatch(/large|approval|manager|five thousand/i);
    expect(out.speech).toMatch(/on your phone now/i);
  });

  it('will not build a draft out of a quote row that no longer parses', async () => {
    const t = testDeps({
      claim: {
        ok: true,
        quote: { ...testDeps().liveQuote, lines: [{ product: 'not-a-product', units: 1 }] } as never,
      },
    });
    const out = await runTool(
      'send_order_link',
      { caller_phone: CALLER, quoteToken: 'live-token' },
      t.deps,
    );
    expect(out.speech).toBe(SEND_LINK_NEXT_MOVE.expired);
    expect(t.drafts).toHaveLength(0);
    expect(t.texted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The 24 hour nudge, in the worker sweep
// ---------------------------------------------------------------------------

const sweepRows = vi.hoisted(() => ({ due: [] as PhoneOrderDraft[], claimed: [] as string[], claimNull: false }));

vi.mock('../lib/orders/drafts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/orders/drafts')>();
  return {
    ...real,
    draftsDueForNudge: async () => sweepRows.due,
    claimNudge: async (draft: PhoneOrderDraft) => {
      if (sweepRows.claimNull) return null;
      sweepRows.claimed.push(draft.id);
      return { ...draft, nudged_at: new Date().toISOString() };
    },
  };
});

// Imported after the mock above is registered, which is what makes the sweep
// run against the two fake store calls rather than Supabase.
const { sweepOrderDrafts } = await import('../lib/worker/order-drafts');

describe('the single nudge, swept by the worker', () => {
  function overdue(id: string): PhoneOrderDraft {
    return {
      id,
      token: `tok-${id}`,
      call_id: 'call-1',
      caller_phone: CALLER,
      lines: [{ product: 'machine-film', units: 2 }],
      fulfilment: 'delivery',
      subtotal_cents: 8580,
      large_order: false,
      created_at: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expires_at: new Date(Date.now() + 23 * 60 * 60 * 1000).toISOString(),
      nudged_at: null,
      confirmed_at: null,
      order_reference: null,
    };
  }

  it('stamps the row and texts the link once', async () => {
    sweepRows.due = [overdue('d1')];
    sweepRows.claimed = [];
    sweepRows.claimNull = false;
    const sent: { phone: string; body: string }[] = [];

    const result = await sweepOrderDrafts(20, {
      sendText: async (phone, body) => {
        sent.push({ phone, body });
      },
      orderLink: (token) => `https://akmeusa.com/order/${token}`,
    });

    expect(result).toEqual({ nudged: 1, unsent: 0 });
    expect(sweepRows.claimed).toEqual(['d1']);
    expect(sent).toHaveLength(1);
    expect(sent[0].phone).toBe(CALLER);
    expect(sent[0].body).toContain('https://akmeusa.com/order/tok-d1');
    expect(sent[0].body).toMatch(/still waiting/i);
  });

  it('sends nothing when another tick already claimed the stamp', async () => {
    sweepRows.due = [overdue('d2')];
    sweepRows.claimed = [];
    sweepRows.claimNull = true;
    const sent: string[] = [];

    const result = await sweepOrderDrafts(20, {
      sendText: async (phone) => {
        sent.push(phone);
      },
      orderLink: (token) => `https://akmeusa.com/order/${token}`,
    });

    expect(result).toEqual({ nudged: 0, unsent: 0 });
    expect(sent).toEqual([]);
  });

  it('counts a failed send and never tries it again', async () => {
    sweepRows.due = [overdue('d3')];
    sweepRows.claimed = [];
    sweepRows.claimNull = false;

    const result = await sweepOrderDrafts(20, {
      sendText: async () => {
        throw new Error('carrier rejected the message');
      },
      orderLink: (token) => `https://akmeusa.com/order/${token}`,
    });

    // Stamped, so no later tick picks it up. One nudge means one, and a stamped
    // nudge that did not go out is the failure that rule chooses.
    expect(result).toEqual({ nudged: 1, unsent: 1 });
    expect(sweepRows.claimed).toEqual(['d3']);
  });
});
