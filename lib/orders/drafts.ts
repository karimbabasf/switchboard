/**
 * The draft order: forty-eight hours to confirm, one nudge at twenty-four.
 *
 * This is the object the phone call actually produces. The caller hears a
 * subtotal, agrees to a text, and this row is what the link in that text points
 * at. Akme renders it as a pre filled form on `/order/<token>` and stamps
 * `confirmed_at` and `order_reference` back onto it when they submit. This repo
 * owns the row and writes everything else on it; Akme reads it and writes only
 * those two columns.
 *
 * AN EXPIRED TOKEN IS A DEAD LINK, NEVER A FORM. `draftState` below is the one
 * place that decides, so the page, the nudge sweep and any future card all read
 * the same verdict off the same clock rather than each deciding for themselves.
 *
 * `large_order` FLAGS THE RECORD AND NOTHING ELSE. Karim, rule 9: no five
 * thousand dollar behaviour on the call. Nothing in lib/orders/pricing.ts reads
 * the threshold, and the only thing that will read it is the Telegram card that
 * does not exist yet.
 */

import { db } from '../db';
import { env } from '../env';
import { newToken } from './token';
import type { Fulfilment, OrderLine } from './pricing';

/** Rule 9's threshold, in cents. Five thousand dollars. */
export const LARGE_ORDER_CENTS = 500_000;

/** Forty-eight hours from the call, after which the link is dead. */
export const DRAFT_TTL_MS = 48 * 60 * 60 * 1000;

/** One SMS, at twenty-four hours, and never a second one. */
export const NUDGE_AFTER_MS = 24 * 60 * 60 * 1000;

export interface PhoneOrderDraft {
  id: string;
  token: string;
  call_id: string | null;
  caller_phone: string;
  lines: OrderLine[];
  fulfilment: Fulfilment;
  subtotal_cents: number;
  large_order: boolean;
  created_at: string;
  expires_at: string;
  nudged_at: string | null;
  confirmed_at: string | null;
  order_reference: string | null;
}

export function isLargeOrder(subtotalCents: number): boolean {
  return subtotalCents >= LARGE_ORDER_CENTS;
}

export type DraftState = 'live' | 'expired' | 'confirmed' | 'unknown';

/**
 * The one verdict on a token.
 *
 * CONFIRMED OUTRANKS EXPIRED. An order that went through and is then looked at
 * on day three is a finished order, not a dead link, and telling that customer
 * their link expired would be a lie about an order we are already fulfilling.
 *
 * An unreadable `expires_at` reads as expired, for the same reason a missing one
 * would: only a stamp we can positively read counts as a live link.
 */
export function draftState(draft: PhoneOrderDraft | null, nowMs: number): DraftState {
  if (!draft) return 'unknown';
  if (draft.confirmed_at) return 'confirmed';
  const expires = Date.parse(draft.expires_at);
  if (Number.isNaN(expires) || nowMs >= expires) return 'expired';
  return 'live';
}

/**
 * Whether this draft has earned its single nudge.
 *
 * Not due on a confirmed order (they have already done the thing we would be
 * asking for), not due on a dead one (there is nothing at the other end of the
 * link), and never due twice, which is what `nudged_at` is for.
 */
export function nudgeIsDue(draft: PhoneOrderDraft, nowMs: number): boolean {
  if (draft.nudged_at) return false;
  if (draftState(draft, nowMs) !== 'live') return false;
  const created = Date.parse(draft.created_at);
  if (Number.isNaN(created)) return false;
  return nowMs - created >= NUDGE_AFTER_MS;
}

/**
 * The link that goes in the text.
 *
 * AKME_ORDER_BASE_URL is the site the customer finishes on, which is not
 * necessarily AKME_BASE_URL: the deal engine and the storefront can be
 * different deployments, and pointing a customer's confirmation link at an
 * internal API host is the kind of mistake nobody notices until a text is out.
 */
export function orderLinkFor(token: string): string {
  return `${env('AKME_ORDER_BASE_URL').replace(/\/+$/, '')}/order/${token}`;
}

export interface NewDraft {
  callId: string | null;
  callerPhone: string;
  lines: OrderLine[];
  fulfilment: Fulfilment;
  subtotalCents: number;
}

export async function createDraft(input: NewDraft, nowMs = Date.now()): Promise<PhoneOrderDraft> {
  const { data, error } = await db()
    .from('phone_order_drafts')
    .insert({
      token: newToken(),
      call_id: input.callId,
      caller_phone: input.callerPhone,
      lines: input.lines,
      fulfilment: input.fulfilment,
      subtotal_cents: input.subtotalCents,
      large_order: isLargeOrder(input.subtotalCents),
      created_at: new Date(nowMs).toISOString(),
      expires_at: new Date(nowMs + DRAFT_TTL_MS).toISOString(),
    })
    .select('*')
    .single();
  if (error) throw new Error(`createDraft: ${error.message}`);
  return data as PhoneOrderDraft;
}

/**
 * What `/order/<token>` needs to know, in one read: the verdict and the row.
 *
 * The row comes back even when the verdict is `expired`, because a dead link
 * page that can say "this order was for four cases of tape, call us and we will
 * sort it" is worth more than one that can only say no.
 */
export async function lookupDraft(
  token: string,
  nowMs = Date.now(),
): Promise<{ state: DraftState; draft: PhoneOrderDraft | null }> {
  const { data, error } = await db()
    .from('phone_order_drafts')
    .select('*')
    .eq('token', token)
    .maybeSingle();
  if (error) throw new Error(`lookupDraft: ${error.message}`);
  const draft = (data as PhoneOrderDraft | null) ?? null;
  return { state: draftState(draft, nowMs), draft };
}

/**
 * Drafts that are old enough to nudge, oldest first.
 *
 * Filtered in the query rather than in JavaScript so a busy line does not pull
 * every open draft into memory every two minutes. `nudgeIsDue` still runs on
 * each row, because the query and the rule must agree and only one of them is
 * under test.
 */
export async function draftsDueForNudge(limit: number, nowMs = Date.now()): Promise<PhoneOrderDraft[]> {
  const nowIso = new Date(nowMs).toISOString();
  const { data, error } = await db()
    .from('phone_order_drafts')
    .select('*')
    .is('confirmed_at', null)
    .is('nudged_at', null)
    .lte('created_at', new Date(nowMs - NUDGE_AFTER_MS).toISOString())
    .gt('expires_at', nowIso)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`draftsDueForNudge: ${error.message}`);
  return ((data ?? []) as PhoneOrderDraft[]).filter((draft) => nudgeIsDue(draft, nowMs));
}

/**
 * Claims the single nudge, the same compare-and-set the call pipeline claims
 * rows with. STAMPED BEFORE THE SEND, deliberately: the rule is one nudge and
 * never two, so the failure we choose is a nudge that was stamped and did not
 * go out, not a customer texted twice because a retry beat the stamp.
 */
export async function claimNudge(
  draft: PhoneOrderDraft,
  nowMs = Date.now(),
): Promise<PhoneOrderDraft | null> {
  const { data, error } = await db()
    .from('phone_order_drafts')
    .update({ nudged_at: new Date(nowMs).toISOString() })
    .eq('id', draft.id)
    .is('nudged_at', null)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`claimNudge: ${error.message}`);
  return (data as PhoneOrderDraft | null) ?? null;
}
