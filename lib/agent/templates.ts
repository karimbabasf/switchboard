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

/**
 * The three messages Akme may send through this repo's number, and the reason
 * they are names rather than words.
 *
 * Akme has no SMS sender. It gets one at POST /api/relay/sms, so a recognition
 * code goes over the 10DLC registered number instead of a second, unregistered
 * one. The door takes a TEMPLATE NAME AND VARIABLES, never a body: if Akme
 * could post text, then anything that reached Akme's desk with an instruction
 * in it would have a path to Akme's customers over our registered number, and
 * the campaign that gets pulled would be ours.
 *
 * So the words live here, in the repo that holds the Telnyx credential and the
 * carrier obligation. That is not the second writer this file's header warns
 * about: Akme still decides WHETHER to send and to whom, and these three are
 * transactional strings with no opinion in them, not answers to a customer.
 *
 * GSM-7 like everything else here, and the variables are held to the same rule,
 * because a code or a URL with a curly quote in it silently turns a one segment
 * message into a three segment one.
 */
export const RELAY_TEMPLATE_NAMES = ['recognition_code', 'order_link', 'order_nudge'] as const;

export type RelayTemplateName = (typeof RELAY_TEMPLATE_NAMES)[number];

export function isRelayTemplateName(value: unknown): value is RelayTemplateName {
  return typeof value === 'string' && (RELAY_TEMPLATE_NAMES as readonly string[]).includes(value);
}

/**
 * A ceiling on what a variable may be. Long enough for any URL we generate,
 * short enough that no value Akme passes can turn one message into forty.
 */
const MAX_VAR_LENGTH = 200;

const RELAY_TEMPLATES: Readonly<
  Record<RelayTemplateName, { vars: readonly string[]; render: (v: Record<string, string>) => string }>
> = Object.freeze({
  recognition_code: {
    vars: ['code'],
    render: (v) =>
      `${BUSINESS.name}: your verification code is ${v.code}. It expires in 10 minutes. ` +
      'We will never call or text you to ask for it.',
  },
  order_link: {
    vars: ['url'],
    render: (v) =>
      `${BUSINESS.name}: your order is ready to confirm here: ${v.url} ` +
      `The link works for 48 hours. Questions? Call ${BUSINESS.phone}.`,
  },
  // THE ONLY ONE OF THE THREE THAT CARRIES STOP, and the difference is who
  // started it. A verification code and an order link are both answers to
  // something the customer just did: they typed their number, or they said yes
  // on the phone. This one arrives a day later at somebody who did not reply,
  // which is the message a carrier looks hardest at on a 10DLC campaign and the
  // one a person is most likely to read as a company that will not leave them
  // alone. Carriers answer STOP at the network level on a registered campaign,
  // so this is about being honest with the person, not about making STOP work.
  order_nudge: {
    vars: ['url'],
    render: (v) =>
      `${BUSINESS.name}: your order is still waiting on you. Confirm it here: ${v.url} ` +
      `Closes 24 hours from now. Call ${BUSINESS.phone} for a hand. Reply STOP to opt out.`,
  },
});

/** Newlines and control characters: both are ways to make one message look like several. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * The rendered message, or null when the variables are not usable.
 *
 * Null rather than a throw, and null rather than a partial render: the relay
 * turns it into `{sent: false, reason}` so Akme learns its call was wrong
 * instead of a customer receiving a sentence with a gap in it.
 *
 * The variable lands INSIDE the template, it never replaces it. Whatever Akme
 * fills in, the message still opens with who we are and still says what it is,
 * which is what stops this endpoint being a way to send free text.
 */
export function renderRelayTemplate(
  name: RelayTemplateName,
  vars: Record<string, string>,
): string | null {
  const template = RELAY_TEMPLATES[name];
  const checked: Record<string, string> = {};
  for (const key of template.vars) {
    const value = vars[key];
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > MAX_VAR_LENGTH) return null;
    if (CONTROL_CHARS.test(trimmed)) return null;
    if (nonGsm7(trimmed).length > 0) return null;
    checked[key] = trimmed;
  }
  return template.render(checked);
}

/** Which variables a template needs, so the relay can name the missing one. */
export function relayTemplateVars(name: RelayTemplateName): readonly string[] {
  return RELAY_TEMPLATES[name].vars;
}
