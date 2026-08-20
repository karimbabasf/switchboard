import { describe, expect, it, vi } from 'vitest';

import { BUSINESS } from '../lib/agent/brief';
import {
  FULFILMENT_CHOICE_SMS,
  intakeAsk,
  knownFor,
  missingFields,
  readKnownFromMessage,
  withFulfilmentChoice,
  type KnownCustomer,
} from '../lib/agent/intake';
import { draftSmsReply, unpublishedNumber, type SmsAgentDeps } from '../lib/agent/sms';
import { nonGsm7, renderTemplate } from '../lib/agent/templates';

/** The model must never be reached on any path this file exercises. */
function neverCalled(): SmsAgentDeps {
  return {
    complete: vi.fn(async () => {
      throw new Error('the model was called for something a template answers');
    }),
  };
}

/** Everything a quote and an order need, so nothing is left to ask. */
const COMPLETE: KnownCustomer = {
  name: 'Harbor Movers',
  email: 'ops@example.com',
  items: '4 cases of tan hot melt tape',
  fulfilment: 'will_call',
};

describe('intake: one ask, not four', () => {
  // Karim, 2026-08-19, off a real transcript: a first contact asked what stretch
  // film costs and got four requests joined by commas. The 2026-08-18 fix put
  // four questions in one message; this one asks for the thing that blocks the
  // next step and lets the rest travel with the quote.

  it('asks for one thing, and names none of the other three', () => {
    const ask = intakeAsk({});
    // missingFields still reports everything we do not have. It is the honest
    // answer to "what is missing"; the ask takes the first of them and stops.
    expect(missingFields({})).toEqual(['items', 'name', 'email', 'fulfilment']);
    expect(ask).toBe(
      `Send what you need and how many, and the team will price it. Or build it at ${BUSINESS.site}.`,
    );
    expect(ask).not.toMatch(/what name does it go under/i);
    expect(ask).not.toMatch(/best email/i);
    expect(ask).not.toMatch(/will call/i);
  });

  it('asks for one thing when one thing is missing, and names nothing else', () => {
    const ask = intakeAsk({ ...COMPLETE, name: null });
    expect(missingFields({ ...COMPLETE, name: null })).toEqual(['name']);
    expect(ask).toBe('We have the items. What name does it go under?');
    // The failure in the other direction, and it is the same failure: a
    // template that always asks for four things asks a customer who gave us
    // three of them for all three again.
    expect(ask).not.toContain('what you need and how many');
    expect(ask).not.toContain('email');
    expect(ask).not.toMatch(/will call/i);
  });

  it('asks for nothing at all when the record and the message cover it', () => {
    expect(missingFields(COMPLETE)).toEqual([]);
    expect(intakeAsk(COMPLETE)).toBe('The team has it and will send pricing.');
  });

  it('never asks for a phone number, because they texted us', () => {
    expect(intakeAsk({})).not.toMatch(/phone|number to reach|best number/i);
  });

  it('carries the will call address only when the choice is the thing left', () => {
    // It still saves a round trip for whoever gets it: somebody picking will
    // call does not then have to ask where we are. What changed is who gets it.
    // A first contact who asked a price is told nothing about our address,
    // which is failure 3 of the 2026-08-19 transcript.
    expect(missingFields({ ...COMPLETE, fulfilment: null })).toEqual(['fulfilment']);
    expect(intakeAsk({ ...COMPLETE, fulfilment: null })).toContain(BUSINESS.willCallAddress);
    expect(intakeAsk({})).not.toContain(BUSINESS.willCallAddress);
  });

  it('asks for the address only once delivery is the chosen half', () => {
    // Will call needs no address, so until they have picked delivery there is
    // nothing here to be short of.
    expect(missingFields({ ...COMPLETE, fulfilment: null })).not.toContain('address');
    expect(missingFields({ ...COMPLETE, fulfilment: 'delivery', address: null })).toEqual(['address']);
    expect(intakeAsk({ ...COMPLETE, fulfilment: 'delivery', address: null })).toBe(
      'For delivery we need the address, with the city and ZIP.',
    );
    // Will call needs no address at all, which is the whole reason the choice
    // is asked before it.
    expect(missingFields({ ...COMPLETE, fulfilment: 'will_call', address: null })).toEqual([]);
  });

  it('never opens with a greeting, a name, the company name, or a yes-word', () => {
    // Karim, 2026-08-19: strictly professional, not expressive. The yes is the
    // fact, not a word in front of it. "Happy to get that quote over" opened
    // every one of these replies until then, and it is the thing being removed.
    for (const known of [
      {},
      { product: 'tape' },
      { ...COMPLETE, name: null },
      { ...COMPLETE, fulfilment: null },
      { ...COMPLETE, fulfilment: 'delivery' as const, address: null },
      COMPLETE,
    ]) {
      const ask = intakeAsk(known);
      expect(ask).not.toMatch(/^(hi|hey|hello|dear)\b/i);
      expect(ask).not.toMatch(/^(happy|glad|sure|of course|yeah|yep|absolutely|great|no problem)\b/i);
      expect(ask).not.toContain(BUSINESS.name);
      expect(ask).not.toContain(String(COMPLETE.name));
    }
  });

  it('stays GSM-7 clean and inside two segments at its longest', () => {
    const longest = intakeAsk({});
    expect(nonGsm7(longest)).toEqual([]);
    // One ask fits one segment. It was two while it asked for four things.
    expect(longest.length).toBeLessThanOrEqual(160);
  });

  it('promises no price and no date of its own', () => {
    for (const known of [{}, COMPLETE, { ...COMPLETE, fulfilment: 'delivery' as const, address: null }]) {
      const ask = intakeAsk(known);
      expect(ask).not.toMatch(/\$|\bper case\b|\beach\b/i);
      expect(ask).not.toMatch(/\b(today|tomorrow|thursday|this week|next week)\b/i);
    }
  });
});

