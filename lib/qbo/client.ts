import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, optionalEnv } from '../env';
import { db } from '../db';

/**
 * Thin QuickBooks Online client for the mirror sync. Ported from the working
 * client and token store at Akme/lib/ops/qbo/{client,tokens}.ts so both apps
 * agree on the OAuth refresh and rotating-token contract against the SAME
 * QuickBooks company.
 *
 * READ ONLY: every exported function here is a GET against the QBO query
 * endpoint. Nothing in this file, or anywhere in lib/qbo, issues a QBO write.
 * Writes stay in Akme, behind its own human-commits gate.
 */

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
// Refresh this far before the access token actually expires, so a call in
// flight when the clock rolls over does not 401.
const EXPIRY_MARGIN_MS = 60_000;

type Tokens = {
  realmId: string;
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number; // ms epoch
};

let tokenClient: SupabaseClient | null = null;

/**
 * The QBO token store. Intuit issues ONE refresh token per authorization and
 * rotates it on every refresh, so two independent stores holding a copy
 * invalidate each other within a day. QBO_TOKEN_SUPABASE_URL must point at the
 * exact same project Akme's tokens.ts reads, i.e. wherever the production
 * qbo_credentials row actually lives.
 *
 * The fallback to this app's own db() only sets a default SHAPE, not a correct
 * default: switchboard's db() runs against the shared akme-dev database (see
 * lib/db.ts), which is not where a real qbo_credentials row lives. A
 * misconfigured env should fail loudly against a real, connectable client
 * ("qbo_credentials is empty") rather than silently reading nothing from an
 * unset URL.
 */
function tokenDb(): SupabaseClient {
  if (tokenClient) return tokenClient;
  const url = optionalEnv('QBO_TOKEN_SUPABASE_URL', '');
  tokenClient = url
    ? createClient(url, env('QBO_TOKEN_SUPABASE_SERVICE_ROLE_KEY'), {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : db();
  return tokenClient;
}

async function readStore(): Promise<Tokens> {
  const { data, error } = await tokenDb().rpc('qbo_read_credentials');
  if (error) throw new Error(`qbo_read_credentials failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('qbo_credentials is empty, nothing to sync against');
  return {
    realmId: row.realm_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: new Date(row.access_token_expires_at).getTime(),
  };
}

async function commit(prevRefresh: string, next: Tokens): Promise<Tokens> {
  const { data, error } = await tokenDb().rpc('qbo_rotate', {
    p_prev_refresh: prevRefresh,
    p_access: next.accessToken,
    p_expires_at: new Date(next.accessExpiresAt).toISOString(),
    p_next_refresh: next.refreshToken,
  });
  if (error) throw new Error(`qbo_rotate failed: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row.won) {
    // Akme (or another switchboard process) rotated first. Its token is the
    // live one; use the authoritative row the RPC returns instead of ours.
    console.error('[qbo] another process rotated the token first, using theirs');
  }
  return {
    realmId: row.realm_id,
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    accessExpiresAt: new Date(row.access_token_expires_at).getTime(),
  };
}

async function refreshTokens(tokens: Tokens): Promise<Tokens> {
  const clientId = env('QBO_CLIENT_ID');
  const clientSecret = env('QBO_CLIENT_SECRET');
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
  });

  const text = await res.text();
  if (!res.ok) {
    if (res.status === 400 && text.includes('invalid_grant')) {
      // Under the shared store this should be rare. The usual cause is that
      // something else already rotated the token, so re-read once before
      // declaring the connection dead.
      const current = await readStore();
      if (current.refreshToken !== tokens.refreshToken) {
        console.error('[qbo] refresh token rotated elsewhere, picked up the current one');
        return current;
      }
      throw new Error('QBO refresh token rejected (invalid_grant). Re-authorize through Akme and reseed.');
    }
    throw new Error(`QBO token refresh failed: ${res.status} ${text}`);
  }

  const data = JSON.parse(text);
  const next: Tokens = {
    ...tokens,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || tokens.refreshToken, // rotates, keep newest
    accessExpiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_MARGIN_MS,
  };
  return commit(tokens.refreshToken, next);
}

// Per-process single-flight. The database compare-and-swap in qbo_rotate is
// what makes concurrent refreshes across processes safe; this only avoids two
// refreshes racing inside the same process.
let refreshing: Promise<Tokens> | null = null;

async function getAuth(): Promise<{ accessToken: string; realmId: string }> {
  let tokens = await readStore();
  const stale = !tokens.accessToken || !tokens.accessExpiresAt || Date.now() >= tokens.accessExpiresAt;

  if (stale) {
    if (!refreshing) {
      refreshing = refreshTokens(tokens).finally(() => {
        refreshing = null;
      });
    }
    tokens = await refreshing;
  }

  return { accessToken: tokens.accessToken, realmId: tokens.realmId };
}

function apiBase(): string {
  const environment = optionalEnv('QBO_ENV', 'production');
  return environment === 'production'
    ? 'https://quickbooks.api.intuit.com'
    : 'https://sandbox-quickbooks.api.intuit.com';
}

// An Intuit error body echoes the realm id back. Strips it so a thrown message
// that ends up in a cron log does not carry it along.
function redact(message: string, realmId: string): string {
  return realmId ? message.split(realmId).join('[realm]') : message;
}

async function get(query: string): Promise<{ QueryResponse?: Record<string, unknown[]> }> {
  const { accessToken, realmId } = await getAuth();
  const minorVersion = optionalEnv('QBO_MINOR_VERSION', '75');
  const url = new URL(`${apiBase()}/v3/company/${realmId}/query`);
  url.searchParams.set('minorversion', minorVersion);
  url.searchParams.set('query', query);

  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(redact(`QBO query -> ${res.status}: ${text}`, realmId));
  return text ? JSON.parse(text) : {};
}

// QBO's query language escapes with a BACKSLASH, not by doubling quotes.
// Backslash first, or it escapes the escape.
const esc = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export type QboItemRaw = {
  Id: string;
  Name: string;
  Sku?: string;
  Description?: string;
  UnitPrice?: number;
  QtyOnHand?: number;
  ReorderPoint?: number;
  Active?: boolean;
  MetaData?: { LastUpdatedTime?: string };
};

export type QboInvoiceRaw = {
  Id: string;
  DocNumber?: string;
  TotalAmt?: number;
  Balance?: number;
  DueDate?: string;
  TxnDate?: string;
  CustomerRef?: { value?: string };
  MetaData?: { LastUpdatedTime?: string };
};

// Metadata.LastUpdatedTime is both the incremental filter and the sort key, so
// a page boundary can never split or skip a timestamp: everything at or after
// `sinceIso` comes back in the same monotonic order every time this is called.
async function queryPage<T>(
  entity: 'Item' | 'Invoice',
  sinceIso: string | null,
  startPosition: number,
  pageSize: number,
): Promise<T[]> {
  const where = sinceIso ? ` where Metadata.LastUpdatedTime > '${esc(sinceIso)}'` : '';
  const query =
    `select * from ${entity}${where}` +
    ` orderby Metadata.LastUpdatedTime asc startposition ${startPosition} maxresults ${pageSize}`;
  const res = await get(query);
  return (res.QueryResponse?.[entity] ?? []) as T[];
}

export const qboClient = {
  listItemsPage: (sinceIso: string | null, startPosition: number, pageSize: number) =>
    queryPage<QboItemRaw>('Item', sinceIso, startPosition, pageSize),
  listInvoicesPage: (sinceIso: string | null, startPosition: number, pageSize: number) =>
    queryPage<QboInvoiceRaw>('Invoice', sinceIso, startPosition, pageSize),
};
