import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { carrierIntent, draftCarrierReply, isBargaining, isCarrierKeyword } from '../lib/agent/sms';
import {
  HELP_SMS,
  RELAY_TEMPLATE_NAMES,
  TEMPLATES,
  matchTemplate,
  nonGsm7,
  renderRelayTemplate,
  renderTemplate,
} from '../lib/agent/templates';
import type { TemplateKey } from '../lib/agent/templates';

/**
 * What this repo is still allowed to say to a customer, and it is one sentence.
 *
 * Every other reply was deleted on 2026-08-24. Two brains writing at the same
 * customer is the failure the 2026-08-20 spec names: the same question got two
 * different answers depending on whether they emailed or texted, every rule
 * change needed both repos, and a decline from Akme was read here as permission
 * to draft a template answer. Akme writes the words now. These tests are what
 * stops that being a comment somebody quietly stops honouring.
 */

const TEMPLATE_KEYS = Object.keys(TEMPLATES) as TemplateKey[];

function source(relative: string): string {
  const path = fileURLToPath(new URL(`../${relative}`, import.meta.url));
  // Comments carry prose by design and explain exactly this rule, so they are
  // stripped rather than searched. Block comments first, then line comments.
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every sentence-shaped literal in a module, which is the shape of something
 * written at a person rather than at a log.
 *
 * Deliberately blunt: 40 characters and a terminating full stop, question mark
 * or exclamation. An error message written as a sentence would trip it, and that
 * is the right trade, because the thing being defended against is somebody
 * adding one quick answer to this repo and nothing anywhere noticing.
 */
function authoredSentences(relative: string): string[] {
  const out: string[] = [];
  // Every literal, short ones included, so the scan consumes quotes in pairs
  // left to right. Matching only long ones lets a closing quote pair with a
  // later opening one and swallow the code between them.
  for (const m of source(relative).matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)) {
    const text = m[2].trim();
    if (text.length >= 40 && /[.?!]$/.test(text)) out.push(text);
  }
  return out;
}

describe('one writer: the carrier keeps its words, we keep none', () => {
  /**
   * `catalogue` is the deviation from the plan and it is deliberate.
   *
   * The voice agent's text_me_the_list sends `renderTemplate('catalogue')` mid
   * call (lib/agent/tools.ts), and repointing that tool is out of scope here. It
   * is not on the inbound reply path and it is not a second answer to a text, so
   * it keeps its export and the SMS caller is what was deleted.
   */
  it('has two templates left: the carrier reply, and the one the phone line sends', () => {
    expect(TEMPLATE_KEYS.sort()).toEqual(['catalogue', 'help']);
  });

  it('holds no customer-facing sentence on the inbound path', () => {
    expect(authoredSentences('lib/agent/sms.ts')).toEqual([]);
    expect(authoredSentences('lib/telnyx/sms.ts')).toEqual([]);
  });

  it('holds nothing in templates.ts outside the strings it is allowed to produce', () => {
    // The one file still allowed to carry a sentence, and every sentence in it
    // has to end up inside something it is allowed to produce. A template added
    // here without a name in one of these two lists fails this the day it lands.
    //
    // THE ALLOWED SET GREW ON 2026-08-27 and the rule did not. The order spec
    // gives Akme an SMS sender at POST /api/relay/sms, because Akme has no
    // number and a recognition code has to arrive from the 10DLC registered one.
    // That endpoint takes a TEMPLATE NAME AND VARIABLES, never a body, so the
    // three sentences it can produce have to live here, in the repo that holds
    // the carrier obligation. Akme still decides whether to send and to whom;
    // these are transactional strings with no opinion in them, not a second
    // answer to a customer's question, which is what the deletion was about.
    const relay = RELAY_TEMPLATE_NAMES.map(
      (name) => renderRelayTemplate(name, { code: '000000', url: 'https://akmeusa.com/order/x' }) ?? '',
    ).join('\n');
    const rendered = `${renderTemplate('catalogue')}\n${renderTemplate('help')}\n${relay}`;
    const stray = authoredSentences('lib/agent/templates.ts')
      // The GSM 03.38 alphabet is a character set, not a sentence. It ends in a
      // question mark because the alphabet contains one.
      .filter((s) => !s.includes('ΦΓΛΩΠΨΣΘΞ'))
      // Both survivors are template literals, so their ${} tokens are not in the
      // rendered output. The fixed halves either side of them are.
      .flatMap((s) => s.split(/\$\{[^}]*\}/))
      .map((part) => part.trim())
      .filter((part) => part.length >= 10 && !rendered.includes(part));
    expect(stray).toEqual([]);
  });

  it('keeps HELP answering itself with the registered words', () => {
    expect(draftCarrierReply('help')).toEqual({ intent: 'help', reply: HELP_SMS, autoSend: true });
  });

  it('says nothing at all on either opt branch', () => {
    // The carrier sends its own confirmation on a registered campaign, and two
    // messages for one word reads as a system that did not understand.
    expect(draftCarrierReply('opt_out')).toEqual({ intent: 'opt_out', reply: '', autoSend: false });
    expect(draftCarrierReply('opt_in')).toEqual({ intent: 'opt_in', reply: '', autoSend: false });
  });
});

