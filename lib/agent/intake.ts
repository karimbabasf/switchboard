/**
 * The one thing we still need from a customer, asked once.
 *
 * Karim, 2026-08-19, off a real transcript. Somebody asked what stretch film
 * costs and got four requests joined by commas: what you need and how many, the
 * name it goes under, the best email for the quote, and will call or delivery.
 * That is a form, and a customer reads it as one. A price question got no price
 * and four questions back.
 *
 * THE RULE IS ONE ASK. At most one, and only when we cannot move without it.
 * The thing we ask for is whatever unblocks the next step. Everything else
 * rides along later, with the quote it is actually needed for.
 *
 * IT USED TO BUNDLE and the reason is worth keeping, because it was half right.
 * Karim, 2026-08-18: "properly gather the customers info from the first try.
 * without being like whats the address, and then whats the name, whats the
 * number." Four texts to raise one quote is a real failure. The fix taken then
 * was to ask for all four at once, which turned four short questions into one
 * long one and read worse. The fix now subtracts on the other axis: ask for the
 * one thing that blocks the next step, and take the rest off the customer.
 *
 * WHAT BLOCKS WHAT, read off Akme rather than guessed:
 *
 *   - a product and a count BLOCK THE QUOTE. `QuoteLine` in Akme lib/quote.ts
 *     is a product plus a count, and `decideQuote` in lib/ops/deal/quote.ts
 *     refuses the whole quote if one line has no count. It is the one field
 *     with no fallback anywhere, so it is what this file usually asks for.
 *   - a name, an email and an address BLOCK THE INVOICE, not the quote.
 *     `readIdentity` in lib/ops/deal/identity.ts lists those three as the
 *     askable fields, and `missingFrom` in lib/ops/deal/address.ts wants a
 *     street, a city and a ZIP to drive sales tax on the QuickBooks invoice.
 *     All three are needed when money moves, which is after a price has gone
 *     out. So they travel with the quote instead of standing in front of it.
 *   - the fulfilment choice travels with the quote too, see
 *     FULFILMENT_CHOICE_SMS below. It is asked here only when it is the last
 *     thing outstanding.
 *
 * The phone is never asked for. They texted us.
 *
 * Akme's own rule for this is MAX_INFO_ASKS = 1 per deal, enforced with a
 * counter on the order row (identity.ts). Nothing here can count, because this
 * agent holds no order: it is reached from an inbound text and knows only what
 * the caller hands it. One ask per reply is the version of that rule a
 * stateless function can keep.
 *
 * `missingFields` still returns everything we do not have, in the order a
 * person answers in. It is the honest answer to "what is missing". `intakeAsk`
 * takes the first of them and says nothing at all about the rest.
 */

import { BUSINESS } from './brief';

export type Fulfilment = 'will_call' | 'delivery';

/**
 * What we already hold about the person texting. Every field optional and every
 * field nullable, because the two sources it is built from disagree about which
 * they use: a Postgres row reads back null, an unset object property is
 * undefined, and a caller should not have to normalise one into the other to
 * avoid asking a customer their own name twice.
 */
export interface KnownCustomer {
  /** Their name, or their company. Whatever the quote goes out under. */
  name?: string | null;
  email?: string | null;
  /** A delivery address good enough to invoice against. */
  address?: string | null;
  /** What they want and how many, in whatever words we have it in. */
  items?: string | null;
  /**
   * Something we sell, named with no count against it. "how much is stretch
   * film" is this and not `items`: we know what they want and we cannot quote
   * it, so the one ask is the count rather than the whole question again.
   */
  product?: string | null;
  fulfilment?: Fulfilment | null;
}

export type IntakeField = 'items' | 'quantity' | 'name' | 'email' | 'fulfilment' | 'address';

/**
 * The one clause each missing field turns into.
 *
 * Written to follow "Let me know", because exactly one of them is ever used and
 * a bare question ("what is the name") reads as an interrogation on its own.
 */
const ASK: Readonly<Record<IntakeField, string>> = Object.freeze({
  items: 'what you need and how many',
  // Used instead of `items` when the message already named a product. Asking
  // what they need after they have said "stretch film" is the failure this
  // file was rewritten for, in miniature.
  quantity: 'how many you need',
  name: 'the name it goes under',
  email: 'the best email for the quote',
  // Carries the will call address rather than only the word "will call", so
  // somebody choosing it does not have to send a second text asking where we
  // are. That address is a standing fact and costs 30 characters.
  fulfilment: `whether you want will call at ${BUSINESS.willCallAddress} or delivery to your address`,
  // Only reachable when they have already SAID delivery and given no address,
  // hence naming the parts: a bare city or a ZIP does not invoice.
  address: 'the delivery address with the city and ZIP',
});

