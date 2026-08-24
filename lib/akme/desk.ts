import crypto from 'node:crypto';
import { env, optionalEnv } from '../env';

/**
 * Hands an inbound text to Akme and returns what to say back.
 *
 * AKME DECIDES, SWITCHBOARD SENDS. This repo has the Telnyx credential and no
 * opinion about the deal; Akme has the orders, the prices, the customer records
 * and the one copy of the rules. The alternative, which is what shipped first
 * and what this replaces, was two agent brains in two repos sharing only a
 * timeline: the same question got two different answers depending on whether the
 * customer emailed or texted, and every rule change needed both repos.
 *
 * Authorisation is the same HMAC pattern as order-change.ts, with its OWN secret.
 * Akme refuses to boot if DESK_INBOUND_SECRET matches any other secret it
 * holds, so a token minted for the price editor cannot open this door.
 */

const TOKEN_TTL_SECONDS = 60;

/**
 * Long, and deliberately so.
 *
 * One turn behind this door can price an order off live QuickBooks and run a
 * classifier, which is seconds and not milliseconds. The webhook has already been
 * acked by the time this runs, so nothing is waiting on it but the customer.
 *
 * The cost of being too tight is worse than the cost of being slow: Akme claims
 * the quote send BEFORE it answers, so a timeout can leave a quote recorded as
 * sent that this repo never sent. That is why a timeout is reported as
 * `unreachable` and not as `declined`.
 */
const TIMEOUT_MS = 20_000;

/** Mirrors lib/ops/signing.ts in Akme. One HMAC over a base64url body. */
function signToken(payload: Record<string, unknown>, secret: string, ttlSeconds: number): string {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

export type DeskOutcome =
  /** The desk took the message and wrote a reply. Send it. */
  | { kind: 'answer'; reply: string }
  /**
   * The desk took the message and deliberately said nothing.
   *
   * This is a real outcome, not a failure: an over-ceiling quote and an
   * escalation both post a Telegram card and stay silent to the customer on
   * purpose. Answering anyway would talk over the card.
   */
  | { kind: 'silent' }
  /**
   * The desk did not take it, and says why.
   *
   * A DECLINE NOW CARRIES ITS OWN WORDS when a customer is waiting, and that is
   * the field this type had no room for until 2026-08-24. There used to be an
   * old path below this one: a decline fell through to a local drafter that
   * wrote its own sentence out of a template, which is the second writer the
   * door exists to remove. The drafter is gone, so a decline that leaves a
   * customer waiting has to arrive with Akme's holding line on it. `reply` is
   * null when nobody is waiting, which is the channel simply not being armed.
   */
  | { kind: 'declined'; reason: string | null; reply: string | null }
  /**
   * The door never answered, so what it did is UNKNOWN.
   *
   * Distinct from `declined` on purpose, and the distinction is the whole reason
   * this type has four cases instead of three. `declined` is Akme saying it did
   * nothing, which is safe to answer around. `unreachable` might be Akme having
   * recorded a quote as sent one millisecond after the socket closed, and
   * drafting a second answer on top of that is how a customer gets two prices.
   */
  | { kind: 'unreachable'; reason: string };

export async function askAkmeDesk(input: {
  phone: string;
  body: string;
  displayName: string | null;
  /** The `messages` row this text was filed as, so Akme can point back at it. */
  messageId: string | null;
  /**
   * How many attachments came with the words.
   *
   * Nothing here can read one, and nothing here may describe one either, so the
   * only honest thing to pass on is that one exists. Akme decides what to say
   * about a message it has been told it is not seeing all of.
   */
  attachments: number;
  /**
   * What this repo noticed deterministically, ahead of any model.
   *
   * `bargaining` is Karim's zero-tolerance stop, and it stays here because a
   * detector that has to survive a model call is not a stop. Only the SENTENCE
   * moved: this reports what it saw, and the one writer decides the words.
   */
  hint?: 'bargaining';
}): Promise<DeskOutcome> {
  const base = optionalEnv('AKME_BASE_URL', 'http://localhost:3001').replace(/\/$/, '');

  let token: string;
  try {
    token = signToken({ scope: 'desk_inbound' }, env('DESK_INBOUND_SECRET'), TOKEN_TTL_SECONDS);
  } catch {
    // No secret configured means the desk was never set up here. That is the
    // pre-desk state, and it is a configuration fact rather than an outage, so
    // it declines with no words: nothing here is entitled to answer instead.
    return { kind: 'declined', reason: 'no desk secret is configured here', reply: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/desk/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        phone: input.phone,
        channel: 'sms',
        body: input.body,
        displayName: input.displayName,
        sourceId: input.messageId,
        attachments: input.attachments,
        // Omitted rather than sent as null, so the field's presence is the
        // signal and the door does not have to read a null as an absence.
        ...(input.hint ? { hint: input.hint } : {}),
      }),
      signal: controller.signal,
    });

    // 401 and 503 are configuration, not a decision: a wrong secret or an unset
    // one on the Akme side. Reported as unreachable so somebody fixes it, rather
    // than as a decline that would hide a broken door behind a working fallback
    // for as long as nobody looked.
    if (res.status === 401 || res.status === 503) {
      return { kind: 'unreachable', reason: `Akme answered ${res.status}` };
    }
    if (!res.ok) return { kind: 'declined', reason: `Akme answered ${res.status}`, reply: null };

    const json = (await res.json().catch(() => ({}))) as {
      handled?: boolean;
      reply?: string | null;
      reason?: string | null;
    };
    const reply = typeof json.reply === 'string' ? json.reply.trim() : '';

    // A decline can still carry words. Akme answers `{handled:false}` with a
    // holding line whenever a customer is left waiting, and with a null reply
    // when nobody is, so both halves of the field are meaningful.
    if (!json.handled) return { kind: 'declined', reason: json.reason ?? null, reply: reply || null };

    return reply ? { kind: 'answer', reply } : { kind: 'silent' };
  } catch (err) {
    const reason =
      err instanceof Error && err.name === 'AbortError'
        ? `Akme did not answer in ${TIMEOUT_MS / 1000}s`
        : String(err);
    return { kind: 'unreachable', reason };
  } finally {
    clearTimeout(timer);
  }
}
