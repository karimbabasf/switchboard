/**
 * The two fixed strings this repo is still allowed to send, and why each one is
 * still here.
 *
 * THERE WERE SIX. Five of them answered a customer's text: the catalogue, the
 * hours, the contact card, the fulfilment policy and the quote ask. All of that
 * was deleted on 2026-08-24, along with the matcher that chose between them and
 * the model that wrote whatever they missed.
 *
 * The reason is not that they were bad sentences. It is that they were a SECOND
 * WRITER. Akme holds the orders, the prices, the customer records and one copy
 * of the rules, and it answers the same customer by email. Two brains writing at
 * one person is the failure the 2026-08-20 spec names: the same question got two
 * different answers depending on the channel, every rule change needed both
 * repos, and a decline from Akme's desk was read here as permission to draft a
 * form answer, which is where "the team will price it" came from. Akme writes
 * the words now. This file writes none.
 *
 * What is left:
 *
 *  1. HELP_SMS. A CARRIER OBLIGATION, and the exact text declared on the 10DLC
 *     campaign. It has to go out unread by a human, because a HELP that waits
 *     for a tap is a HELP that failed.
 *  2. CATALOGUE_SMS. Not an answer to a text at all. The voice agent's
 *     text_me_the_list sends it mid call (lib/agent/tools.ts), which is a
 *     different path with a caller on the line, and repointing that tool is out
 *     of scope. Nothing on the inbound reply path reaches it.
 *
 * GSM-7 ONLY. Every character here must be in the GSM 03.38 alphabet or the
 * whole message silently becomes UCS-2 and the segment size drops from 160
 * characters to 70, roughly doubling the cost and the delivery risk. That means
 * straight quotes, a plain hyphen, and no emoji. `nonGsm7` in the test suite is
 * what stops this being a comment nobody honours.
 */

import { BUSINESS } from './brief';

/** Where a quote actually happens. The phone line never produces one. */
export const QUOTE_CHANNELS = Object.freeze({
  site: BUSINESS.site,
  email: BUSINESS.email,
  /** Replying to our own number is the third channel, hence no value here. */
  text: 'reply to this text',
});

export type TemplateKey = 'catalogue' | 'help';

/**
 * The product list, spoken of the way a customer asks for it: what it is called
 * and what you get, no specs and no prices. Specs are a follow-up question, and
 * putting all six on a text turns it into four segments nobody reads.
 *
 * Reached only from the phone line. A texted "what do you sell" goes to Akme
 * like every other question.
 */
const CATALOGUE_SMS = [
  `${BUSINESS.name} stocks:`,
  '',
  ...BUSINESS.products.map((p) => `- ${p.name} (by the ${p.unit}, ${p.contents})`),
  '',
  `Sizes and full specs on request. For a quote: ${QUOTE_CHANNELS.site}, or reply here with what you need.`,
].join('\n');

/**
 * The carrier-mandated answer to HELP, and the exact text declared on the 10DLC
 * campaign. If you change it here, change it on the campaign too: a registered
 * HELP reply that does not match what the number actually sends is the kind of
 * mismatch that gets a campaign pulled.
 *
 * The required parts, all present: who we are, what the messages are, how to
 * stop, that rates apply, and a way to reach a person.
 */
export const HELP_SMS = [
  `${BUSINESS.name}: moving and packing supplies.`,
  'You are texting our order line. Msg and data rates may apply.',
  `Reply STOP to opt out. Call ${BUSINESS.phone} or email ${BUSINESS.email}.`,
].join(' ');

/** Exported so a test can assert what is in here, which is the point of the file. */
export const TEMPLATES: Readonly<Record<TemplateKey, string>> = Object.freeze({
  catalogue: CATALOGUE_SMS,
  help: HELP_SMS,
});

export function renderTemplate(key: TemplateKey): string {
  return TEMPLATES[key];
}

/**
 * Whether a spoken or written message is plainly a pricing request.
 *
 * NOT A TEMPLATE SELECTOR ANY MORE, despite the name, which is kept because the
 * one caller left is the phone line and repointing voice is out of scope here.
 * `take_message` (lib/agent/tools.ts) uses it to decide whether a message a
 * caller dictated also belongs on the quote queue.
 *
 * There were five patterns and `quote` was always first, so `find` returned it
 * whenever it matched whatever else did. Deleting the other four therefore
 * cannot change the answer to the only question anybody still asks this.
 *
 * Deliberately conservative: it fires only on a message that is plainly a
 * pricing question. A miss files the message as a plain message, which is safe.
 */
const QUOTE = /\b(quote|pricing|price list|how much|what.{0,10}(cost|charge)|cost of|rates?)\b/i;

export function matchTemplate(body: string | null | undefined): 'quote' | null {
  const text = body?.trim();
  if (!text) return null;
  // A long message is a story, not a question, even when it contains the words.
  if (text.length > 160) return null;
  return QUOTE.test(text) ? 'quote' : null;
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
