/**
 * The price leak Akme's scripts/parity-check.ts found, closed and pinned.
 *
 * WHAT THE CHECK ACTUALLY MEASURED, because it matters for reading this file:
 * it reads the MONEY regex out of lib/agent/sms.ts AS TEXT and tests that one
 * regex, so its "SENDS" column is a verdict on MONEY alone rather than on the
 * SMS leg. Run end to end, all seven forms it names already hold, because
 * `unpublishedNumber` stands behind MONEY and 46 is not a figure Akme
 * publishes. The first describe below proves that rather than assuming it.
 *
 * THE LEAK IS REAL ANYWAY and the second describe is the one that was failing
 * before 2026-08-18: the same seven shapes at a value the catalogue DOES
 * publish. 36 is a pack size and a pallet count, so "Hot melt tape is 36 a
 * case" was invisible to both guards and went to a customer unread. Karim's
 * rule is that the agent never produces a price it did not get from the quote
 * tool, and on that channel it could.
 */
import { describe, expect, it } from 'vitest';

import { BUSINESS } from '../lib/agent/brief';
import { draftSmsReply, overgeneralisedOrigin, pricePosition, type SmsAgentDeps } from '../lib/agent/sms';

/** 'products' is on the auto-send allowlist, so a guard is the only thing between this and the customer. */
function model(reply: string): SmsAgentDeps {
  return { complete: async () => ({ intent: 'products', reply }) };
}

/** The seven the parity check reports, at its made-up rate. */
const BARE_PRICE_FORMS = [
  'Hot melt tape is 46 a case, delivered.',
  'Hot melt tape is 46/ea.',
  'Tape: 46',
  'Hot melt tape is 46.00/case.',
  'I can do 46 flat.',
  'Roughly 46 a case.',
  'Our list is 46 per case.',
];

/** The same shapes at figures BUSINESS publishes: a pack size, a pallet count, two facts. */
const PUBLISHED_VALUES = ['36', '48', '33', '24'];

describe('the seven forms the parity check names', () => {
  it.each(BARE_PRICE_FORMS)('holds %j', async (reply) => {
    const d = await draftSmsReply('got tape?', model(reply));
    expect(d.autoSend, d.reason).toBe(false);
  });
});

describe('the same shapes at a figure the catalogue publishes', () => {
  const forms = PUBLISHED_VALUES.flatMap((v) =>
    BARE_PRICE_FORMS.map((f) => [v, f.replace(/46(\.00)?/, v)] as [string, string]),
  );

  it.each(forms)('holds a %s written as a price: %j', async (_value, reply) => {
    const d = await draftSmsReply('got tape?', model(reply));
    expect(d.autoSend, d.reason).toBe(false);
  });

  it('names it as a price rather than as a figure nobody published', async () => {
    // The reason lands on a Telegram card a person reads. "36 is not a number
    // we publish" would be wrong as well as unhelpful: 36 is a pack size and a
    // pallet count. What is wrong with the sentence is where the 36 sits.
    const d = await draftSmsReply('got tape?', model('Hot melt tape is 36 a case.'));
    expect(d.reason).toMatch(/reads as a price/i);
    expect(d.reason).toContain('36 a case');
  });
});

describe('pricePosition reads position, not value and not vocabulary', () => {
  it.each([
    ['36 a case', 'the article with no noun of its own'],
    ['36 per case', 'same, spelled the other way'],
    ['36/ea', 'a rate written with a slash'],
    ['46.00', 'two decimal places is money notation'],
    ['36 flat', 'a figure a seller closes on'],
    ['Tape: 36', 'a price list line'],
  ])('reads %j as a price (%s)', (text) => {
    expect(pricePosition(text)).not.toBeNull();
  });

  it.each([
    // The noun between the figure and the unit is the whole difference: a real
    // pack statement names what is in the pack, a price does not.
    '36 rolls per case',
    '4 rolls a case',
    'One case holds 36 rolls.',
    'Roughly 36 cases to a pallet.',
    '48 millimeters by 110 yards',
    'eighteen inches by 80 gauge by 1500 feet',
    '2 rolls to the bundle, each one 24 inches wide',
    // A quantity the customer just said back to us.
    'Got it, 2 cases of hot melt tape, someone will be in touch.',
    'Got it, 5 cases of clear tape and 1 bundle of paper.',
    // The address and the phone, both of which end in bare figures.
    'Will call pickup is 1234 Example Way, Springfield, CA.',
    'Call us on (555) 555-0158 and someone will pick up.',
    'We are open Monday to Friday, 8am to 4pm.',
  ])('leaves %j alone', (text) => {
    expect(pricePosition(text)).toBeNull();
  });
});

