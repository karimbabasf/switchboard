/**
 * pg_cron hits this every 2 minutes (see supabase/migrations/20260727000003_schedule_worker.sql).
 * Authenticated by WORKER_SECRET alone: deliberately its own secret, distinct
 * from the Telegram webhook secret and every other credential in this app, so
 * one leaking never hands over another.
 */

import type { NextRequest } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { env } from '@/lib/env';
import { runWorker } from '@/lib/worker/run';

export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 20;

function isAuthorized(request: NextRequest): boolean {
  const header = request.headers.get('authorization');
  if (!header) return false;

  const expected = Buffer.from(`Bearer ${env('WORKER_SECRET')}`);
  const actual = Buffer.from(header);
  // Compare fixed-length digests only; timingSafeEqual throws on length mismatch.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function readLimit(request: NextRequest): Promise<number> {
  try {
    const body = await request.json();
    if (body && typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0) {
      return Math.floor(body.limit);
    }
  } catch {
    // No body, or not JSON. The pg_cron job posts an empty '{}' body; either way, use the default.
  }
  return DEFAULT_LIMIT;
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const limit = await readLimit(request);
  const result = await runWorker(limit);
  return Response.json(result);
}
