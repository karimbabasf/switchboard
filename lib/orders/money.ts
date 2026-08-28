/**
 * Money, in integer cents, and money said out loud.
 *
 * NO FLOAT EVER HOLDS A PRICE HERE. Dollars are converted to cents once, at the
 * catalogue boundary in catalog.ts, and every multiplication and sum after that
 * is integer arithmetic. `24.42 * 5` is 122.10000000000001 in JavaScript, and a
 * price a caller is held to must not depend on which order we happened to add
 * things up in.
 *
 * The other half of this file exists because the agent SAYS these numbers.
 * `lib/agent/brief.ts` already spells out an address in words, because TTS read
 * "1234 Example Way" as "one thousand two hundred thirty four". A price is
 * the number in the whole call that a customer is most likely to hold us to, so
 * it is handed to the agent as finished words rather than as a numeral it might
 * reformat, re-read, or round on its way to the caller's ear.
 */

/**
 * The most units one line may carry.
 *
 * A ceiling and not a validation nicety: `units` arrives from a language model
 * that heard a phone call, and "a couple hundred" coming back as 200000 is a
 * two hundred thousand dollar sentence said to somebody who asked for two
 * pallets. Above this the tool refuses and asks, which is the safe direction.
 */
export const MAX_UNITS = 9999;

/** Whether a value is a countable number of ordering units. */
export function isUnitCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_UNITS;
}

/**
 * One line's money. Throws rather than returning a wrong number, because every
 * caller of this has already validated the count and a throw here means a bug
 * upstream rather than a caller who said something odd.
 */
export function lineCents(unitPriceCents: number, units: number): number {
  if (!Number.isInteger(unitPriceCents) || unitPriceCents < 0) {
    throw new Error(`lineCents: price is not whole cents: ${unitPriceCents}`);
  }
  if (!isUnitCount(units)) {
    throw new Error(`lineCents: ${units} is not a countable number of units (1 to ${MAX_UNITS})`);
  }
  return unitPriceCents * units;
}

/** Dollars off the catalogue into whole cents, exactly or not at all. */
export function dollarsToCents(dollars: number): number {
  if (!Number.isFinite(dollars) || dollars < 0) {
    throw new Error(`dollarsToCents: ${dollars} is not a price`);
  }
  const cents = Math.round(dollars * 100);
  // The six catalogue prices are all quarters, so this is exact. A price that is
  // not exact is a price somebody changed to a value that cannot be charged, and
  // it should stop the build rather than be silently rounded onto a call.
  if (Math.abs(dollars * 100 - cents) > 1e-6) {
    throw new Error(`dollarsToCents: ${dollars} is not a whole number of cents`);
  }
  return cents;
}

const ONES = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
];

const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function under100(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = n % 10;
  return ones ? `${tens}-${ONES[ones]}` : tens;
}

function under1000(n: number): string {
  if (n < 100) return under100(n);
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} ${under100(rest)}` : hundreds;
}

/**
 * A whole number in words. Handles everything this line can produce: the
 * ceiling is MAX_UNITS units of the dearest product, which is well under a
 * million dollars.
 */
export function countWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error(`countWords: ${n} is not a whole number`);
  if (n >= 1_000_000) throw new Error(`countWords: ${n} is larger than this line ever quotes`);
  if (n < 1000) return under1000(n);
  const thousands = `${under1000(Math.floor(n / 1000))} thousand`;
  const rest = n % 1000;
  return rest ? `${thousands} ${under1000(rest)}` : thousands;
}

/**
 * Cents as a spoken price. "forty-two dollars and ninety cents".
 *
 * Zero is "nothing" rather than "zero dollars", because the only way a caller
 * hears this is at the end of a sentence about what something costs.
 */
export function centsToSpokenDollars(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) {
    throw new Error(`centsToSpokenDollars: ${cents} is not whole cents`);
  }
  if (cents === 0) return 'nothing';

  const dollars = Math.floor(cents / 100);
  const remainder = cents % 100;

  const dollarPart = dollars === 0 ? '' : `${countWords(dollars)} ${dollars === 1 ? 'dollar' : 'dollars'}`;
  const centPart = remainder === 0 ? '' : `${countWords(remainder)} ${remainder === 1 ? 'cent' : 'cents'}`;

  if (!dollarPart) return centPart;
  if (!centPart) return dollarPart;
  return `${dollarPart} and ${centPart}`;
}
