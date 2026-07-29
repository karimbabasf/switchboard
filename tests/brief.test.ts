import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BUSINESS, GREETING, SPOKEN_LIST, keyterms, systemPrompt } from '../lib/agent/brief';
import { callerContext } from '../lib/agent/context';

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
    expect(GREETING).toContain('Robin');
    // The company name belongs HERE, not in the recording notice ahead of it
    // (Karim, 2026-07-29): a caller should hear a person introduce themselves and
    // where they work. This assertion was previously the exact opposite. The rule
    // that survived the reversal is "named once across the two beats", which the
    // disclosure suite below is what actually enforces.
    expect(GREETING).toContain(BUSINESS.name);
    expect(GREETING.trim().endsWith('?')).toBe(true);
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

describe('brief.ts: the agent routes quotes, it never produces one', () => {
  const prompt = systemPrompt();

  it('forbids producing, pricing or sending a quote', () => {
    expect(prompt).toMatch(/you do not produce a quote/i);
    // Matched verb by verb rather than as one sentence, so rewording the prompt
    // cannot quietly drop one of them the way a single exact-phrase match would.
    for (const verb of [/never price one/i, /total one/i, /build one/i, /send one/i]) {
      expect(prompt).toMatch(verb);
    }
    // The old prompt told the agent to say "I will get a quote out to you today",
    // which is the agent promising to do the one thing it cannot do.
    expect(prompt).not.toMatch(/say: "I do not have pricing in front of me, but I will get a quote/i);
  });

  it('forbids creating or sending an invoice, while still allowing a lookup', () => {
    expect(prompt).toMatch(/may never create, price, or send/i);
    expect(prompt).toContain('lookup_invoice');
  });

  it('answers an order or pricing request with a yes and a route, never a refusal', () => {
    // Karim's second live call: the agent led with what it could not do. The
    // prompt was the cause, not the model. It literally said "say plainly that
    // you do not have prices and are not the one who sets them", and separately
    // banned "absolutely", which is the exact opener that fixes it.
    expect(prompt).toMatch(/start with yes/i);
    expect(prompt).toMatch(/never open with what you cannot do/i);
    for (const refusal of [/"I can't"/i, /"I am unable to"/i, /unfortunately/i]) {
      expect(prompt).toMatch(refusal);
    }
    expect(prompt).not.toMatch(/do not say "great question" or "absolutely"/i);
    // And it has to say what it CAN do, or a yes with a redirect is still a dead end.
    expect(prompt).toMatch(/tell them what you CAN do right now/i);
  });

  it('bans filler, which is what made the agent sound full of "uhmms"', () => {
    expect(prompt).toMatch(/NO FILLER, EVER/);
    for (const filler of [/"um"/i, /"uh"/i, /"let me see"/i]) {
      expect(prompt).toMatch(filler);
    }
    expect(prompt).toMatch(/If a tool is running, say nothing at all/i);
  });

  it('keeps the greeting short, because it is time before the caller can speak', () => {
    // Fourteen words, not ten: naming the company here costs three of them and is
    // the point of this line. It still has to stay one breath, because
    // `disable_greeting_interruption` is true and anything a caller says over this
    // line is thrown away.
    expect(GREETING.split(/\s+/).length).toBeLessThanOrEqual(14);
  });

  it('gives the caller all three places a quote actually happens', () => {
    expect(prompt).toContain(BUSINESS.site);
    expect(prompt).toContain(BUSINESS.email);
    expect(prompt).toMatch(/a text, either to this same number/i);
    expect(prompt).toContain('text_me_the_list');
  });

  it('still lets the agent give out any product detail it has, on request', () => {
    // The old prompt said "say any of that freely" about the whole spec table,
    // directly under the product list. The agent read measurements at people who
    // had only asked what we sell. Karim's rule (2026-07-29): listing is titles,
    // detail is a follow-up. Both halves still have to be in the prompt.
    expect(prompt).toMatch(/THE DETAIL, ONLY WHEN THEY ASK FOR IT/);
    expect(prompt).toMatch(/never volunteer a measurement nobody asked for/i);
    for (const product of BUSINESS.products) {
      expect(prompt).toContain(product.spec);
    }
  });

  it('answers "what do you sell" with titles only, and no measurement leaks in', () => {
    expect(prompt).toContain(SPOKEN_LIST);
    // Every product has to be reachable from the one sentence the agent says, or
    // adding a seventh SKU silently drops it off the phone line.
    for (const product of BUSINESS.products) {
      const firstWord = product.name.split(' ')[0].toLowerCase();
      expect(SPOKEN_LIST.toLowerCase()).toContain(firstWord);
    }
    // No digits, no units: a spoken list with "48 millimeters" in it is the thing
    // this sentence exists to prevent.
    expect(SPOKEN_LIST).not.toMatch(/\d/);
    expect(SPOKEN_LIST).not.toMatch(/inch|gauge|yard|feet|pound|mil\b|roll/i);
  });

  it('forbids taking the order item by item, which is what it actually did', () => {
    // The 58 second call on 2026-07-29: the caller said "I'd like to place an
    // order" three times and got "what kinds of tape are you after?" and then
    // "besides the hot melt, what else?". The website, a text and email were
    // never mentioned. The prompt had the routing rule; it was in section five of
    // eight, under a heading about pricing, so ordering never triggered it.
    expect(prompt).toMatch(/NEVER TAKE THE ORDER ITEM BY ITEM/);
    expect(prompt).toMatch(/do not ask "what else"/i);
    expect(prompt).toMatch(/your NEXT sentence is the route/);
  });

  it('forbids asking what they need a second time', () => {
    // Same call: the greeting asked "how can I help", then the agent asked "what
    // can I do for you" and then "what do you need". Three open questions, one
    // caller, who had answered the first one.
    expect(prompt).toMatch(/YOU HAVE ALREADY ASKED WHAT THEY NEED/);
    expect(prompt).toMatch(/answer the thing they said instead of asking again/i);
  });

  it('knows the words callers actually use, so it cannot deny stocking bubble wrap', () => {
    // Verified against `qbName` in Akme's lib/catalog.ts, not from memory:
    // Cushion Wrap is literally 'BUBBLE - 48" x 1/2" x 250\' PERFORATED 12"'.
    for (const product of BUSINESS.products) {
      expect(product.alsoCalled.length).toBeGreaterThan(0);
      for (const alias of product.alsoCalled) {
        expect(prompt).toContain(alias);
      }
    }
    expect(prompt).toMatch(/bubble wrap is asking for Cushion Wrap/i);
    expect(prompt).toMatch(/Never tell someone we do not carry something because they used their word/i);
    // Stretch film is not shrink film. Claiming they are the same is exactly the
    // invented answer the alias list is supposed to prevent.
    const aliases = BUSINESS.products.flatMap((p) => p.alsoCalled);
    expect(aliases).not.toContain('shrink wrap');
  });

  it('offers a person instead of waiting to be asked for one', () => {
    expect(prompt).toMatch(/I can put you through to someone on our team, would you like that\?/);
    expect(prompt).toMatch(/Do not ask them why and do not talk them out of it/i);
    // "Whatever the title is" was Karim's phrasing, and the safe answer to it is
    // to have no title at all rather than a plausible invented one.
    expect(prompt).toMatch(/Do not invent a job title/i);
  });

  it('says only what it knows for certain, and lists what it does not know', () => {
    expect(prompt).toMatch(/ONLY SAY WHAT YOU KNOW FOR CERTAIN/);
    expect(prompt).toMatch(/written in these instructions or came back from a tool/i);
    for (const unknown of ['stock levels', 'lead times', 'minimum orders', 'returns']) {
      expect(prompt).toContain(unknown);
    }
  });

  it('reads every caller variable the context webhook returns', async () => {
    // The webhook fetched first_name, is_known_caller and recent_order on every
    // call, the assistant waited on it before greeting anybody, and the prompt
    // referenced none of them. The wait was buying nothing.
    const variables = await callerContext('+14155550100', {
      identify: async () => null,
      recentOrders: async () => [],
    });

    for (const name of Object.keys(variables)) {
      expect(prompt).toContain(`{{${name}}}`);
    }
  });
});

describe('the recording disclosure', () => {
  /** The checked-in template. .env.local is not readable from a test and is not in git. */
  const disclosure = (() => {
    const file = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const line = file.split('\n').find((l) => l.startsWith('RECORDING_DISCLOSURE='));
    return (line ?? '').slice('RECORDING_DISCLOSURE='.length).replace(/^"|"$/g, '');
  })();

  it('states that the call is recorded, which California requires of all parties', () => {
    expect(disclosure).toMatch(/\brecorded\b/i);
  });

  it('states that the caller is talking to a machine', () => {
    expect(disclosure).toMatch(/automated|assistant|\bAI\b|machine|robot/i);
  });

  it('reads as the same person who says the greeting straight after it', () => {
    const together = `${disclosure} ${GREETING}`;
    expect(together).toContain(BUSINESS.name);
    // One introduction, not two. Both halves naming the company, or both
    // introducing somebody, is the tell that two systems are talking.
    expect(together.match(new RegExp(BUSINESS.name, 'g'))).toHaveLength(1);
    expect(disclosure.length).toBeLessThan(200);
  });

  it('is the notice and only the notice, with the company name left to the greeting', () => {
    // The split changed on 2026-07-29 so the caller hears a person introduce
    // themselves and their company, which is the half a customer remembers. This
    // is the assertion that keeps the pair from drifting back into saying "Akme
    // USA" twice in six seconds; the test above only counts, this one says where.
    expect(disclosure).not.toContain(BUSINESS.name);
    expect(GREETING).toContain(BUSINESS.name);
    // Nothing else belongs in the notice: no product talk, no offer of help.
    expect(disclosure).not.toMatch(/how can i help|what can i/i);
  });
});
