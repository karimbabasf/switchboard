import { describe, expect, it } from 'vitest';
import { callerContext, type ContextDeps } from '../lib/agent/context';
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
