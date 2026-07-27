import { db } from '../db';
import { optionalEnv } from '../env';
import { qboClient, type QboItemRaw, type QboInvoiceRaw } from './client';
import type { QboItem, QboInvoice } from '../types';

/**
 * Pulls QBO Items and Invoices into the read mirror. Incremental per entity via
 * qbo_sync_state, the same watermark shape Akme's gmail_sync_state uses: the
 * watermark only advances on success, so a failed pull retries the same window
 * on the next tick instead of silently skipping what it missed.
 */

const PAGE_SIZE = 200;

type SyncEntity = 'items' | 'invoices';

export type SyncResult = { entity: SyncEntity; ok: boolean; error?: string };

type Watermark = { lastSyncedAt: string | null; attempts: number };

async function getWatermark(entity: SyncEntity): Promise<Watermark> {
  const { data, error } = await db()
    .from('qbo_sync_state')
    .select('last_synced_at, attempts')
    .eq('entity', entity)
    .maybeSingle();
  if (error) throw new Error(`getWatermark(${entity}) failed: ${error.message}`);
  return { lastSyncedAt: data?.last_synced_at ?? null, attempts: data?.attempts ?? 0 };
}

async function recordSyncSuccess(entity: SyncEntity, syncedAt: string): Promise<void> {
  const { error } = await db()
    .from('qbo_sync_state')
    .upsert(
      { entity, last_synced_at: syncedAt, last_error: null, attempts: 0, updated_at: new Date().toISOString() },
      { onConflict: 'entity' },
    );
  if (error) throw new Error(`recordSyncSuccess(${entity}) failed: ${error.message}`);
}

// last_synced_at is deliberately absent from this payload. Supabase upsert only
// SETs the columns it is given, so the prior watermark survives a failed pull
// untouched and the next tick retries the exact same window.
async function recordSyncFailure(entity: SyncEntity, message: string, priorAttempts: number): Promise<void> {
  const { error } = await db()
    .from('qbo_sync_state')
    .upsert(
      { entity, last_error: message.slice(0, 500), attempts: priorAttempts + 1, updated_at: new Date().toISOString() },
      { onConflict: 'entity' },
    );
  if (error) console.error(`recordSyncFailure(${entity}) failed: ${error.message}`);
}