describe('intake: what the message already answered is never asked again', () => {
  it('reads the items when a product and a count are both there', () => {
    expect(readKnownFromMessage('how much for 4 cases of hot melt tape').items).toBeTruthy();
    expect(readKnownFromMessage('need 2 bundles of bubble wrap and 3 cases of clear tape').items).toBeTruthy();
  });

  it('refuses to call a bare product mention an order', () => {
    // A miss costs one clause in a message already going out. A wrong read
    // means we quote something the customer never asked for, so every reader
    // here is built to under-match.
    expect(readKnownFromMessage('what do you charge for tape').items).toBeUndefined();
    expect(readKnownFromMessage('how much for a pallet').items).toBeUndefined();
    expect(readKnownFromMessage('price list please').items).toBeUndefined();
  });

  it('reads an email', () => {
    expect(readKnownFromMessage('send it to ben@harbormovers.example please').email).toBe('ben@harbormovers.example');
  });

  it('reads an address, and does not mistake a spec or a quantity for one', () => {
    expect(readKnownFromMessage('deliver to 100 Example St, Springfield 90000').address).toBeTruthy();
    expect(readKnownFromMessage('1500 feet on a roll right').address).toBeUndefined();
    expect(readKnownFromMessage('make it 5 rolls').address).toBeUndefined();
  });

  it('reads a fulfilment choice, but not out of a question about both', () => {
    expect(readKnownFromMessage('we will pick it up').fulfilment).toBe('will_call');
    expect(readKnownFromMessage('can you deliver it').fulfilment).toBe('delivery');
    // Asking about both halves is a question, not a choice. Reading a decision
    // out of it would skip the only thing they actually asked.
    expect(readKnownFromMessage('can I pick it up or do you deliver').fulfilment).toBeUndefined();
  });

  it('never reads a name out of free text', () => {
    // Deliberate. "this is Sam from Harbor Movers" and "tell Sam I called"
    // are the same shape, and the cost of confusing them is not a clumsy
    // question, it is an invoice under the wrong name.
    expect(readKnownFromMessage('this is Sam from Harbor Movers').name).toBeUndefined();
  });

  it('lets a fresh answer in the message beat the record', () => {
    const merged = knownFor('ship it to 100 Example St, Springfield 90000', {
      name: 'Harbor Movers',
      address: '200 Example Rd, Shelbyville 90002',
    });
    expect(merged.address).toContain('100 Example St');
    expect(merged.name).toBe('Harbor Movers');
  });
});

describe('intake: the quote template is the ask', () => {
  it('asks for the count alone when the message already named a product', async () => {
    const d = await draftSmsReply('what do you charge for tape', neverCalled());
    expect(d.intent).toBe('pricing');
    expect(d.autoSend).toBe(true);
    // They said tape. Asking what they need is re-asking the question they just
    // answered, so the one ask is the count.
    expect(d.reply).toBe('We stock it. How many do you need?');
    expect(d.reply).not.toMatch(/what name does it go under/i);
  });

  it('skips the name when the contact row already has one', async () => {
    const d = await draftSmsReply('what do you charge for tape', neverCalled(), { name: 'Harbor Movers' });
    expect(d.reply).not.toMatch(/what name does it go under/i);
    expect(d.reply).toContain('How many do you need?');
  });

  it('skips everything the one message already answered', async () => {
    const d = await draftSmsReply(
      'how much for 4 cases of hot melt tape delivered to 100 Example St, Springfield 90000, invoice to ops@example.com',
      neverCalled(),
      { name: 'Harbor Movers' },
    );
    // Items, email, address and the fulfilment choice all came in that text and
    // the name was on file, so there is nothing left to ask.
    expect(d.reply).toBe('The team has it and will send pricing.');
    expect(d.autoSend).toBe(true);
  });

  it('leaves the other five templates the same sentence for everybody', async () => {
    const known = { name: 'Harbor Movers', email: 'ops@example.com' };
    const withRecord = await draftSmsReply('what are your hours', neverCalled(), known);
    expect(withRecord.reply).toBe(renderTemplate('hours'));
  });
});