/**
 * Ask order, and it is the order a person answers in, not the order we file in.
 * `intakeAsk` takes the first of these and says nothing about the rest, so this
 * list is also the priority: whatever blocks the next step comes first.
 */
const FIELD_ORDER: readonly IntakeField[] = ['items', 'quantity', 'name', 'email', 'fulfilment', 'address'];

export function missingFields(known: KnownCustomer): IntakeField[] {
  const missing: IntakeField[] = [];
  // A named product with no count is one ask short of a quote, not four.
  if (!known.items) missing.push(known.product ? 'quantity' : 'items');
  if (!known.name) missing.push('name');
  if (!known.email) missing.push('email');
  if (!known.fulfilment) missing.push('fulfilment');
  // Not missing at all while the fulfilment choice is still open. Will call
  // needs no address, so until they have picked delivery there is nothing here
  // to be short of, which is why the choice is ordered ahead of it.
  else if (known.fulfilment === 'delivery' && !known.address) missing.push('address');
  return FIELD_ORDER.filter((f) => missing.includes(f));
}

/**
 * The reply to a pricing question: one line of acknowledgement, then one ask.
 *
 * The ask is `missing[0]`, which FIELD_ORDER has already put in the order that
 * unblocks the next step. Everything after it is deliberately unsaid. It is not
 * lost: the name, the email and the address are asked for with the quote, where
 * they are what actually blocks the invoice.
 *
 * Never opens with a name, Karim's standing rule, and never opens with the
 * company name either.
 */
export function intakeAsk(known: KnownCustomer): string {
  const missing = missingFields(known);
  if (missing.length === 0) {
    // Nothing to ask and nothing to promise. Pricing is a human's, so this
    // says a person is coming and stops.
    return 'Happy to get that quote over. Someone from the team will send pricing shortly.';
  }
  const asking = missing[0];
  return [
    'Happy to get that quote over.',
    `Let me know ${ASK[asking]}.`,
    // The site is an alternative to telling us WHAT THEY WANT, and nothing
    // else. Offered to somebody who has already named a product and only owes
    // us a count, it reads as "go and start again", which is worse than the
    // round trip it saves.
    ...(asking === 'items' ? [`Or build it at ${BUSINESS.site}.`] : []),
  ].join(' ');
}

/**
 * The fulfilment choice, offered WITH the price rather than after it.
 *
 * Karim, 2026-08-18: a quote that goes out under the ceiling has to let the
 * customer pick will call or delivery in the same message. A quote followed by
 * "and would you like to collect it" is two texts for one decision, and the
 * second one arrives after they have stopped reading.
 *
 * Both halves are standing facts and both are safe to send unread. What is NOT
 * here, deliberately, is a date for their order: the cadence is ours to state,
 * "yours goes out Thursday" is a promise and belongs to whoever taps Send.
 */
export const FULFILMENT_CHOICE_SMS = [
  'Will call or delivery?',
  `Will call is ${BUSINESS.willCallAddress}, ${BUSINESS.hours}.`,
  'For delivery, orders in by Tuesday go out on Thursday.',
].join(' ');

/**
 * A priced quote with the choice attached. Kept as a function rather than left
 * to each caller to remember, because "the quote went out without the choice"
 * is invisible until a customer replies asking how they get it.
 */
export function withFulfilmentChoice(quote: string): string {
  return `${quote.trim()} ${FULFILMENT_CHOICE_SMS}`;
}

// --- Reading the customer's own message -------------------------------------

/**
 * Anything the message itself already answered.
 *
 * This is the half that makes the ask short. Most pricing texts arrive as "how
 * much for 4 cases of hot melt tape, delivered to 100 Example St, Springfield
 * 90000", and asking that person what they need and where it goes is the
 * behaviour being fixed.
 *
 * Every reader below is deliberately conservative, and they all fail the same
 * way on purpose. A field read WRONGLY is a field we never ask about, so the
 * quote is raised against something the customer did not say. A field MISSED is
 * one more clause in a message we were already sending. So each one asks for
 * more evidence than the minimum, and a maybe is a no.
 */
const EMAIL = /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i;

/**
 * A quantity, in digits or in words. "a couple" and "a few" are absent because
 * they are not a number anybody can price.
 */
const QUANTITY = /\b(\d{1,4}|one|two|three|four|five|six|seven|eight|nine|ten|dozen)\b/i;

/**
 * Words that reach PRODUCT_WORDS out of an alias and name no product at all.
 *
 * "pallet wrap" and "big roll" are both real aliases for the eighteen inch
 * film, so splitting them puts "pallet", "roll" and "big" into the vocabulary.
 * On their own those words are a container or a size: "how much for a pallet"
 * names nothing we sell. This mattered little while a product read only chose
 * whether `items` was complete; it matters now, because a named product turns
 * the ask into "how many you need", and asking that of somebody who never said
 * what they want is the failure wearing a different coat.
 */