async function runSync(entity: SyncEntity, pull: (sinceIso: string | null) => Promise<string>): Promise<SyncResult> {
  const watermark = await getWatermark(entity);
  try {
    const newWatermark = await pull(watermark.lastSyncedAt);
    await recordSyncSuccess(entity, newWatermark);
    return { entity, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await recordSyncFailure(entity, message, watermark.attempts);
    return { entity, ok: false, error: message };
  }
}

// QBO amounts are decimal dollars; every *_cents column is an integer.
function centsFromAmount(amount: number | undefined): number | null {
  return amount == null ? null : Math.round(amount * 100);
}

function toItemRow(raw: QboItemRaw): QboItem {
  return {
    qbo_id: raw.Id,
    name: raw.Name,
    sku: raw.Sku ?? null,
    description: raw.Description ?? null,
    unit_price_cents: centsFromAmount(raw.UnitPrice),
    qty_on_hand: raw.QtyOnHand ?? null,
    reorder_point: raw.ReorderPoint ?? null,
    active: raw.Active ?? true,
    synced_at: new Date().toISOString(),
  };
}

async function syncItems(): Promise<SyncResult> {
  return runSync('items', async (sinceIso) => {
    let position = 1;
    let maxSeen = sinceIso;
    for (;;) {
      const page = await qboClient.listItemsPage(sinceIso, position, PAGE_SIZE);
      if (page.length === 0) break;

      const rows = page.map(toItemRow);
      const { error } = await db().from('qbo_items').upsert(rows, { onConflict: 'qbo_id' });
      if (error) throw new Error(`qbo_items upsert failed: ${error.message}`);

      for (const raw of page) {
        const updated = raw.MetaData?.LastUpdatedTime;
        if (updated && (!maxSeen || updated > maxSeen)) maxSeen = updated;
      }
      if (page.length < PAGE_SIZE) break;
      position += PAGE_SIZE;
    }
    return maxSeen ?? new Date().toISOString();
  });
}

/**
 * paid / open / overdue, evaluated on calendar dates only. `now` is a parameter
 * so the boundary (an invoice due exactly today reads as open, not overdue) is
 * deterministic in tests instead of racing the real clock.
 */
export function deriveInvoiceStatus(
  balanceCents: number,
  dueDate: string | null,
  now: Date = new Date(),
): 'paid' | 'open' | 'overdue' {
  if (balanceCents <= 0) return 'paid';
  if (!dueDate) return 'open';
  const today = now.toISOString().slice(0, 10);
  return dueDate < today ? 'overdue' : 'open';
}

/**
 * Matches invoices to Akme customers by QBO id, scoped to just the ids seen in
 * this page (never a full table scan). Confidence bar is exact match only: an
 * id with nothing on the other side stays unlinked rather than guessing, which
 * is the boundary the sync contract requires.
 */
async function linkCustomers(qboCustIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (qboCustIds.length === 0) return map;

  const filter = qboCustIds.map((id) => `external_ids->>qbo.eq.${id}`).join(',');
  const { data, error } = await db().from('customers').select('id, external_ids').or(filter);
  if (error) throw new Error(`linkCustomers failed: ${error.message}`);

  for (const row of (data ?? []) as { id: string; external_ids: Record<string, unknown> | null }[]) {
    const qboId = row.external_ids?.qbo;
    if (typeof qboId === 'string') map.set(qboId, row.id);
  }
  return map;
}

function toInvoiceRow(raw: QboInvoiceRaw, linked: Map<string, string>): QboInvoice {
  const balanceCents = centsFromAmount(raw.Balance) ?? 0;
  const dueDate = raw.DueDate ?? null;
  const qboCustId = raw.CustomerRef?.value ?? null;
  return {
    qbo_id: raw.Id,
    customer_id: qboCustId ? linked.get(qboCustId) ?? null : null,
    qbo_custid: qboCustId,
    doc_number: raw.DocNumber ?? null,
    total_cents: centsFromAmount(raw.TotalAmt),
    balance_cents: balanceCents,
    due_date: dueDate,
    txn_date: raw.TxnDate ?? null,
    status: deriveInvoiceStatus(balanceCents, dueDate),
    synced_at: new Date().toISOString(),
  };
}

async function syncInvoices(): Promise<SyncResult> {
  return runSync('invoices', async (sinceIso) => {
    let position = 1;
    let maxSeen = sinceIso;
    for (;;) {
      const page = await qboClient.listInvoicesPage(sinceIso, position, PAGE_SIZE);
      if (page.length === 0) break;

      const custIds = [...new Set(page.map((r) => r.CustomerRef?.value).filter((v): v is string => !!v))];
      const linked = await linkCustomers(custIds);
      const rows = page.map((raw) => toInvoiceRow(raw, linked));
      const { error } = await db().from('qbo_invoices').upsert(rows, { onConflict: 'qbo_id' });
      if (error) throw new Error(`qbo_invoices upsert failed: ${error.message}`);

      for (const raw of page) {
        const updated = raw.MetaData?.LastUpdatedTime;
        if (updated && (!maxSeen || updated > maxSeen)) maxSeen = updated;
      }
      if (page.length < PAGE_SIZE) break;
      position += PAGE_SIZE;
    }
    return maxSeen ?? new Date().toISOString();
  });
}

export { syncItems, syncInvoices };

export type QboSyncRunResult = { enabled: false } | { enabled: true; items: SyncResult; invoices: SyncResult };

/**
 * QBO_SYNC_ENABLED is a hard, off-by-default kill switch (see .env.example).
 * The token store here is the SAME qbo_credentials row Akme's production
 * connection rotates through; a bug that fires this before Karim deliberately
 * turns it on does not just degrade switchboard, it can knock Akme off
 * QuickBooks. The check lives here, not only in the route, so any future
 * caller of runQboSync gets the same guarantee for free.
 */
export async function runQboSync(): Promise<QboSyncRunResult> {
  if (optionalEnv('QBO_SYNC_ENABLED', 'false') !== 'true') {
    return { enabled: false };
  }
  const items = await syncItems();
  const invoices = await syncInvoices();
  return { enabled: true, items, invoices };
}
