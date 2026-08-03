import { describe, expect, it } from 'vitest';

import { isOrderChangeRequest, proposeChange } from '../lib/agent/order-change';
import type { AkmeOrderLine } from '../lib/types';

function line(sku: string, name: string, qty: number): AkmeOrderLine {
  return { sku, name, unit: 'bundle', qty, unit_price_cents: 2000 };
}

const TWO_LINES: AkmeOrderLine[] = [
  line('CW-BUNDLE', 'Cushion Wrap', 3),
  line('NP-BUNDLE', 'Newsprint Sheets', 2),
];
const ONE_LINE: AkmeOrderLine[] = [line('CW-BUNDLE', 'Cushion Wrap', 3)];

describe('isOrderChangeRequest', () => {
  it.each([
    'can you change my order to 5 bundles',
    'make it 5 instead of 3',
    'I need 6 not 3',
    'can I add another bundle to my order',
    'please update my order',
    'I ordered too many, can we drop one',
    'wrong quantity on the cushion wrap',
  ])('catches %s', (body) => {
    expect(isOrderChangeRequest(body)).toBe(true);
  });

  it.each([
    'what do you sell',
    'do you deliver to Shelbyville',
    'how much is a pallet of newsprint',
    'what are your hours',
    'thanks, see you Thursday',
  ])('leaves %s alone', (body) => {
    expect(isOrderChangeRequest(body)).toBe(false);
  });
});

describe('proposeChange: the number', () => {
  it.each([
    ['make it 5', 5],
    ['make it five', 5],
    ['change it to 8', 8],
    ['I need 6 of those', 6],
    ['4 instead please', 4],
    ['can you take it up to 10', 10],
  ])('reads %s as %i', (body, expected) => {
    expect(proposeChange(body, ONE_LINE)?.to).toBe(expected);
  });

  // Refusing to guess is half the job. Every one of these is a real change
  // request that a person should read, and none contains a defensible number.
  it.each([
    'can you add a few more',
    'double it please',
    'I need a lot more than that',
    'send extra',
    'change my order',
    'make it a bit smaller',
  ])('refuses to put a number on %s', (body) => {
    expect(proposeChange(body, ONE_LINE)).toBeNull();
  });

  it('refuses a quantity over the cap rather than offering a button that would 409', () => {
    expect(proposeChange('make it 1000', ONE_LINE)).toBeNull();
  });

  it('refuses a change to the quantity it already has', () => {
    expect(proposeChange('make it 3', ONE_LINE)).toBeNull();
  });
});

describe('proposeChange: which line', () => {
  it('names the line when a distinctive word matches', () => {
    const p = proposeChange('make the cushion 5', TWO_LINES);
    expect(p).toEqual({ sku: 'CW-BUNDLE', name: 'Cushion Wrap', from: 3, to: 5 });
  });

  it('matches on the sku too', () => {
    expect(proposeChange('change NP-BUNDLE to 4', TWO_LINES)?.sku).toBe('NP-BUNDLE');
  });

  it('needs no product word at all on a single-line order', () => {
    expect(proposeChange('make it 5', ONE_LINE)?.sku).toBe('CW-BUNDLE');
  });

  it('refuses when the product word is not distinctive enough', () => {
    // "wrap" is in Cushion Wrap, Hand Wrap Film and Machine Wrap Film. A word
    // that cannot tell them apart must not pick one.
    const lines = [line('CW-BUNDLE', 'Cushion Wrap', 3), line('HW-CASE', 'Hand Wrap Film', 2)];
    expect(proposeChange('make the wrap 5', lines)).toBeNull();
  });

  it('refuses when two lines both match', () => {
    const lines = [line('CW-BUNDLE', 'Cushion Wrap', 3), line('CW-PALLET', 'Cushion Wrap Pallet', 1)];
    expect(proposeChange('make the cushion 5', lines)).toBeNull();
  });

  it('refuses when nothing on the order is named and there is more than one line', () => {
    expect(proposeChange('make it 5', TWO_LINES)).toBeNull();
  });

  it('cannot reach a sku that is not on the order, however the text is written', () => {
    // The message names a real Akme product that this customer did not buy.
    expect(proposeChange('make the newsprint 9', ONE_LINE)).toBeNull();
  });

  it('returns nothing for an order with no lines', () => {
    expect(proposeChange('make it 5', [])).toBeNull();
  });
});
