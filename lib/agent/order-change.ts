/**
 * "Can you make that 5 bundles instead of 3."
 *
 * Two jobs, deliberately separated because they carry very different risk:
 *
 *  1. NOTICING that a text is a change request. Wrong answers here are cheap.
 *     A false positive parks a message for a human who was going to read it
 *     anyway; a false negative is caught by the model classifying it.
 *  2. TURNING IT INTO A NUMBER. Wrong answers here change what somebody is
 *     billed, so none of it is left to the model. The quantity is parsed by
 *     regex, and the product is matched against the lines that are actually on
 *     the customer's order rather than against anything the text asserts. The
 *     text can therefore ask for a quantity we do not honour, but it cannot
 *     name a product that is not already theirs, and it cannot reach a sku at
 *     all except by matching one.
 *
 * Nothing here writes. A proposal becomes an Apply button on a Telegram card,
 * Akme's /api/order-change does the write, and it re-checks the order status
 * itself rather than trusting anything sent to it.
 */

import { BUSINESS } from './brief';
import type { AkmeOrderLine } from '../types';

/**
 * Wants the order changed. Fires ahead of the model for the same reason
 * BARGAINING does: this must never depend on a classification made from text
 * the customer wrote.
 */
const CHANGE_REQUEST = new RegExp(
  [
    'change (my|the|our) order',
    'change (it|that|this) to',
    'update (my|the|our) order',
    'add (more|another|an extra|a couple|to my order|to the order)',
    'remove .{0,20}(from|off) (my|the) order',
    'take .{0,20}(off|out of) (my|the) order',
    'instead of',
    'make (it|that|them) [0-9]',
    'make (it|that|them) (one|two|three|four|five|six|seven|eight|nine|ten)',
    'increase (it|that|the)',
    'decrease (it|that|the)',
    'bump (it|that|the)',
    'cancel (one|two|a|the) ',
    '(more|less|fewer) than i (ordered|asked)',
    'can (i|we) (add|swap|switch|change)',
    'i (need|want|meant) ([0-9]+|one|two|three|four|five|six|seven|eight|nine|ten) (instead|not)',
    'wrong (quantity|amount|number)',
    'ordered too (many|much|few|little)',
  ].join('|'),
  'i',
);

export function isOrderChangeRequest(body: string | null | undefined): boolean {
  const text = body?.trim();
  return !!text && CHANGE_REQUEST.test(text);
}

export interface ProposedChange {
  sku: string;
  name: string;
  from: number;
  to: number;
}

const WORD_NUMBERS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
  seven: 7, eight: 8, nine: 9, ten: 10,
});

/** Shared tail of every pattern below: a digit or a written number, and nothing else. */
const N = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten)';

/**
 * A short run of ordinary words between the verb and the number, so "make the
 * cushion wrap 5" reads the same as "make it 5". Bounded and lazy: an unbounded
 * gap turns "we discussed 3 last week, make it 5" into a proposal for 3.
 */
const GAP = '[a-z0-9\\s-]{0,25}?';

/** Same ceiling Akme's endpoint enforces. Mirrored so the card never offers a button that 409s. */
const MAX_QTY = 999;

/**
 * The quantity being asked for, and nothing else.
 *
 * Only these shapes, all of which put the new number unambiguously first or
 * last. Anything vaguer ("a few more", "double it") returns null on purpose:
 * there is no defensible number in it, so a person reads the message. Half of
 * getting this right is refusing to guess.
 */
const QTY_PATTERNS: readonly RegExp[] = [
  // "N instead" first: it names the new number explicitly, so it beats any
  // reading that might otherwise land on the old one.
  new RegExp(`\\b${N}\\s+instead\\b`, 'i'),
  new RegExp(`\\bmake (?:it|that|them|the|my|our)\\b${GAP}\\s${N}\\b`, 'i'),
  new RegExp(`\\bchange\\b${GAP}\\bto ${N}\\b`, 'i'),
  new RegExp(`\\b(?:up|down) to ${N}\\b`, 'i'),
  new RegExp(`\\bi (?:need|want|meant) ${N}\\b`, 'i'),
];

/**
 * The quantity, and WHERE IN THE TEXT IT WAS WRITTEN.
 *
 * The span is not bookkeeping, it is the fix for a real mis-sizing bug found on
 * 2026-08-18. The catalogue was renamed that day and the two films gained the
 * aliases "eighteen inch" and "five inch", which put the words `eighteen` and
 * `five` into the product vocabulary matchLine reads. From that moment "make it
 * five" on a single-line order was refused: `five` was the quantity, and it was
 * also, now, a word that names a product this customer had not ordered, so the
 * "they named something that is not theirs" branch fired and a correct change
 * request went to a human every time it was written in words instead of digits.
 *
 * Special-casing the string was the wrong fix and would have left the same trap
 * for "eighteen" and for whatever a seventh product is called. A token already
 * read as the QUANTITY cannot also be read as the PRODUCT, so the honest fix is
 * to hand matchLine the message with that token taken out of it.
 */
