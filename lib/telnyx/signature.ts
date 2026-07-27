import { createPublicKey, verify } from 'node:crypto';
import { env } from '../env';

/**
 * Telnyx webhook authentication.
 *
 * Ed25519 over the literal bytes `${timestamp}|${rawBody}`. Two rules that are
 * easy to get wrong and both fail silently in the safe-looking direction:
 *
 * 1. RAW BODY ONLY. Re-serializing JSON is not byte-stable (key order, unicode
 *    escaping, number formatting), so verifying a re-encoded body rejects honest
 *    requests and tempts someone to "fix" it by checking something weaker.
 *    In a route handler that means `await request.text()`, never `request.json()`.
 * 2. Reject old timestamps. Without a freshness window a captured request can be
 *    replayed forever.
 */

const TOLERANCE_SECONDS = 300;

/** Telnyx publishes the public key base64-encoded; Node wants a DER SubjectPublicKeyInfo. */
function publicKey() {
  const raw = Buffer.from(env('TELNYX_PUBLIC_KEY'), 'base64');
  // 12-byte Ed25519 SPKI prefix, then the 32-byte key.
  const der = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    raw.subarray(raw.length - 32),
  ]);
  return createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

export function verifyTelnyxWebhook(
  rawBody: string,
  signatureB64: string | null,
  timestamp: string | null,
  now: number = Date.now(),
): VerifyResult {
  if (!signatureB64) return { ok: false, reason: 'missing telnyx-signature-ed25519 header' };
  if (!timestamp) return { ok: false, reason: 'missing telnyx-timestamp header' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp is not a number' };

  const ageSeconds = Math.abs(now / 1000 - ts);
  if (ageSeconds > TOLERANCE_SECONDS) {
    return { ok: false, reason: `timestamp is ${Math.round(ageSeconds)}s old, tolerance is ${TOLERANCE_SECONDS}s` };
  }

  let valid = false;
  try {
    valid = verify(
      null, // Ed25519 takes no separate digest
      Buffer.from(`${timestamp}|${rawBody}`, 'utf8'),
      publicKey(),
      Buffer.from(signatureB64, 'base64'),
    );
  } catch (err) {
    return { ok: false, reason: `verify threw: ${err instanceof Error ? err.message : String(err)}` };
  }

  return valid ? { ok: true } : { ok: false, reason: 'signature does not match' };
}

export const TELNYX_SIGNATURE_HEADER = 'telnyx-signature-ed25519';
export const TELNYX_TIMESTAMP_HEADER = 'telnyx-timestamp';
