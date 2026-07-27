import { createHash, timingSafeEqual } from 'node:crypto';
import { env, optionalEnv } from '../../../lib/env';
import { runQboSync } from '../../../lib/qbo/sync';

/**
 * pg_cron POSTs here every 15 minutes (see the schedule_qbo_sync migration),
 * carrying WORKER_SECRET as a standard bearer token. Runs the QBO mirror pull;
 * see lib/qbo/sync.ts for the watermark and upsert contract this drives.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Hash both sides to a fixed-length digest before comparing, so a length
// mismatch does not return in measurably less time than a full comparison.
function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = createHash('sha256').update(Buffer.from(a)).digest();
  const bh = createHash('sha256').update(Buffer.from(b)).digest();
  return timingSafeEqual(ah, bh) && Buffer.from(a).length === Buffer.from(b).length;
}

export async function POST(request: Request): Promise<Response> {
  const authHeader = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${env('WORKER_SECRET')}`;
  if (!timingSafeEqualStr(authHeader, expected)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Off unless explicitly switched on, and the default is off on purpose.
  //
  // Intuit rotates the QBO refresh token on EVERY use, so whichever store holds
  // that token is a single point of failure shared with Akme. Akme's token
  // store is in production and drives real invoicing, so a bug in this sync
  // does not degrade switchboard, it kills Akme's ability to invoice anyone.
  // That is Karim's call to make deliberately, not a default to inherit.
  //
  // runQboSync() carries the same check internally, so any other caller gets
  // it for free; this one returns a clearer message for cron logs without a
  // QBO or database round trip.
  if (optionalEnv('QBO_SYNC_ENABLED', 'false') !== 'true') {
    return Response.json(
      { skipped: 'QBO_SYNC_ENABLED is not true', reason: 'shares a rotating token with Akme production' },
      { status: 200 },
    );
  }

  try {
    const result = await runQboSync();
    if (!result.enabled) {
      return Response.json(result, { status: 200 });
    }
    const ok = result.items.ok && result.invoices.ok;
    return Response.json(result, { status: ok ? 200 : 502 });
  } catch (err) {
    console.error(`qbo-sync failed: ${err instanceof Error ? err.message : String(err)}`);
    return Response.json({ error: 'sync failed' }, { status: 500 });
  }
}