interface ParsedQty {
  qty: number;
  /** Half-open range of the number token in the original text. */
  start: number;
  end: number;
}

function parseQty(text: string): ParsedQty | null {
  for (const pattern of QTY_PATTERNS) {
    const m = pattern.exec(text);
    if (!m) continue;
    const token = m[1].toLowerCase();
    const qty = /^\d+$/.test(token) ? Number(token) : WORD_NUMBERS[token];
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) continue;
    // Group 1, not the whole match: "make the cushion 5" must keep "cushion",
    // which is the only thing naming the line being changed.
    const start = text.indexOf(m[1], m.index);
    return { qty, start, end: start + m[1].length };
  }
  return null;
}

/**
 * Words too generic to identify a line by, even though they appear in the names.
 *
 * `inch` and `inches` joined the list on 2026-08-18 with the rename. Both films
 * are now called after their width ("eighteen inch", "five inch"), so the word
 * they share tells the two of them apart exactly as well as "wrap" does, which
 * is not at all.
 */
const STOPWORDS = new Set([
  'wrap',
  'film',
  'tape',
  'sheets',
  'bundle',
  'case',
  'roll',
  'rolls',
  'inch',
  'inches',
  'the',
  'and',
]);

function tokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

/**
 * Every distinctive word that names something we sell, including what customers
 * call them rather than what the catalogue does ("bubble" for Cushion Wrap).
 * Used only to notice that a product WAS named, never to pick one.
 */
const PRODUCT_WORDS: readonly string[] = [
  ...new Set(BUSINESS.products.flatMap((p) => [p.name, ...p.alsoCalled]).flatMap(tokens)),
];

/**
 * Which line they mean.
 *
 * Grounded entirely in the order: a line is only a candidate if a distinctive
 * word from its own name or its sku appears in the message. "Wrap" alone is not
 * distinctive, since four of the six products are a wrap of some kind, which is
 * exactly the kind of near-miss that would otherwise change the wrong line.
 *
 * A single-line order is the one case where no product word is needed. If they
 * ordered one thing and ask to change the quantity, there is nothing to
 * disambiguate.
 */
function matchLine(text: string, lines: AkmeOrderLine[]): AkmeOrderLine | null {
  const haystack = text.toLowerCase();
  const hits = lines.filter((line) => {
    if (haystack.includes(line.sku.toLowerCase())) return true;
    return tokens(line.name).some((t) => haystack.includes(t));
  });

  if (hits.length === 1) return hits[0];
  // Two hits is genuinely ambiguous and one is worse than none here.
  if (hits.length > 1) return null;

  // Nothing on the order matched. Before falling back to a one-line order, check
  // whether they named a product AT ALL: "make the newsprint 9" on an order that
  // is only cushion wrap must not quietly become a change to the cushion wrap.
  // They are either confused about their own order or texting about a different
  // one, and both need a person.
  if (PRODUCT_WORDS.some((word) => haystack.includes(word))) return null;

  return lines.length === 1 ? lines[0] : null;
}

/**
 * The change to offer as a button, or null if the message does not contain one
 * clearly enough to put a number in front of somebody.
 *
 * Returning null is a completely normal outcome and costs nothing: the card
 * still carries the customer's words and the order, and the human does what
 * they were going to do anyway.
 */
export function proposeChange(body: string | null | undefined, lines: AkmeOrderLine[]): ProposedChange | null {
  const text = body?.trim();
  if (!text || lines.length === 0) return null;

  const parsed = parseQty(text);
  if (parsed === null) return null;
  const to = parsed.qty;

  // Blanked, not deleted, so every other offset in the sentence stays where it
  // was and a word is not accidentally joined to its neighbour: "make it five"
  // must not collapse into a haystack reading "make itfive".
  const withoutQty = `${text.slice(0, parsed.start)}${' '.repeat(parsed.end - parsed.start)}${text.slice(parsed.end)}`;

  const line = matchLine(withoutQty, lines);
  if (!line) return null;

  // Same refusal Akme's requantify makes, made earlier so the button never
  // appears rather than appearing and failing on the tap.
  if (to === line.qty) return null;

  return { sku: line.sku, name: line.name, from: line.qty, to };
}
