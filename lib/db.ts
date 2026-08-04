import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env } from './env.ts';

/**
 * Service-role Supabase client.
 *
 * Every switchboard table has RLS enabled with ZERO policies, so this key is the
 * only way in and there is no anon surface at all. It must never reach a browser.
 *
 * NOTE: this runs against the SHARED akme-dev database. switchboard owns the
 * tables in lib/types.ts and the qbo_* mirror. It reads Akme's customers,
 * orders, order_lines and quotes, and writes to none of them.
 */
let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  client = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'x-application-name': 'switchboard' } },
  });
  return client;
}

/** Throws on a Supabase error so callers never silently act on a failed read. */
export function unwrap<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new Error(`${what}: no data returned`);
  return res.data;
}
