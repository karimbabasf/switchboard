/**
 * Hand-written replies for the questions we get constantly.
 *
 * Two reasons this exists rather than asking the model every time:
 *
 *  1. COST. "What do you sell?" is the most common text we get and its answer
 *     never changes. Paying for a completion to regenerate a fixed list is
 *     waste, and every regeneration is a fresh chance to word it differently.
 *  2. CORRECTNESS. These are the sentences a customer screenshots. A template
 *     is reviewed once and then it is right forever; a generated reply is right
 *     on average.
 *
 * The model still handles everything a template does not match. This is a fast
 * path in front of it, not a replacement for it.
 *
 * TEMPLATES ARE NOT RUN THROUGH THE MODEL-OUTPUT GUARDS in lib/agent/sms.ts,
 * and that is deliberate. Those guards (money, day-commitment) exist to catch a
 * model that drifted, and they are deliberately blunt: the quote reply says the
 * word "quote", which the money guard matches on. A human wrote and reviewed
 * every string in this file, so the guard has nothing to add and would only
 * block the correct answer. Anything generated still goes through them.
 *
 * The quote reply is assembled from lib/agent/intake.ts rather than fixed, and
 * that does not weaken the sentence above: the clauses it is built from are
 * fixed and reviewed here, and the only thing the customer's own message
 * decides is WHICH of them are left to ask. No text a customer wrote is ever
 * echoed back out of one.
 *
 * GSM-7 ONLY. Every character here must be in the GSM 03.38 alphabet or the
 * whole message silently becomes UCS-2 and the segment size drops from 160
 * characters to 70, roughly doubling the cost and the delivery risk. That means
 * straight quotes, a plain hyphen, and no emoji. `assertGsm7` in the test suite
 * is what stops this being a comment nobody honours.
 */

import { BUSINESS } from './brief';
import { intakeAsk, type KnownCustomer } from './intake';

/** Where a quote actually happens. The phone line never produces one. */
export const QUOTE_CHANNELS = Object.freeze({
  site: BUSINESS.site,
  email: BUSINESS.email,
  /** Replying to our own number is the third channel, hence no value here. */
  text: 'reply to this text',
});

export type TemplateKey = 'catalogue' | 'hours' | 'quote' | 'contact' | 'fulfilment' | 'help';

/**
 * The product list, spoken of the way a customer asks for it: what it is called
 * and what you get, no specs and no prices. Specs are a follow-up question, and
 * putting all six on a text turns it into four segments nobody reads.
 */
const CATALOGUE_SMS = [
  `${BUSINESS.name} stocks:`,
  '',
  ...BUSINESS.products.map((p) => `- ${p.name} (by the ${p.unit}, ${p.contents})`),
  '',
  `Sizes and full specs on request. For a quote: ${QUOTE_CHANNELS.site}, or reply here with what you need.`,
].join('\n');

const HOURS_SMS = `We are open ${BUSINESS.hours}. ${BUSINESS.fulfilment}`;

/**
 * The single most important template, and the only one that is not a fixed
 * string. Every pricing question, on any channel, ends here: we do not quote in
 * the channel, we take the request into the one place a human prices it.
 *
 * IT USED TO BE FIXED AND IT ASKED FOR ONE THING. It read "Reply here with the
 * items and quantities you need", so a human then had to ask for the name, then
 * the address, then the email, one text at a time, which is exactly what Karim
 * said to stop doing on 2026-08-18. The items are one of four things a quote
 * needs and there is no reason to learn them one per round trip.
 *
 * So it is assembled instead: see lib/agent/intake.ts for what the four are and
 * where each one is read off Akme. A caller that knows nothing gets all four,
 * a caller that knows three gets a one-clause question, and nobody is asked for
 * something they have already given us.
 */
function quoteSms(known: KnownCustomer): string {
  return intakeAsk(known);
}

/**
 * "Where are you" is a will call question nine times out of ten, and this used to
 * answer it with a phone number. The address is the answer.
 */
const CONTACT_SMS = [
  `${BUSINESS.name}`,
  `Will call: ${BUSINESS.willCallAddress}`,
  `Phone: ${BUSINESS.phone}`,
  `Email: ${BUSINESS.email}`,
  `Site: ${BUSINESS.site}`,
  `Open ${BUSINESS.hours}.`,
].join('\n');

/**
 * Both fulfilment methods, as policy.
 *
 * Every sentence here is a standing fact that is true before anyone texts, which
 * is the only reason it is safe to send unread. It deliberately ends by handing
 * the specific case back: the cadence is ours to state, "yours goes out Thursday"
 * is a promise about one order and belongs to whoever taps Send.
 */
const FULFILMENT_SMS = [
  // Answers both halves regardless of which half was asked, and in the same
  // words the email opens its fulfilment block with (Akme lib/ops/crm/compose.ts,
  // Karim's wording 2026-08-11). A bare "We do both" was tried and read as a
  // non-sequitur to somebody who had only asked about delivery; naming both
  // halves is what fixes that, not the extra words around it.
  `We do both will call and delivery. Will call pickup is ${BUSINESS.willCallAddress}, ${BUSINESS.hours}.`,
  'For delivery, orders in by Tuesday go out on Thursday.',
  'Tell us which you need and we will confirm it on your quote.',
].join(' ');

