/**
 * The quote token: ten minutes, once, and never a price twice.
 *
 * `price_order` says a subtotal out loud and hands back one of these.
 * `send_order_link` is the only thing that can spend it. Two properties matter
 * and both are structural rather than prompted:
 *
 *  - TEN MINUTES. A price said at the start of a call must not become a link
 *    sent twenty minutes later off a number the caller has stopped thinking
 *    about. Past ten minutes the tool prices it again, out loud, and the caller
 *    hears the figure they are agreeing to.
 *  - ONCE. Spending it is a conditional UPDATE keyed on `used_at is null`, the
 *    same compare-and-set the worker claims rows with (lib/worker/run.ts). Two
 *    tool calls racing on one token both try it, exactly one UPDATE matches, and
 *    the loser is told the link is already on its way rather than sending a
 *    second text.
 *
 * The row also BINDS the quote to the number that was on the call when it was
 * priced. Telnyx sends no call identity with a tool call, so `caller_phone` is
 * whatever the model wrote; `price_order` checks it against the live call before
 * it ever gets here, and this binding is what stops a token proven for one call
 * being spent on another.
 */

import { db } from '../db';
import { newToken } from './token';
import type { Fulfilment, OrderLine, ShortStock } from './pricing';

/** Ten minutes. Long enough to talk it over, short enough that a price is current. */
export const QUOTE_TTL_MS = 10 * 60 * 1000;

export interface QuoteRow {
  token: string;
  call_id: string | null;
  caller_phone: string;
  lines: OrderLine[];
  fulfilment: Fulfilment;
  subtotal_cents: number;
  short_stock: ShortStock[];
  created_at: string;
  expires_at: string;
  used_at: string | null;
}

export type QuoteVerdict =
  | { ok: true; quote: QuoteRow }
  | { ok: false; reason: 'expired' | 'used' };

/**
 * Whether this quote may be spent, given the clock and the number on the call.
 *
 * A MISSING ROW READS AS EXPIRED, and so does a token that belongs to a
 * different call. Both are the same sentence to the caller, which is the point:
 * there is nothing to learn from the difference, and a token that was never
 * issued should not be distinguishable from one that has aged out.
 */
export function quoteVerdict(
  row: QuoteRow | null,
  nowMs: number,
  callerPhone?: string,
): QuoteVerdict {
  if (!row) return { ok: false, reason: 'expired' };
  if (row.used_at) return { ok: false, reason: 'used' };
  if (callerPhone && row.caller_phone !== callerPhone) return { ok: false, reason: 'expired' };

  const expires = Date.parse(row.expires_at);
  // An unreadable timestamp is a dead quote. Only a stamp we can positively
  // read counts as a live one, the same rule `offerWasAnswerable` follows.
  if (Number.isNaN(expires) || nowMs >= expires) return { ok: false, reason: 'expired' };

  return { ok: true, quote: row };
}

export interface NewQuote {
  callId: string | null;
  callerPhone: string;
  lines: OrderLine[];
  fulfilment: Fulfilment;
  subtotalCents: number;
  shortStock: ShortStock[];
}

export async function saveQuote(input: NewQuote, nowMs = Date.now()): Promise<QuoteRow> {
  const token = newToken();
  const created = new Date(nowMs);
  const { data, error } = await db()
    .from('phone_order_quotes')
    .insert({
      token,
      call_id: input.callId,
      caller_phone: input.callerPhone,
      lines: input.lines,
      fulfilment: input.fulfilment,
      subtotal_cents: input.subtotalCents,
      short_stock: input.shortStock,
      created_at: created.toISOString(),
      expires_at: new Date(nowMs + QUOTE_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw new Error(`saveQuote: ${error.message}`);
  return data as QuoteRow;
}

/**
 * Spends the token, or says why it could not.
 *
 * The UPDATE is the claim: it matches only an unspent, unexpired quote bound to
 * this caller, so the check and the spend are one statement and cannot be raced
 * apart. Only when it matches nothing do we read the row back, and that read
 * exists purely to pick which sentence the caller hears.
 */
export async function claimQuote(
  token: string,
  callerPhone: string,
  nowMs = Date.now(),
): Promise<QuoteVerdict> {
  const nowIso = new Date(nowMs).toISOString();

  const claimed = await db()
    .from('phone_order_quotes')
    .update({ used_at: nowIso })
    .eq('token', token)
    .eq('caller_phone', callerPhone)
    .is('used_at', null)
    .gt('expires_at', nowIso)
    .select('*')
    .maybeSingle();
  if (claimed.error) throw new Error(`claimQuote: ${claimed.error.message}`);
  if (claimed.data) return { ok: true, quote: claimed.data as QuoteRow };

  const read = await db().from('phone_order_quotes').select('*').eq('token', token).maybeSingle();
  if (read.error) throw new Error(`claimQuote read back: ${read.error.message}`);
  return quoteVerdict((read.data as QuoteRow | null) ?? null, nowMs, callerPhone);
}
