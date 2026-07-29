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
 * model that drifted, and they are deliberately blunt: `QUOTE_SMS` says the word
 * "quote", which the money guard matches on. A human wrote and reviewed every
 * string in this file, so the guard has nothing to add and would only block the
 * correct answer. Anything generated still goes through them.
 *
 * GSM-7 ONLY. Every character here must be in the GSM 03.38 alphabet or the
 * whole message silently becomes UCS-2 and the segment size drops from 160
 * characters to 70, roughly doubling the cost and the delivery risk. That means
 * straight quotes, a plain hyphen, and no emoji. `assertGsm7` in the test suite
 * is what stops this being a comment nobody honours.
 */

import { BUSINESS } from './brief';

/** Where a quote actually happens. The phone line never produces one. */
export const QUOTE_CHANNELS = Object.freeze({
  site: BUSINESS.site,
  email: BUSINESS.email,
  /** Replying to our own number is the third channel, hence no value here. */
  text: 'reply to this text',
});

export type TemplateKey = 'catalogue' | 'hours' | 'quote' | 'contact';

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
 * The single most important template. Every pricing question, on any channel,
 * ends here: we do not quote in the channel, we take the request into the one
 * place a human prices it.
 */
const QUOTE_SMS = [
  'Happy to get you a quote. Reply here with the items and quantities you need, or build it at',
  `${QUOTE_CHANNELS.site} and we will send pricing over.`,
].join(' ');

const CONTACT_SMS = [
  `${BUSINESS.name}`,
  `Phone: ${BUSINESS.phone}`,
  `Email: ${BUSINESS.email}`,
  `Site: ${BUSINESS.site}`,
  `Open ${BUSINESS.hours}.`,
].join('\n');

const TEMPLATES: Readonly<Record<TemplateKey, string>> = Object.freeze({
  catalogue: CATALOGUE_SMS,
  hours: HOURS_SMS,
  quote: QUOTE_SMS,
  contact: CONTACT_SMS,
});

export function renderTemplate(key: TemplateKey): string {
  return TEMPLATES[key];
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
    key: 'contact',
    pattern: /\b(address|where are you|location|email address|your email|phone number)\b/i,
  },
];

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

  return MATCHERS.find((m) => m.pattern.test(text))?.key ?? null;
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
