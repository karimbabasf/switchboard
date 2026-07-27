import { db, unwrap } from '../db';
import type { AkmeOrder } from '../types';

/**
 * Everything the voice agent reads mid-call. Every function here is a single
 * indexed query against the mirror or against Akme's own tables: a live QBO
 * round trip is 1-3 seconds, and that is dead air the caller hears.
 */

export type ItemMatch = {
  name: string;
  sku: string | null;
  price_cents: number | null;
  stock: number | null;
};

// Strips anything that would break the PostgREST filter string below or widen
// an ilike into a bare wildcard scan. What survives is exactly what a spoken
// product name needs: letters, digits, spaces, hyphens, apostrophes.
function sanitizeTerm(q: string): string {
  return q.replace(/[^\p{L}\p{N} '-]/gu, '').trim();
}

/**
 * Fuzzy match over qbo_items.name (full text, backed by the GIN index the
 * mirror migration creates) OR'd with a sku match (backed by the partial
 * btree). One query, no join.
 */
export async function findItems(query: string, limit = 5): Promise<ItemMatch[]> {
  const term = sanitizeTerm(query);
  if (!term) return [];

  const res = await db()
    .from('qbo_items')
    .select('name, sku, unit_price_cents, qty_on_hand')
    .eq('active', true)
    .or(`sku.ilike.%${term}%,name.wfts(english).${term}`)
    .limit(limit);

  const rows = unwrap(res, 'findItems') as {
    name: string;
    sku: string | null;
    unit_price_cents: number | null;
    qty_on_hand: number | null;
  }[];
  return rows.map((r) => ({
    name: r.name,
    sku: r.sku,
    price_cents: r.unit_price_cents,
    stock: r.qty_on_hand,
  }));
}

export type OpenInvoice = {
  qbo_id: string;
  doc_number: string | null;
  balance_cents: number | null;
  due_date: string | null;
  status: string | null;
};

/** Unpaid invoices for a customer. Indexed by qbo_invoices_customer_idx. */
export async function openInvoicesFor(customerId: string): Promise<OpenInvoice[]> {
  const res = await db()
    .from('qbo_invoices')
    .select('qbo_id, doc_number, balance_cents, due_date, status')
    .eq('customer_id', customerId)
    .gt('balance_cents', 0)
    .order('due_date', { ascending: true });
  return unwrap(res, 'openInvoicesFor') as OpenInvoice[];
}

/**
 * Recent Akme orders for a customer. READ ONLY, switchboard never writes this
 * table. Indexed by orders_customer_idx.
 */
export async function recentOrdersFor(customerId: string, limit = 5): Promise<AkmeOrder[]> {
  const res = await db()
    .from('orders')
    .select('id, customer_id, seq, reference, status, need_by, total_cents, created_at')
    .eq('customer_id', customerId)
    .order('created_at', { ascending: false })
    .limit(limit);
  return unwrap(res, 'recentOrdersFor') as AkmeOrder[];
}

export type CallerIdentity = {
  phone: string;
  display_name: string | null;
  customer_id: string | null;
  customer: {
    id: string;
    name: string | null;
    company: string | null;
    email: string | null;
    phone: string | null;
  } | null;
};

/**
 * Resolves a phone to its contact row and, when linked, its Akme customer, so
 * the agent knows who is calling before it speaks. contacts.phone is the
 * primary key and customer_id is embedded through its own indexed foreign key,
 * so PostgREST compiles this to one indexed nested-loop lookup, not a scan.
 * Returns null for a genuine stranger, the normal case for a first-time caller
 * and not an error condition.
 */
export async function identifyCaller(phone: string): Promise<CallerIdentity | null> {
  const { data, error } = await db()
    .from('contacts')
    .select('phone, display_name, customer_id, customers(id, name, company, email, phone)')
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw new Error(`identifyCaller failed: ${error.message}`);
  if (!data) return null;

  const row = data as unknown as {
    phone: string;
    display_name: string | null;
    customer_id: string | null;
    customers: CallerIdentity['customer'] | CallerIdentity['customer'][] | null;
  };
  const customer = Array.isArray(row.customers) ? row.customers[0] ?? null : row.customers ?? null;
  return {
    phone: row.phone,
    display_name: row.display_name,
    customer_id: row.customer_id,
    customer,
  };
}
