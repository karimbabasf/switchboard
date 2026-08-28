/**
 * What `send_order_link` says when it will not send, and why every one of these
 * is a sentence rather than a status.
 *
 * Copied, deliberately, from Akme's `lib/ops/agent/tools/start-order.ts`
 * (WHAT_TO_DO_NEXT). A bare `{sent: false, reason: "expired"}` is a verdict with
 * no next move in it. On 2026-08-24 a model handed exactly that read it as a
 * tool that had broken rather than a decision it had to act on: it called the
 * tool four times, invented a tool that does not exist, ran out of rounds and
 * escalated without answering anybody. The `reason` is for us, for the logs and
 * for the tests. These strings are the half that was missing, and they are for
 * the model AND for the caller, because on a phone line the tool's answer is
 * spoken out loud the moment it arrives.
 *
 * Each one says the same three things, in this order: nothing was sent, what
 * happens now, and whether calling this tool again in THIS turn can work. The
 * third is what stops the retry loop. For `already_used` and `not_this_caller`
 * no input can change until the caller says something new, so a second call is
 * guaranteed to refuse identically, and the sentence says so.
 *
 * NONE OF THESE WEAKEN THE GUARD. Every refusal still refuses exactly what it
 * refused before; what changes is that the model is told how to reach a
 * legitimate send instead of being left to guess.
 */

export type SendLinkRefusal =
  /** No quote has been priced, so there is nothing to send. */
  | 'no_token'
  /** The quote is past its ten minutes, was never issued, or belongs elsewhere. */
  | 'expired'
  /** Single use, and it has been used. The text is already on its way. */
  | 'already_used'
  /** The number is not the one on this call, so the SMS door stays shut. */
  | 'not_this_caller'
  /** The carrier refused the message. */
  | 'sms_failed';

export const SEND_LINK_NEXT_MOVE: Readonly<Record<SendLinkRefusal, string>> = Object.freeze({
  no_token:
    'I have not totalled anything up yet, so there is nothing for me to send. Tell me which ' +
    'products you need and how many of each, and I will price it and text you the link.',
  expired:
    'That price is more than ten minutes old now, so I will not send it as it stands. Give me ' +
    'the quantities once more and I will total it up fresh and text you the link right away.',
  already_used:
    'That link has already gone out to you, so I have not sent a second one. Give it a minute ' +
    'and check your texts, and if it has not arrived I can take a message and have someone ' +
    'follow it up.',
  not_this_caller:
    'I can only text the number you are calling from, so I have not sent anything. If you want ' +
    'it on a different line, I can take a message and have someone send it across.',
  sms_failed:
    'That text would not go through to your phone. You can order at Acme U S A dot com, or I ' +
    'can take a message and have someone send it across for you.',
});

export function refuseSendLink(reason: SendLinkRefusal): { speech: string } {
  return { speech: SEND_LINK_NEXT_MOVE[reason] };
}