/**
 * The carrier-mandated answer to HELP, and the exact text declared on the 10DLC
 * campaign. If you change it here, change it on the campaign too: a registered
 * HELP reply that does not match what the number actually sends is the kind of
 * mismatch that gets a campaign pulled.
 *
 * The required parts, all present: who we are, what the messages are, how to
 * stop, that rates apply, and a way to reach a person.
 */
const HELP_SMS = [
  `${BUSINESS.name}: moving and packing supplies.`,
  'You are texting our order line. Msg and data rates may apply.',
  `Reply STOP to opt out. Call ${BUSINESS.phone} or email ${BUSINESS.email}.`,
].join(' ');

/**
 * Every template as a function of what we already know. Five of the six ignore
 * the argument, which is the honest shape: the hours are the hours whoever is
 * asking, and only the quote reply depends on the person it is going to.
 */
const TEMPLATES: Readonly<Record<TemplateKey, (known: KnownCustomer) => string>> = Object.freeze({
  catalogue: () => CATALOGUE_SMS,
  hours: () => HOURS_SMS,
  quote: quoteSms,
  contact: () => CONTACT_SMS,
  fulfilment: () => FULFILMENT_SMS,
  help: () => HELP_SMS,
});

/**
 * `known` is optional so every existing caller keeps working unchanged, and
 * defaults to "we hold nothing", which asks for everything. That default is the
 * safe direction: asking a known customer for their name is clumsy, quoting
 * against an address nobody gave us is not.
 */
export function renderTemplate(key: TemplateKey, known: KnownCustomer = {}): string {
  return TEMPLATES[key](known);
}

/**
 * Ordered most specific first. A text reading "what do you charge for tape"
 * is a pricing question that happens to name a product, so `quote` has to be
 * tested before `catalogue` or it answers the wrong question.
 *
 * Deliberately conservative: these patterns only fire on messages that are
 * plainly one of these four questions. Anything with extra intent in it
 * ("do you have tape and can you deliver Thursday") should MISS and fall
 * through to the model, which is why there is no bare `/tape/` pattern here.
 */
const MATCHERS: ReadonlyArray<{ key: TemplateKey; pattern: RegExp }> = [
  {
    key: 'quote',
    pattern:
      /\b(quote|pricing|price list|how much|what.{0,10}(cost|charge)|cost of|rates?)\b/i,
  },
  {
    key: 'hours',
    pattern: /\b(hours?|what time|when.{0,15}(open|close)|are you open|still open|open today)\b/i,
  },
  {
    key: 'catalogue',
    pattern:
      /\b(what.{0,15}(sell|stock|carry|have|offer)|product list|catalog(ue)?|inventory|full list|item list)\b/i,
  },
  {
    key: 'fulfilment',
    pattern:
      /\b(do you deliver|deliver to|delivery option|ship to|do you ship|will.?call|curbside|pick.?up|pick it up|come get)\b/i,
  },
  {
    key: 'contact',
    pattern: /\b(address|where are you|located|location|email address|your email|phone number)\b/i,
  },
];

/**
 * The message is about THEIR order, not about how we work.
 *
 * "Is my order ready to pick up" contains "pick up" and is not a fulfilment
 * question at all: it is an order status question, and this agent has no order
 * lookup. Without this it auto-sent the will call address and hours to someone
 * asking whether their pallet was packed, which reads as yes.
 */
const ABOUT_THEIR_ORDER =
  /\b(my|our|their) (order|stuff|shipment|delivery|pallet|stock|invoice|quote|things)\b|\bis it ready\b|\bready yet\b/i;

/**
 * Turns a policy question into a promise question.
 *
 * "Do you deliver" is a standing fact and this file can answer it. "Can you
 * deliver Thursday" is the same words plus a commitment, and the answer to that
 * one depends on stock, on the run, and on whoever is loading the truck. The
 * templates skip every model guard by design, so a fulfilment template that fired
 * on the second question would auto-send a confident policy statement to someone
 * who asked whether their pallet makes it before the weekend, and they would read
 * it as yes.
 *
 * Only gates `fulfilment`. `hours` is unaffected: "what time do you open
 * tomorrow" is still just the hours.
 */
const ASKS_TO_COMMIT =
  /\b(today|tonight|tomorrow|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday|this week|next week|weekend|asap|rush|urgent|by (the|then|noon|end)|when (will|can|would)|how soon|how long|eta|what day|which day|in time|before)\b/i;

/**
 * Returns the template that answers this message outright, or null if the model
 * should handle it. A miss is the safe outcome and costs one completion; a
 * wrong hit sends a confident answer to a question nobody asked, so every
 * pattern above is written to under-match.
 */
export function matchTemplate(body: string | null | undefined): TemplateKey | null {
  const text = body?.trim();
  if (!text) return null;
  // A long message is a story, not one of these four questions, even when it
  // contains the words. Templates answer questions; paragraphs need the model.
  if (text.length > 160) return null;

  const key = MATCHERS.find((m) => m.pattern.test(text))?.key ?? null;
  if (key === 'fulfilment' && (ASKS_TO_COMMIT.test(text) || ABOUT_THEIR_ORDER.test(text))) return null;
  return key;
}

/**
 * Characters outside GSM 03.38 that a writer produces without noticing, mostly
 * by pasting from a document that auto-corrected the punctuation.
 */
export function nonGsm7(text: string): string[] {
  const GSM7 =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
    '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà' +
    '^{}\\[~]|€';
  return [...new Set([...text].filter((c) => !GSM7.includes(c)))];
}
