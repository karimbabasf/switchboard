import { beforeEach, describe, expect, it } from 'vitest';
import {
  callerContext,
  clearCallerContextCache,
  prewarmCallerContext,
  type ContextDeps,
} from '../lib/agent/context';
import type { CallerIdentity } from '../lib/qbo/lookup';
import type { AkmeOrder } from '../lib/types';

function deps(identity: CallerIdentity | null, orders: AkmeOrder[] = []): ContextDeps {
  return {
    identify: async () => identity,
    recentOrders: async () => orders,
  };
}

function stranger(): ContextDeps {
  return deps(null);
}

function known(display_name: string | null, customer_id: string | null = 'cus-1'): ContextDeps {
  return deps({
    phone: '+14155550101',
    display_name,
    customer_id,
    customer: customer_id ? { id: customer_id, name: display_name, company: null, email: null, phone: null } : null,
  });
}

function order(over: Partial<AkmeOrder> = {}): AkmeOrder {
  return {
    id: 'ord-1',
    customer_id: 'cus-1',
    seq: 41,
    reference: 'AK-1041',
    status: 'confirmed',
    need_by: '2026-07-30',
    total_cents: 41250,
    created_at: '2026-07-25T10:00:00.000Z',
    ...over,
  } as AkmeOrder;
}

describe('callerContext', () => {
  // The lookup is cached by phone number for a minute so the prewarm at
  // call.answered can answer the assistant's webhook. Every test below uses the
  // same two numbers with different backing data, so it has to start empty.
  beforeEach(clearCallerContextCache);

  it('returns an empty-but-valid shape for a caller we have never seen', async () => {
    const ctx = await callerContext('+12125550188', stranger());
    expect(ctx.is_known_caller).toBe('no');
    expect(ctx.first_name).toBe('');
    expect(ctx.recent_order).toBe('');
  });

  it('gives the first name only, because the agent says it out loud', async () => {
    const ctx = await callerContext('+14155550101', known('Maria Delgado'));
    expect(ctx.first_name).toBe('Maria');
  });

  it('never returns a null, which would render as the string null in the prompt', async () => {
    const ctx = await callerContext('+14155550101', known(null));
    expect(Object.values(ctx).every((v) => typeof v === 'string')).toBe(true);
  });

  it('marks a caller we know as known even with no name on file', async () => {
    const ctx = await callerContext('+14155550101', known(null));
    expect(ctx.is_known_caller).toBe('yes');
  });

  it('describes the most recent order without saying what it cost', async () => {
    const ctx = await callerContext('+14155550101', deps(
      {
        phone: '+14155550101',
        display_name: 'Maria Delgado',
        customer_id: 'cus-1',
        customer: { id: 'cus-1', name: 'Maria', company: null, email: null, phone: null },
      },
      [order()],
    ));

    expect(ctx.recent_order).toContain('AK-1041');
    // The agent may never quote a price, so no total may reach the prompt where
    // it could be read out. 41250 cents must not appear in any form.
    expect(ctx.recent_order).not.toMatch(/\$|412|41250|dollar/);
  });

  it('survives a lookup that throws, because a dead webhook must not kill the call', async () => {
    // Telnyx proceeds best effort if this webhook fails, but a 500 costs the
    // whole timeout budget first. Returning the stranger shape is faster and
    // gives the same conversation.
    const ctx = await callerContext('+14155550101', {
      identify: async () => {
        throw new Error('supabase down');
      },
      recentOrders: async () => [],
    });

    expect(ctx.is_known_caller).toBe('no');
    expect(Object.values(ctx).every((v) => typeof v === 'string')).toBe(true);
  });
});

describe('prewarmCallerContext', () => {
  beforeEach(clearCallerContextCache);

  it('turns the webhook into a cache read, which is the point of doing it early', async () => {
    let lookups = 0;
    const counting: ContextDeps = {
      identify: async () => {
        lookups++;
        return { phone: '+14155550101', display_name: 'Maria Delgado', customer_id: null, customer: null };
      },
      recentOrders: async () => [],
    };

    prewarmCallerContext('+14155550101', counting);
    const ctx = await callerContext('+14155550101', counting);

    expect(ctx.first_name).toBe('Maria');
    // One database round trip for the call, spent while the disclosure played,
    // instead of one the assistant holds the caller in silence for.
    expect(lookups).toBe(1);
  });

  it('makes a webhook that lands mid-lookup wait on the one already running', async () => {
    let lookups = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: ContextDeps = {
      identify: async () => {
        lookups++;
        await gate;
        return { phone: '+14155550102', display_name: 'Sam', customer_id: null, customer: null };
      },
      recentOrders: async () => [],
    };

    prewarmCallerContext('+14155550102', slow);
    const pending = callerContext('+14155550102', slow);
    release();

    expect((await pending).first_name).toBe('Sam');
    expect(lookups).toBe(1);
  });

  it('never throws at the caller, because it runs on a live call nobody may drop', () => {
    expect(() =>
      prewarmCallerContext('+14155550103', {
        identify: async () => {
          throw new Error('supabase down');
        },
        recentOrders: async () => [],
      }),
    ).not.toThrow();
    expect(() => prewarmCallerContext('')).not.toThrow();
  });
});