const NOT_A_PRODUCT_ALONE: ReadonlySet<string> = new Set([
  'pallet',
  'roll',
  'big',
  'small',
  'inch',
  'eighteen',
  'five',
]);

/**
 * Every word a customer uses for something we sell, which is a WIDER list than
 * the one lib/agent/order-change.ts builds from the same data.
 *
 * The two want opposite things and must not be shared. order-change needs a
 * word DISTINCTIVE enough to pick one line out of several, so it throws away
 * "tape" and "wrap" as ambiguous. Here the question is only whether a product
 * was named at all, and "4 cases of tape" names one perfectly well.
 */
const PRODUCT_WORDS: readonly string[] = [
  ...new Set(
    BUSINESS.products
      .flatMap((p) => [p.name, ...p.alsoCalled])
      .flatMap((n) => n.toLowerCase().split(/[^a-z0-9]+/))
      .filter((w) => w.length > 2 && !NOT_A_PRODUCT_ALONE.has(w)),
  ),
];

const NAMES_A_PRODUCT = new RegExp(`\\b(?:${PRODUCT_WORDS.join('|')})\\b`, 'i');

/**
 * A street number plus enough around it to be an address rather than a spec.
 *
 * The street number alone is useless here: "1500 feet" and "make it 5 rolls"
 * both open with a number and a word. So a street type or a ZIP is required as
 * corroboration, which is the same evidence Akme's address parser needs before
 * it will resolve one (lib/ops/deal/address.ts: a landmark with no street
 * number is refused there for the mirror-image reason).
 */
const STREET_NUMBER = /\b\d{1,6}\s+[a-z]/i;
const STREET_TYPE =
  /\b(st|street|ave|avenue|rd|road|blvd|boulevard|way|dr|drive|ln|lane|ct|court|hwy|highway|pkwy|parkway|cir|circle|pl|place|ter|terrace|via|calle|camino)\b/i;
const ZIP = /\b\d{5}(?:-\d{4})?\b/;

const WILL_CALL = /\b(will.?call|pick(?:ing)?\s*(?:it\s*)?up|pickup|come\s+get|collect\s+it|swing\s+by)\b/i;
const DELIVERY = /\b(deliver|delivery|delivered|ship\s+it|shipped|drop\s+it\s+off|bring\s+it)\b/i;

export function readKnownFromMessage(body: string | null | undefined): KnownCustomer {
  const text = body?.trim() ?? '';
  if (!text) return {};

  const known: KnownCustomer = {};

  const email = EMAIL.exec(text);
  if (email) known.email = email[0];

  // A product AND a count. Either alone is a question, not an order: "what do
  // you charge for tape" names a product and orders nothing, and "how much for
  // 4" counts something nobody has identified.
  const named = NAMES_A_PRODUCT.exec(text);
  if (named && QUANTITY.test(text)) known.items = text;
  // The half-answer is worth holding on its own. It is what turns four asks
  // into one: they told us what they want, so the only thing left is the count.
  else if (named) known.product = named[0];

  if (STREET_NUMBER.test(text) && (STREET_TYPE.test(text) || ZIP.test(text))) known.address = text;

  const wantsWillCall = WILL_CALL.test(text);
  const wantsDelivery = DELIVERY.test(text);
  // "can I pick it up or do you deliver" is a person ASKING about both, not
  // choosing. Reading a choice out of that would skip the one question they
  // actually asked.
  if (wantsWillCall !== wantsDelivery) known.fulfilment = wantsWillCall ? 'will_call' : 'delivery';

  // THE NAME IS DELIBERATELY NOT READ OUT OF THE MESSAGE. "this is Sam from
  // Harbor Movers" is easy to catch and "tell Sam I called" is the same
  // shape, and the cost of the two being confused is not a clumsy question, it
  // is a QuickBooks customer and an invoice under the wrong name. The name
  // comes from the contact record or it gets asked for.

  return known;
}

/**
 * The record and the message, merged the way Akme merges them.
 *
 * The message wins. Somebody who just typed an address is telling us where THIS
 * delivery goes, which beats a row written on a different day
 * (Akme lib/ops/deal/identity.ts, "a fresh address beats the one on file").
 */
export function knownFor(body: string | null | undefined, onFile: KnownCustomer = {}): KnownCustomer {
  const fromMessage = readKnownFromMessage(body);
  return {
    name: fromMessage.name ?? onFile.name ?? null,
    email: fromMessage.email ?? onFile.email ?? null,
    address: fromMessage.address ?? onFile.address ?? null,
    items: fromMessage.items ?? onFile.items ?? null,
    // Only ever read off this message. A product named last week does not tell
    // us what today's text is about, and the wrong one here asks how many of
    // something they never mentioned.
    product: fromMessage.product ?? null,
    fulfilment: fromMessage.fulfilment ?? onFile.fulfilment ?? null,
  };
}
