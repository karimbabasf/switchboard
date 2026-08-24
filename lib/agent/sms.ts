/**
 * The compliance machinery on the SMS line, and nothing else.
 *
 * THIS FILE USED TO BE THE SMS AGENT. It classified an inbound text, matched it
 * against six templates, called a model for whatever they missed, and ran a
 * stack of guards over the drafted words to decide whether to send them unread.
 * All of that was deleted on 2026-08-24, guards included: they existed to hold
 * back a drafter that no longer exists, and a guard with nothing behind it reads
 * like protection while protecting nothing.
 *
 * What replaced it is one door. Akme holds the orders, the prices, the customer
 * records and one copy of the rules, and it already answers the same customer by
 * email. Every sentence a customer reads is written there now, by the deal
 * engine or by the LLM desk, and this repo puts it on the wire. Two brains
 * writing at one person is the failure the 2026-08-20 spec names.
 *
 * What is left is the part a CARRIER requires rather than the part we chose:
 * the three keyword classes, the HELP reply registered on the 10DLC campaign,
 * and the deterministic bargaining stop, which stays here because a stop that
 * has to survive a model call is not a stop.
 */

import { renderTemplate } from './templates';

/**
 * The three carrier keyword classes, which are three different things and were
 * all one regex until 2026-08-03.
 *
 * That regex was named OPT_OUT and matched `help`, `start` and `unstop` as well
 * as `stop`. Everything it caught returned intent `opt_out`, and the handler
 * stamps `opted_out_at` and sends nothing, so **texting HELP silently
 * blacklisted the customer forever**, and so did START and UNSTOP, which are
 * opt-INS. Found while preparing the 10DLC campaign, which makes you declare
 * this exact behaviour to the carriers.
 *
 * Carriers answer these at the network level on a registered campaign, so our
 * job is mostly to not contradict them: never text into a STOP, always let a
 * START undo it, and never treat a request for help as a request to leave.
 */
const OPT_OUT = /^\s*(stop|stopall|unsubscribe|cancel|end|quit|revoke|optout|opt out)\s*$/i;
const OPT_IN = /^\s*(start|unstop|optin|opt in|subscribe)\s*$/i;
const HELP = /^\s*(help|info)\s*$/i;

/**
 * Whether a text is one of the three carrier keywords rather than something the
 * customer said to us.
 *
 * Exported so lib/telnyx/sms.ts can keep these off the shared crm_timeline
 * without a second copy of the patterns. What one copy of them drifting already
 * cost is written above; a reader of the timeline asking the same question would
 * be the third place to answer it, and the first two disagreeing is what caused
 * the 2026-08-03 bug.
 *
 * All three classes together, deliberately. They are three different
 * INSTRUCTIONS, which is why carrierIntent keeps them apart, but to a thread of
 * conversation they are the same thing: a command aimed at the compliance
 * machinery, not a message to the business.
 */
export function isCarrierKeyword(body: string | null | undefined): boolean {
  return carrierIntent(body) !== null;
}

export type CarrierIntent = 'opt_out' | 'opt_in' | 'help';

/**
 * Which of the three a text is, or null for a customer talking to us.
 *
 * The three-way split is the whole point and is why this is not a boolean: STOP
 * stamps and stays quiet, START clears the stamp and stays quiet, and HELP
 * answers. One regex for all three is the 2026-08-03 bug above.
 */
export function carrierIntent(body: string | null | undefined): CarrierIntent | null {
  const text = body?.trim() ?? '';
  if (!text) return null;
  if (OPT_OUT.test(text)) return 'opt_out';
  if (OPT_IN.test(text)) return 'opt_in';
  if (HELP.test(text)) return 'help';
  return null;
}

export interface CarrierDraft {
  intent: CarrierIntent;
  /** Empty for both opt branches: the carrier sends its own confirmation. */
  reply: string;
  autoSend: boolean;
}

/**
 * The only reply this repo still writes, and it writes it because a carrier
 * requires it.
 *
 * HELP must go out unread by a human: a HELP that waits for a tap is a HELP that
 * failed. Both opt branches send NOTHING. On a registered campaign the carrier
 * sends its own confirmation, and two messages for one word reads as a system
 * that did not understand.
 */
export function draftCarrierReply(intent: CarrierIntent): CarrierDraft {
  if (intent === 'help') return { intent, reply: renderTemplate('help'), autoSend: true };
  return { intent, reply: '', autoSend: false };
}

/**
 * Bargaining, caught deterministically on the INBOUND text, before anything can
 * answer it.
 *
 * Karim's rule is zero tolerance: the moment a customer starts to negotiate, a
 * human is pinged and the machine stops talking. It stays in this repo rather
 * than moving with everything else, because it has to run before the message is
 * handed anywhere at all, and a stop that depends on a model call having gone
 * well is not a stop.
 *
 * Deliberately broad, and it fails OPEN the way notify.ts does rather than
 * closed the way a send guard would. A false positive costs one glance at a
 * card. A false negative is the machine haggling on the company's behalf.
 */
const BARGAINING = new RegExp(
  [
    'discount',
    'bargain',
    'haggl',
    'negotiat',
    'best price',
    'best you can do',
    'better price',
    'better deal',
    'better offer',
    'price match',
    'match that price',
    'price break',
    'bulk pricing',
    'bulk rate',
    'too expensive',
    'too pricey',
    'too high',
    'too much',
    'cheaper',
    'come down',
    'knock off',
    'do better',
    'your best',
    'beat that',
    'beat their',
    'any deals',
    'any deal',
  ]
    // Written as plain phrases and joined here so the list stays readable and a
    // new phrase is a one-line change. \s+ so "best  price" across a line break
    // still matches.
    .map((phrase) => phrase.replace(/ /g, '\\s+'))
    .join('|'),
  'i',
);

/**
 * Whether the customer has started to negotiate.
 *
 * A DETECTOR ONLY, as of 2026-08-24. It used to return a holding sentence of its
 * own. That sentence moved to Akme: this reports what it saw through the desk's
 * `hint` field, and the one writer decides what a person opening a negotiation
 * reads.
 */
export function isBargaining(body: string | null | undefined): boolean {
  const text = body?.trim() ?? '';
  return text.length > 0 && BARGAINING.test(text);
}
