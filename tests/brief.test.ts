import { describe, expect, it } from 'vitest';
import { BUSINESS, GREETING, keyterms, systemPrompt } from '../lib/agent/brief';

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

describe('brief.ts: the prompt holds its guardrails', () => {
  const prompt = systemPrompt();

  it('spells out what it may never do', () => {
    for (const rule of [/never quote/i, /never take a card/i, /never promise a delivery date/i]) {
      expect(prompt).toMatch(rule);
    }
  });

  it('names the escalation tool by the name the tool is registered under', () => {
    expect(prompt).toContain('escalate_to_human');
  });

  it('is a greeting, not an instruction to greet', () => {
    // Telnyx sends the greeting straight to TTS without running it through the
    // model, so a meta-instruction would be read aloud word for word.
    expect(GREETING).not.toMatch(/^(greet|say|welcome the)/i);
    expect(GREETING).toContain('Akme');
  });

  it('keeps the greeting short enough to sound like a person answering', () => {
    // Two clauses is what a human receptionist says. Four is a recording.
    expect(GREETING.split(/[.?!]/).filter(Boolean).length).toBeLessThanOrEqual(2);
  });

  it('carries every product into the prompt, so the agent cannot invent a seventh', () => {
    for (const product of BUSINESS.products) {
      expect(prompt).toContain(product.name);
    }
  });

  it('names the four things we do not sell, since callers ask for all of them', () => {
    for (const absent of ['boxes', 'tape guns', 'dollies', 'blankets']) {
      expect(prompt).toContain(absent);
    }
  });
});
