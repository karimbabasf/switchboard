import crypto from 'node:crypto';
import { env, optionalEnv } from '../env';

/**
 * Calls Akme to apply a quantity change.
 *
 * The switchboard deliberately does NOT write orders itself, even though it
 * holds a service role key that would let it. Changing a quantity moves the line
 * total, the order total, the stored quote body and the approval card, and all
 * of that logic already exists once, in Akme. A second copy here would be two
 * owners for the same money, and they would drift the first time either side
 * changed.
 *
 * Authorisation is the same HMAC token Akme's own price editor uses, scoped to
 * "change" so a token minted for one cannot do the other. Both sides read the
 * secret from AKME_SIGNING_SECRET; it is the one thing that has to match.
 */

const TOKEN_TTL_SECONDS = 300;
const TIMEOUT_MS = 10_000;

/** Mirrors lib/ops/signing.ts in Akme. One HMAC over a base64url body, nothing to misconfigure. */
function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export type ApplyResult = { ok: true; reference: string } | { ok: false; reason: string };

export async function applyOrderChange(input: {
  orderId: string;
  sku: string;
  qty: number;
  actor: string;
}): Promise<ApplyResult> {
  const base = optionalEnv('AKME_BASE_URL', 'http://localhost:3001').replace(/\/$/, '');
  const token = signToken({ order: input.orderId, scope: 'change' }, env('AKME_SIGNING_SECRET'), TOKEN_TTL_SECONDS);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/order-change`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token,
        quantities: [{ sku: input.sku, qty: input.qty }],
        actor: input.actor,
      }),
      signal: controller.signal,
    });

    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; reference?: string; error?: string };
    // A 409 is Akme refusing on the order's state, and its reason is written to
    // be read by whoever tapped, so it is passed through rather than flattened
    // into "failed". That reason is the whole value of the round trip.
    if (!res.ok) return { ok: false, reason: json.error ?? `Akme answered ${res.status}` };
    return { ok: true, reference: json.reference ?? '' };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'Akme did not answer in time' : String(err);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}
