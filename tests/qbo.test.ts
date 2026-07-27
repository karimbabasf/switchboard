import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Every Supabase and QBO HTTP call is mocked. Nothing in this file reaches a
 * real database or a real QuickBooks company, sandbox or production.
 */

vi.mock('../lib/db', () => ({
  db: vi.fn(),
  unwrap: (res: { data: unknown; error: { message: string } | null }, what: string) => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    if (res.data === null) throw new Error(`${what}: no data returned`);
    return res.data;
  },
}));

vi.mock('../lib/qbo/client', () => ({
  qboClient: {
    listItemsPage: vi.fn(),
    listInvoicesPage: vi.fn(),
  },
}));

vi.mock('../lib/env', () => ({
  env: (name: string) => {
    if (name === 'WORKER_SECRET') return 'test-worker-secret-value';
    throw new Error(`unexpected env var in test: ${name}`);
  },
  // Reads the real process.env so vi.stubEnv can drive the QBO_SYNC_ENABLED
  // kill switch. Returning the fallback unconditionally made the off-by-default
  // path the ONLY reachable path, which silently passed the skip test while
  // making the enabled test untestable.
  optionalEnv: (name: string, fallback: string) => process.env[name]?.trim() || fallback,
}));

// Real syncItems/syncInvoices/deriveInvoiceStatus, mocked runQboSync only, so
// the route test below does not have to run a real sync end to end.
vi.mock('../lib/qbo/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/qbo/sync')>();
  return { ...actual, runQboSync: vi.fn() };
});

import { db } from '../lib/db';
import { qboClient } from '../lib/qbo/client';
import { deriveInvoiceStatus, syncItems, syncInvoices, runQboSync } from '../lib/qbo/sync';
import { findItems, openInvoicesFor, recentOrdersFor, identifyCaller } from '../lib/qbo/lookup';
import { POST } from '../app/api/qbo-sync/route';

afterEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// In-memory fake Supabase client for the sync tests: real persistence across
// calls (upsert, conflict resolution) without touching a database.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function makeFakeDb(seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    qbo_items: seed.qbo_items ? [...seed.qbo_items] : [],
    qbo_invoices: seed.qbo_invoices ? [...seed.qbo_invoices] : [],
    qbo_sync_state: seed.qbo_sync_state ? [...seed.qbo_sync_state] : [],
    customers: seed.customers ? [...seed.customers] : [],
  };

  function from(table: string) {
    return {
      select(_cols: string) {
        return {
          eq(col: string, val: unknown) {
            const matches = tables[table].filter((r) => r[col] === val);
            return { maybeSingle: async () => ({ data: matches[0] ?? null, error: null }) };
          },
          or(filter: string) {
            const ids = [...filter.matchAll(/external_ids->>qbo\.eq\.([^,]+)/g)].map((m) => m[1]);
            const matches = tables[table].filter((r) => {
              const ext = r.external_ids as Record<string, unknown> | undefined;
              return !!ext && typeof ext.qbo === 'string' && ids.includes(ext.qbo as string);
            });
            return Promise.resolve({ data: matches, error: null });
          },
        };
      },
      upsert(rows: Row | Row[], opts?: { onConflict?: string }) {
        const incoming = Array.isArray(rows) ? rows : [rows];
        const key = opts?.onConflict ?? 'id';
        for (const row of incoming) {
          const idx = tables[table].findIndex((r) => r[key] === row[key]);
          if (idx >= 0) tables[table][idx] = { ...tables[table][idx], ...row };
          else tables[table].push({ ...row });
        }
        return Promise.resolve({ data: null, error: null });
      },
    };
  }

  return { from, tables };
}

function useFakeDb(seed?: Parameters<typeof makeFakeDb>[0]) {
  const fake = makeFakeDb(seed);
  vi.mocked(db).mockReturnValue({ from: fake.from } as never);
  return fake;
}

