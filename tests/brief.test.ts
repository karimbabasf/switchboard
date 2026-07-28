import { describe, expect, it } from 'vitest';
import { BUSINESS, keyterms, systemPrompt } from '../lib/agent/brief';

describe('brief.ts: the business facts are one source', () => {
  it('names the six real SKUs and nothing Akme does not sell', () => {
    const names = BUSINESS.products.map((p) => p.name);
    // Read off lib/catalog.ts in the Akme repo, not from memory. The plan's
    // draft called the last two "Clear Tape" and "Tan Tape"; the catalogue calls
    // them Carton Sealing Tape and Hot Melt Tape, which is what a caller hears.
    expect(names).toEqual([
      'Cushion Wrap',
      'Newsprint Sheets',
      'Hand Wrap Film',
      'Machine Wrap Film',
      'Carton Sealing Tape',
      'Hot Melt Tape',
    ]);
    expect(names.join(' ').toLowerCase()).not.toContain('box');
  });

  it('derives STT keyterms from the products rather than a second list', () => {
    for (const product of BUSINESS.products) {
      expect(keyterms()).toContain(product.name);
    }
    expect(keyterms()).toContain('Akme');
  });

  it('forbids quoting a price in the system prompt', () => {
    expect(systemPrompt()).toMatch(/never quote|no prices|not quote a price/i);
  });

  it('tells the agent pallet counts are unconfirmed', () => {
    expect(BUSINESS.palletCountsConfirmed).toBe(false);
    expect(systemPrompt()).toMatch(/approximate|not confirmed|roughly/i);
  });

  it('carries pallet counts that match the catalogue', () => {
    // The two tape rows were the ones reconstructed during planning, so they are
    // the two worth pinning: 40 and 48, not the 42 and 42 the draft guessed.
    const perPallet = Object.fromEntries(BUSINESS.products.map((p) => [p.name, p.perPallet]));
    expect(perPallet).toEqual({
      'Cushion Wrap': 8,
      'Newsprint Sheets': 40,
      'Hand Wrap Film': 48,
      'Machine Wrap Film': 36,
      'Carton Sealing Tape': 40,
      'Hot Melt Tape': 48,
    });
  });

  it('writes specs the way a voice says them, with no inch marks or slashes', () => {
    // TTS reads `48" x 1/2" x 250 ft` as punctuation soup. Every spec in this
    // module is spoken aloud, so it is stored spoken.
    for (const product of BUSINESS.products) {
      expect(product.spec).not.toMatch(/["'/]|\bx\b/);
    }
  });
});
