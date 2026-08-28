/**
 * What the caller hears about money, and the validation that stands between
 * their sentence and any of it.
 *
 * THE AGENT NEVER DOES ARITHMETIC. Every number in every string this file
 * returns was computed here, in integer cents, and handed over as finished
 * words. That is the rule the whole order flow rests on: a model that is given
 * "forty-two dollars and ninety cents a case" can only repeat it, while
 * a model given a price and a quantity will eventually multiply them itself and
 * be wrong on a phone call.
 *
 * Karim's rules, and where each one lives:
 *   1. Listing what we stock carries no prices     -> brief.ts, unchanged
 *   2. Prices only for the items named             -> unitPriceSpeech below
 *   3. No quantities means per unit prices only    -> unitPriceSpeech below
 *   4. Quantities means say the subtotal           -> orderSpeech below
 *   5. Then offer the confirmation link            -> orderSpeech below
 *   8. Short stock is said, and what we have offered -> orderSpeech below
 *   9. Nothing changes at five thousand dollars    -> nothing in this file reads it
 */

import {
  isProductId,
  spokenName,
  unitName,
  unitNamePlural,
  unitPriceCents,
  type ProductId,
} from './catalog';
import { centsToSpokenDollars, countWords, isUnitCount, lineCents } from './money';

export interface OrderLine {
  product: ProductId;
  units: number;
}

export interface ShortStock {
  product: ProductId;
  wanted: number;
  available: number;
}

export interface PricedLine extends OrderLine {
  lineCents: number;
}

export interface PricedOrder {
  subtotalCents: number;
  perLine: PricedLine[];
}

export type Fulfilment = 'delivery' | 'willcall';

/**
 * More raw entries than this and the model is not transcribing an order, it is
 * looping. Six products exist, and a caller reciting twenty lines has said
 * something the tool should not try to price.
 */
const MAX_RAW_LINES = 20;

/**
 * The lines, or null.
 *
 * Null is not an error, it is "I did not catch that", and the tool turns it
 * into a question. Everything that is not exactly a catalogue id and a
 * countable number of units lands here, which is what keeps caller text out of
 * every price, every stock read and every row.
 *
 * A repeated product is MERGED rather than refused. "Two cases of tan tape, and
 * make it three more" is one order for five, and refusing it would make the
 * agent ask a question the caller has already answered.
 */
export function parseLines(raw: unknown): OrderLine[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_RAW_LINES) return null;

  const merged = new Map<ProductId, number>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { product, units } = entry as { product?: unknown; units?: unknown };
    if (!isProductId(product)) return null;
    if (!isUnitCount(units)) return null;
    const total = (merged.get(product) ?? 0) + units;
    // A merge that overflows the per line ceiling is the same problem the
    // ceiling exists for, so it fails the same way.
    if (!isUnitCount(total)) return null;
    merged.set(product, total);
  }

  return [...merged].map(([product, units]) => ({ product, units }));
}

/**
 * Delivery or will call, or null, where NULL MEANS NOBODY HAS SAID YET.
 *
 * Null is not an error and it does not make the tool ask. Fulfilment changes no
 * number in a subtotal, and the website already collects it: the texted link
 * exists so the customer picks delivery or will call, confirms the address and
 * proves who they are on the form. Asking on the phone duplicated that form and
 * made a caller answer a question before hearing a price, which cost three
 * rehearsal scenarios their order on 2026-08-27.
 *
 * Failing closed here means never GUESSING which one, not refusing to price. An
 * unrecognised word is null for the same reason a missing one is: we do not know,
 * so the form asks. A defaulted fulfilment would be a silent promise about how
 * somebody is getting their pallets, and the two have different lead times.
 */
export function parseFulfilment(raw: unknown): Fulfilment | null {
  if (typeof raw !== 'string') return null;
  const said = raw.trim().toLowerCase().replace(/[^a-z]/g, '');
  if (said === 'delivery' || said === 'deliver' || said === 'delivered') return 'delivery';
  if (said === 'willcall' || said === 'pickup' || said === 'pick' || said === 'collection') {
    return 'willcall';
  }
  return null;
}