// A chainable, thenable fake for the lookup.ts tests: every filter method
// returns itself, and the chain can be awaited from any point, matching how
// supabase-js's own query builder behaves.
function chain(result: { data: unknown; error: { message: string } | null }) {
  const handler: Record<string, unknown> = {};
  const pass = vi.fn(() => handler);
  handler.select = pass;
  handler.eq = pass;
  handler.gt = pass;
  handler.or = pass;
  handler.order = pass;
  handler.limit = pass;
  handler.maybeSingle = vi.fn(async () => result);
  (handler as { then: unknown }).then = (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  return handler;
}

// ---------------------------------------------------------------------------

describe('deriveInvoiceStatus', () => {
  const now = new Date('2026-07-27T12:00:00.000Z');

  it('is paid once the balance is zero or less', () => {
    expect(deriveInvoiceStatus(0, '2026-06-01', now)).toBe('paid');
    expect(deriveInvoiceStatus(-500, '2026-06-01', now)).toBe('paid');
  });

  it('is open when balance is owed and there is no due date', () => {
    expect(deriveInvoiceStatus(1000, null, now)).toBe('open');
  });

  it('is open, not overdue, on the due date itself', () => {
    expect(deriveInvoiceStatus(1000, '2026-07-27', now)).toBe('open');
  });

  it('is overdue the day after the due date', () => {
    expect(deriveInvoiceStatus(1000, '2026-07-26', now)).toBe('overdue');
  });

  it('is open before the due date arrives', () => {
    expect(deriveInvoiceStatus(1000, '2026-08-01', now)).toBe('open');
  });
});

describe('syncItems', () => {
  it('advances the watermark to the max LastUpdatedTime only on success', async () => {
    const fake = useFakeDb({
      qbo_sync_state: [{ entity: 'items', last_synced_at: '2026-07-01T00:00:00.000Z', attempts: 0 }],
    });
    vi.mocked(qboClient.listItemsPage)
      .mockResolvedValueOnce([
        { Id: '1', Name: 'Packing Tape', MetaData: { LastUpdatedTime: '2026-07-27T10:00:00.000Z' } },
      ])
      .mockResolvedValueOnce([]);

    const result = await syncItems();

    expect(result.ok).toBe(true);
    const state = fake.tables.qbo_sync_state.find((r) => r.entity === 'items');
    expect(state?.last_synced_at).toBe('2026-07-27T10:00:00.000Z');
    expect(state?.attempts).toBe(0);
    expect(state?.last_error).toBeNull();
  });

  it('upserts by qbo_id, so a re-run does not duplicate rows', async () => {
    const fake = useFakeDb();
    const page = [
      { Id: '1', Name: 'Packing Tape', MetaData: { LastUpdatedTime: '2026-07-27T10:00:00.000Z' } },
      { Id: '2', Name: 'Moving Boxes', MetaData: { LastUpdatedTime: '2026-07-27T10:05:00.000Z' } },
    ];
    vi.mocked(qboClient.listItemsPage)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);

    await syncItems();
    await syncItems();

    expect(fake.tables.qbo_items).toHaveLength(2);
    expect(fake.tables.qbo_items.map((r) => r.qbo_id).sort()).toEqual(['1', '2']);
  });

  it('leaves the watermark untouched when the pull fails', async () => {
    const fake = useFakeDb({
      qbo_sync_state: [{ entity: 'items', last_synced_at: '2026-07-01T00:00:00.000Z', attempts: 0 }],
    });
    vi.mocked(qboClient.listItemsPage).mockRejectedValueOnce(new Error('QBO query -> 500: boom'));

    const result = await syncItems();

    expect(result.ok).toBe(false);
    const state = fake.tables.qbo_sync_state.find((r) => r.entity === 'items');
    expect(state?.last_synced_at).toBe('2026-07-01T00:00:00.000Z'); // untouched
    expect(state?.attempts).toBe(1);
    expect(state?.last_error).toContain('boom');
  });
});

describe('syncInvoices', () => {
  it('derives status per row and links a customer only on an exact qbo id match', async () => {
    const fake = useFakeDb({
      customers: [{ id: 'cust-uuid-1', external_ids: { qbo: '55' } }],
    });
    vi.mocked(qboClient.listInvoicesPage)
      .mockResolvedValueOnce([
        {
          Id: '900',
          Balance: 0,
          CustomerRef: { value: '55' },
          MetaData: { LastUpdatedTime: '2026-07-27T09:00:00.000Z' },
        },
        {
          Id: '901',
          Balance: 40,
          DueDate: '2026-01-01', // long past, never flaky against the real clock
          CustomerRef: { value: '999' }, // no matching customer row
          MetaData: { LastUpdatedTime: '2026-07-27T09:05:00.000Z' },
        },
      ])
      .mockResolvedValueOnce([]);

    const result = await syncInvoices();

    expect(result.ok).toBe(true);
    const paid = fake.tables.qbo_invoices.find((r) => r.qbo_id === '900');
    const overdue = fake.tables.qbo_invoices.find((r) => r.qbo_id === '901');
    expect(paid?.status).toBe('paid');
    expect(paid?.customer_id).toBe('cust-uuid-1');
    expect(overdue?.status).toBe('overdue');
    expect(overdue?.customer_id).toBeNull(); // no confident match, left null
  });
});