describe('the three carrier keywords are three different things', () => {
  // Until 2026-08-03 one regex named OPT_OUT matched stop, help, start AND
  // unstop, and every hit stamped opted_out_at and sent nothing. Texting HELP
  // blacklisted the customer forever; so did START, which is an opt-IN. Found
  // while preparing the 10DLC campaign, which makes you declare this behaviour.

  it.each(['STOP', 'stop', ' Stop ', 'UNSUBSCRIBE', 'cancel', 'quit', 'END'])('%s is an opt-out', (body) => {
    expect(carrierIntent(body)).toBe('opt_out');
  });

  it.each(['START', 'start', 'UNSTOP', 'subscribe'])('%s opts back IN, it does not opt out', (body) => {
    expect(carrierIntent(body)).toBe('opt_in');
  });

  it.each(['HELP', 'help', ' Help ', 'INFO'])('%s asks for help, and is not an opt-out', (body) => {
    expect(carrierIntent(body)).toBe('help');
  });

  it('a sentence containing the word help is a question, not a keyword', () => {
    // "help" alone is the keyword. "can you help me with pricing" is a customer.
    expect(carrierIntent('can you help me figure out what I need')).toBeNull();
    expect(isCarrierKeyword('can you help me figure out what I need')).toBe(false);
  });

  it('reports every keyword class as a keyword, so none of them reaches a timeline', () => {
    for (const body of ['STOP', 'START', 'HELP']) expect(isCarrierKeyword(body), body).toBe(true);
    expect(isCarrierKeyword('40 cases of tape please')).toBe(false);
    expect(isCarrierKeyword('   ')).toBe(false);
  });

  /**
   * The registered HELP reply, word for word.
   *
   * This is the exact text declared on the 10DLC campaign (brand BXXXXXX). A
   * registered HELP reply that does not match what the number actually sends is
   * the kind of mismatch that gets a campaign pulled, so it is the one string in
   * this repo that may not be reworded without changing the campaign first.
   */
  it('carries everything the carriers require', () => {
    expect(HELP_SMS).toContain('Akme USA'); // who
    expect(HELP_SMS).toMatch(/STOP/); // how to leave
    expect(HELP_SMS).toMatch(/rates may apply/i); // the cost disclosure
    expect(HELP_SMS).toMatch(/\(555\)|@/); // a way to reach a person
  });
});

describe('bargaining is detected here and answered nowhere', () => {
  // Karim's rule, 2026-08-03: "as soon as the customer begins to bargain we ping
  // it in the tg group. no bargaining at all." The stop stays deterministic and
  // stays in this repo, because a stop that has to survive a model call is not a
  // stop. The sentence moved to Akme, through the desk's `hint` field.
  it.each([
    "what's your best price on carton tape",
    'any chance of a discount on 10 pallets',
    'that seems too expensive',
    'can you do better on the film',
    'I can get it cheaper down the road',
    'do you do bulk pricing',
    'willing to negotiate?',
  ])('reads %j as bargaining', (body) => {
    expect(isBargaining(body)).toBe(true);
  });

  it.each(['40 cases of clear tape please', 'what size is the hand wrap', '   ', ''])(
    'leaves %j alone',
    (body) => {
      expect(isBargaining(body)).toBe(false);
    },
  );
});

/**
 * matchTemplate is no longer a template selector. It is the phone line's
 * "is this a pricing request" classifier, and take_message uses it to file a
 * spoken message onto the quote queue (lib/agent/tools.ts). `quote` was always
 * the first matcher, so trimming the other four cannot change what it returns
 * for that one comparison.
 */
describe('the phone line can still tell a pricing request from a message', () => {
  it.each(['what do you charge for tape', 'how much for a pallet', 'price list please', 'what are your rates'])(
    'reads %j as a quote request',
    (body) => {
      expect(matchTemplate(body)).toBe('quote');
    },
  );

  it.each(['what do you sell', 'where are you located', 'do you deliver', 'what are your hours', 'hi', ''])(
    'reads %j as something else, which files as a plain message',
    (body) => {
      expect(matchTemplate(body)).toBeNull();
    },
  );

  it('reads a paragraph as a story rather than a question', () => {
    expect(matchTemplate(`how much ${'x'.repeat(161)}`)).toBeNull();
  });
});

describe('what is left is GSM-7 safe and short', () => {
  it.each(TEMPLATE_KEYS)('renders %s with no character outside GSM 03.38', (key) => {
    expect(nonGsm7(renderTemplate(key))).toEqual([]);
  });

  it.each(TEMPLATE_KEYS)('keeps %s within 3 SMS segments', (key) => {
    const text = renderTemplate(key);
    // 160 characters fit a single GSM-7 segment; past that, concatenated SMS
    // drops to 153 usable characters per segment (the other 7 go to the User
    // Data Header). 3 segments (459 characters) is the ceiling chosen here
    // because `catalogue`, which lists all six products on purpose, is the
    // longest anything in this file should ever need to be.
    const segments = text.length <= 160 ? 1 : Math.ceil(text.length / 153);
    expect(segments).toBeLessThanOrEqual(3);
  });
});