export function priceLines(lines: OrderLine[]): PricedOrder {
  const perLine = lines.map((line) => ({
    ...line,
    lineCents: lineCents(unitPriceCents(line.product), line.units),
  }));
  return {
    perLine,
    subtotalCents: perLine.reduce((sum, line) => sum + line.lineCents, 0),
  };
}

/** Which lines we cannot fill, given what QuickBooks says is on the shelf. */
export function shortStockFor(lines: OrderLine[], available: Record<string, number>): ShortStock[] {
  const short: ShortStock[] = [];
  for (const line of lines) {
    const have = available[line.product];
    if (typeof have !== 'number' || !Number.isFinite(have)) continue;
    const onShelf = Math.max(0, Math.floor(have));
    if (onShelf < line.units) {
      short.push({ product: line.product, wanted: line.units, available: onShelf });
    }
  }
  return short;
}

/** "and" between the last two, commas before that. A list a person reads aloud. */
function joinSpoken(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  if (parts.length === 2) return `${parts[0]}, and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts.at(-1)}`;
}

function capitalise(sentence: string): string {
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

/**
 * Rules 2 and 3: the price of the things they named, one unit at a time, and
 * nothing added up.
 *
 * An empty list means all six, which is the only case where this says a price
 * nobody asked for, and it is deliberate: the caller asked for the price list.
 */
export function unitPriceSpeech(ids: readonly ProductId[]): string {
  const parts = ids.map(
    (id) => `the ${spokenName(id)} is ${centsToSpokenDollars(unitPriceCents(id))} a ${unitName(id)}`,
  );
  return `${capitalise(joinSpoken(parts))}.`;
}

/** Rule 8, said professionally: what we cannot fill, and what we can. */
export function shortStockSpeech(short: readonly ShortStock[]): string {
  if (short.length === 0) return '';
  return short
    .map((s) => {
      const wanted = `${countWords(s.wanted)} ${unitNamePlural(s.product, s.wanted)}`;
      const have =
        s.available === 0
          ? 'we are out of those at the moment'
          : `we have ${countWords(s.available)}`;
      return `We do not currently have ${wanted} of the ${spokenName(s.product)}, ${have}.`;
    })
    .join(' ');
}

/**
 * Rules 4 and 5: the reading, the subtotal, then the offer.
 *
 * The subtotal prices WHAT THEY ASKED FOR, even when a line is short. Quoting
 * the shortened order would quietly change somebody's order for them; saying
 * both numbers lets them decide, and the form they get shows the picks so they
 * can fix it there. Same reasoning as reading "25 boxes of tape" as 25 cases
 * and letting the form show it.
 *
 * Nothing here reads the large order threshold. Rule 9: a five thousand dollar
 * order sounds exactly like a fifty dollar one on the call.
 */
export function orderSpeech(
  lines: OrderLine[],
  priced: PricedOrder,
  short: readonly ShortStock[],
): string {
  const readings = priced.perLine.map(
    (line) =>
      `${countWords(line.units)} ${unitNamePlural(line.product, line.units)} of ${spokenName(line.product)}`,
  );

  const body =
    priced.perLine.length === 1
      ? `${capitalise(readings[0])} comes out to about ${centsToSpokenDollars(priced.subtotalCents)}.`
      : `${capitalise(joinSpoken(priced.perLine.map((line, i) => `${readings[i]} is ${centsToSpokenDollars(line.lineCents)}`)))}. ` +
        `That comes out to about ${centsToSpokenDollars(priced.subtotalCents)}.`;

  const stock = shortStockSpeech(short);
  return [stock, body, LINK_OFFER].filter(Boolean).join(' ');
}

/** Rule 5, word for word. The one question that follows every subtotal. */
export const LINK_OFFER = 'Would you like me to send you the confirmation link?';

/** Said when the model handed us something that is not an order we can price. */
export const DID_NOT_CATCH =
  'I did not quite catch the quantities. Tell me which products you need and how many of each, and I will total it up for you.';

/** Said when nothing in the list was one of ours. */
export const WHICH_PRODUCTS =
  'I can give you the price on any of our six products. Which ones were you asking about?';