describe('findItems', () => {
  it('sanitizes the term and maps rows to the lookup shape', async () => {
    const rows = [{ name: 'Packing Tape', sku: 'TAPE-1', unit_price_cents: 599, qty_on_hand: 12 }];
    vi.mocked(db).mockReturnValue({ from: vi.fn(() => chain({ data: rows, error: null })) } as never);

    const result = await findItems('packing tape!!');

    expect(result).toEqual([{ name: 'Packing Tape', sku: 'TAPE-1', price_cents: 599, stock: 12 }]);
  });

  it('short-circuits to [] when the query sanitizes to nothing', async () => {
    expect(await findItems('!!!')).toEqual([]);
  });

  it('propagates a db error', async () => {
    vi.mocked(db).mockReturnValue({
      from: vi.fn(() => chain({ data: null, error: { message: 'boom' } })),
    } as never);
    await expect(findItems('tape')).rejects.toThrow('boom');
  });
});

describe('openInvoicesFor', () => {
  it('returns unpaid invoices for the customer', async () => {
    const rows = [{ qbo_id: '1', doc_number: 'INV-1', balance_cents: 500, due_date: '2026-08-01', status: 'open' }];
    vi.mocked(db).mockReturnValue({ from: vi.fn(() => chain({ data: rows, error: null })) } as never);

    expect(await openInvoicesFor('cust-1')).toEqual(rows);
  });
});

describe('recentOrdersFor', () => {
  it('returns Akme order rows unchanged', async () => {
    const rows = [
      {
        id: 'o1',
        customer_id: 'c1',
        seq: 1,
        reference: 'AK-00001',
        status: 'delivered',
        need_by: null,
        total_cents: 1000,
        created_at: '2026-07-01T00:00:00.000Z',
      },
    ];
    vi.mocked(db).mockReturnValue({ from: vi.fn(() => chain({ data: rows, error: null })) } as never);

    expect(await recentOrdersFor('c1')).toEqual(rows);
  });
});

describe('identifyCaller', () => {
  it('returns null for a genuine stranger', async () => {
    vi.mocked(db).mockReturnValue({ from: vi.fn(() => chain({ data: null, error: null })) } as never);
    expect(await identifyCaller('+14155550100')).toBeNull();
  });

  it('maps a known caller with its embedded customer', async () => {
    const row = {
      phone: '+14155550100',
      display_name: 'Karim',
      customer_id: 'c1',
      customers: { id: 'c1', name: 'Karim B', company: 'Akme', email: 'k@example.com', phone: '+14155550100' },
    };
    vi.mocked(db).mockReturnValue({ from: vi.fn(() => chain({ data: row, error: null })) } as never);

    const result = await identifyCaller('+14155550100');
    expect(result?.customer_id).toBe('c1');
    expect(result?.customer?.company).toBe('Akme');
  });
});

describe('POST /api/qbo-sync', () => {
  it('rejects a missing or wrong bearer token without running the sync', async () => {
    const req = new Request('http://localhost/api/qbo-sync', { method: 'POST' });

    const res = await POST(req);

    expect(res.status).toBe(401);
    expect(runQboSync).not.toHaveBeenCalled();
  });

  it('runs the sync for the correct bearer token when explicitly enabled', async () => {
    vi.stubEnv('QBO_SYNC_ENABLED', 'true');
    vi.mocked(runQboSync).mockResolvedValueOnce({
      enabled: true,
      items: { entity: 'items', ok: true },
      invoices: { entity: 'invoices', ok: true },
    });
    const req = new Request('http://localhost/api/qbo-sync', {
      method: 'POST',
      headers: { authorization: 'Bearer test-worker-secret-value' },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items.ok).toBe(true);
    vi.unstubAllEnvs();
  });

  // The default matters more than the enabled path: an authorized caller must
  // still be a no-op unless someone deliberately turned the sync on, because
  // this is the one component that can reach Akme's production token store.
  it('skips the sync when QBO_SYNC_ENABLED is not set, even with a valid token', async () => {
    const req = new Request('http://localhost/api/qbo-sync', {
      method: 'POST',
      headers: { authorization: 'Bearer test-worker-secret-value' },
    });

    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.skipped).toBeDefined();
    expect(runQboSync).not.toHaveBeenCalled();
  });
});
