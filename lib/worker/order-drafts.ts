/**
 * The draft order lifecycle, swept by /api/worker every two minutes.
 *
 * ONE NUDGE AT TWENTY-FOUR HOURS, AND THE LINK IS DEAD AT FORTY-EIGHT.
 *
 * The forty-eight hour half needs no work here: `expires_at` is the truth and
 * `draftState` in lib/orders/drafts.ts is the one place that reads it, so the
 * page renders a dead link without anything having to run. A sweep that stamped
 * rows "expired" would be a second copy of that answer, and the two would
 * disagree the first time a tick was late.
 *
 * The nudge half does need work, and the rule that shapes it is "never twice".
 * The stamp is written BEFORE the send, in a conditional UPDATE keyed on
 * `nudged_at is null`, which is the same compare-and-set the call pipeline
 * claims rows with. Two overlapping ticks therefore send one text between them.
 * The cost of that ordering is a nudge that was stamped and then failed to go
 * out; the cost of the other ordering is a customer texted twice by two ticks
 * that both read a null stamp. Karim's rule picks the first.
 */

import { claimNudge, draftsDueForNudge, orderLinkFor, type PhoneOrderDraft } from '../orders/drafts';
import { renderRelayTemplate } from '../agent/templates';

export interface DraftSweepResult {
  /** Rows that were due and got their stamp. */
  nudged: number;
  /** Stamped, but the text did not go out. Visible on purpose; it is not retried. */
  unsent: number;
}

export interface DraftSweepOptions {
  /** Injectable so a test does not need Telnyx. Defaults to the one SMS door. */
  sendText?: (phone: string, body: string) => Promise<void>;
  /** Injectable so a test does not need AKME_ORDER_BASE_URL. */
  orderLink?: (token: string) => string;
  now?: () => number;
}

async function defaultSend(phone: string, body: string): Promise<void> {
  // Lazy, like every other cross-module reach in this directory: the worker
  // should not fail to boot because a neighbouring module is mid-edit.
  const { sendSms } = await import('../telnyx/sms');
  await sendSms(phone, body);
}

export async function sweepOrderDrafts(
  limit: number,
  options: DraftSweepOptions = {},
): Promise<DraftSweepResult> {
  const now = options.now?.() ?? Date.now();
  const send = options.sendText ?? defaultSend;
  const link = options.orderLink ?? orderLinkFor;
  const result: DraftSweepResult = { nudged: 0, unsent: 0 };

  const due = await draftsDueForNudge(limit, now);

  for (const draft of due) {
    const claimed = await claimStamp(draft, now);
    if (!claimed) continue; // another tick got there first

    result.nudged += 1;

    const body = renderRelayTemplate('order_nudge', { url: link(claimed.token) });
    if (!body) {
      // Configuration, not data: AKME_ORDER_BASE_URL produced something that
      // cannot go in a text. Loud, and not retried, because a retry would build
      // the same broken URL.
      console.error('[worker] order nudge could not render; check AKME_ORDER_BASE_URL');
      result.unsent += 1;
      continue;
    }

    try {
      await send(claimed.caller_phone, body);
    } catch (err) {
      // Swallowed on purpose. The stamp is already written and the rule is one
      // nudge, so this row is done either way; throwing would take the rest of
      // the sweep down with it.
      console.error(`[worker] order nudge to ${claimed.caller_phone} failed:`, err);
      result.unsent += 1;
    }
  }

  return result;
}

async function claimStamp(draft: PhoneOrderDraft, nowMs: number): Promise<PhoneOrderDraft | null> {
  try {
    return await claimNudge(draft, nowMs);
  } catch (err) {
    console.error(`[worker] could not claim the nudge on draft ${draft.id}:`, err);
    return null;
  }
}