describe('the fulfilment choice rides along with the quote', () => {
  // Karim, 2026-08-18: a quote under the ceiling has to let the customer pick
  // will call or delivery in the same message, not in a round trip after it.

  it('offers both halves with the facts needed to choose', () => {
    expect(FULFILMENT_CHOICE_SMS).toContain(BUSINESS.willCallAddress);
    expect(FULFILMENT_CHOICE_SMS).toContain(BUSINESS.hours);
    expect(FULFILMENT_CHOICE_SMS).toMatch(/orders in by Tuesday go out on Thursday/i);
  });

  it('names no date for the order in front of it', () => {
    // The cadence is a standing fact. "Yours goes out Thursday" is a promise
    // about one order and is a person's to make.
    expect(FULFILMENT_CHOICE_SMS).not.toMatch(/\byour(s)?\b|\byou'll\b|\bwe will have\b/i);
  });

  it('states no figure the business does not publish', () => {
    expect(unpublishedNumber(FULFILMENT_CHOICE_SMS)).toBeNull();
    expect(nonGsm7(FULFILMENT_CHOICE_SMS)).toEqual([]);
  });

  it('attaches to a priced quote as one message', () => {
    const composed = withFulfilmentChoice('4 cases of tan hot melt tape comes to 184.00 plus tax.');
    expect(composed.startsWith('4 cases')).toBe(true);
    expect(composed).toContain(FULFILMENT_CHOICE_SMS);
    expect(composed).not.toContain('\n');
  });
});

describe('a product question is answered out of the facts', () => {
  /** Captures the system prompt the agent hands the model. */
  function capture(): { deps: SmsAgentDeps; system: () => string } {
    let seen = '';
    return {
      deps: {
        complete: async (system: string) => {
          seen = system;
          return { intent: 'products', reply: 'Half inch bubble, so it takes a real knock.' };
        },
      },
      system: () => seen,
    };
  }

  async function prompt(): Promise<string> {
    const c = capture();
    // Deliberately outside every template pattern, so this reaches the model.
    await draftSmsReply('how thick is the bubble wrap', c.deps);
    return c.system();
  }

  it('hands the model every checkable fact, so it has something true to answer with', async () => {
    const system = await prompt();
    for (const p of BUSINESS.products) {
      expect(system, p.name).toContain(p.name);
      for (const fact of p.facts) expect(system, `${p.name}: ${fact}`).toContain(fact);
    }
  });

  it('tells it to answer and stop, not to recite the list', async () => {
    const system = await prompt();
    expect(system).toMatch(/never recite the list/i);
    expect(system).toMatch(/never sell/i);
  });

  it('leads with the eighteen inch when more than one product is in play', async () => {
    // Karim's order, 2026-08-18. `rank` lives in brief.ts and BUSINESS.products
    // is stored in it, so this reads the lead rather than naming it.
    const system = await prompt();
    expect(system).toContain(`lead with the ${BUSINESS.products[0].name}`);
  });

  it('never describes the eighteen inch as machine-only', async () => {
    // It was described that way in the spoken list and it was a factual error:
    // the supplier sheet calls it hand-applied. A caller with no wrapping
    // machine was told out loud that our lead product was not for them.
    const system = await prompt();
    expect(system).toMatch(/hand-applied, so no machine is needed/i);
    expect(system).not.toMatch(/for machines\b|machine only|machine-only/i);
  });

  it('refuses to reason its way past the facts it was given', async () => {
    const system = await prompt();
    expect(system).toMatch(/not written above/i);
    expect(system).toMatch(/Do not reason your way/i);
  });
});

describe('the number guard covers everything the catalogue states about itself', () => {
  // The allowlist is walked out of BUSINESS rather than listed by hand, which
  // is what the 2026-08-18 rename broke: the list named contents, spec and
  // perPallet, and the new names put a figure in `name` itself.

  it('passes every figure in every product name', () => {
    for (const p of BUSINESS.products) expect(unpublishedNumber(p.name), p.name).toBeNull();
  });

  it('passes every figure in every fact we are allowed to state', () => {
    for (const p of BUSINESS.products) {
      for (const fact of p.facts) expect(unpublishedNumber(fact), `${p.name}: ${fact}`).toBeNull();
    }
  });

  it('passes a whole reply built out of a product name and its facts', () => {
    for (const p of BUSINESS.products) {
      const reply = `${p.name}: ${p.facts[0]}. ${p.spec}.`;
      expect(unpublishedNumber(reply), reply).toBeNull();
    }
  });

  it('still holds a figure nobody published', () => {
    // A price at a value the catalogue happens to state is MONEY's to catch,
    // not this guard's; the two halves fail in opposite directions on purpose.
    expect(unpublishedNumber('Carton sealing tape is 46 a case.')).toBe(46);
    expect(unpublishedNumber('We have 87 cases on the shelf.')).toBe(87);
    expect(unpublishedNumber('Your order number is 10432.')).toBe(10432);
  });
});