describe('every figure a correct answer is made of still sends', () => {
  // The guard is only worth having if it refuses prices and nothing else. Read
  // off BUSINESS rather than typed here, so a spec edited in brief.ts moves
  // both sides at once.
  const CORRECT = [
    ...BUSINESS.products.map((p) => `${p.name} is ${p.spec}.`),
    ...BUSINESS.products.map((p) => `One ${p.unit} of ${p.name} holds ${p.contents}.`),
    ...BUSINESS.products.map((p) => `Roughly ${p.perPallet} ${p.unit}s to a pallet.`),
    ...BUSINESS.products.flatMap((p) => p.facts.map((f) => `${p.name}: ${f}.`)),
    'Got it, 2 cases of hot melt tape, someone will be in touch.',
    `We are open ${BUSINESS.hours}.`,
    BUSINESS.fulfilment,
    `Will call pickup is ${BUSINESS.willCallAddress}.`,
    `Call us on ${BUSINESS.phone} and someone will pick up.`,
  ];

  it.each(CORRECT)('auto-sends %j', async (reply) => {
    const d = await draftSmsReply('got hand wrap?', model(reply));
    expect(d.autoSend, d.reason).toBe(true);
  });
});

describe('a fact belongs to the product it is listed under', () => {
  // Karim, 2026-08-18. The supplier sheet says "made in the USA with US and
  // globally sourced materials" for three of the six and is silent on the
  // other three, so a claim about all six is a false country-of-origin claim,
  // which carries legal weight rather than being a wording slip.

  it('states it for a product it is listed under', async () => {
    const d = await draftSmsReply(
      'where is the stretch film made',
      model(`${BUSINESS.products[0].name} is made in the USA with US and globally sourced materials.`),
    );
    expect(d.autoSend, d.reason).toBe(true);
  });

  it.each([
    'Everything we sell is made in the USA.',
    'All of our products are made in the USA.',
    'Both films are made in the USA.',
    'Every item we carry is American made.',
    'None of our products are imported.',
  ])('holds %j', async (reply) => {
    const d = await draftSmsReply('is your stuff american', model(reply));
    expect(d.autoSend, d.reason).toBe(false);
    expect(d.reason).toMatch(/country of origin/i);
  });

  it('holds a denial too, because silence is not evidence either way', () => {
    // The sheet does not say the cushion wrap is foreign. It says nothing, and
    // turning that into "not made in the USA" invents a fact in the other
    // direction.
    expect(overgeneralisedOrigin('The cushion wrap is not made in the USA.')).toBe(true);
    expect(overgeneralisedOrigin('The clear tape is not USA made.')).toBe(true);
  });

  it('does not fire on a sentence that negates something else', () => {
    expect(
      overgeneralisedOrigin('The 18" Stretch Film is made in the USA, but we do not have it here today.'),
    ).toBe(false);
  });

  it('tells the model the rule, so the guard is the backstop and not the plan', async () => {
    let system = '';
    await draftSmsReply('where is this made', {
      complete: async (s) => {
        system = s;
        return { intent: 'products', reply: 'Someone from the team will confirm that.' };
      },
    });
    expect(system).toMatch(/A FACT BELONGS TO THE PRODUCT IT IS LISTED UNDER/);
    expect(system).toMatch(/Do not say everything we sell is made anywhere/i);
    expect(system).toMatch(/do not say a product is NOT made somewhere either/i);
  });
});
