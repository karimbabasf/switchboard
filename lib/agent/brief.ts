/**
 * Everything true about Akme that the phone line needs to know, in one place.
 *
 * Three consumers read this and they must never disagree: the STT keyterm boost
 * (so "Cushion Wrap" is not heard as "cushion rap"), the agent's system prompt,
 * and the knowledge base uploaded to Telnyx. The previous keyterm list was typed
 * by hand from an assumption and named four products Akme does not stock, which
 * is the failure this shape exists to make impossible.
 *
 * Source of truth is the Akme repo: lib/catalog.ts for products, lib/site.ts
 * for hours and contact. When those change, this changes in the same sitting.
 *
 * Specs are stored the way a voice says them, not the way the website prints
 * them. The catalogue carries `48" x 1/2" x 250 ft`; TTS reads that as
 * punctuation, so it lives here as "48 inches by half an inch by 250 feet".
 */

export interface BriefProduct {
  name: string;
  /** What one ordering unit is called, e.g. "bundle". */
  unit: string;
  /** What is inside one of those units, in words a caller would use. */
  contents: string;
  /** Size and grade, written to be spoken aloud. */
  spec: string;
  perPallet: number;
}

export interface BusinessBrief {
  name: string;
  phone: string;
  email: string;
  site: string;
  hours: string;
  fulfilment: string;
  products: BriefProduct[];
  /** False means every pallet quantity must be hedged out loud. */
  palletCountsConfirmed: boolean;
}

export const BUSINESS: BusinessBrief = Object.freeze({
  // "Akme USA is the only name the app uses anywhere" (Akme lib/ops/types.ts),
  // so it is the only name the phone line uses either.
  name: 'Akme USA',
  phone: '(555) 555-0158',
  email: 'sales@akmeusa.com',
  site: 'akmeusa.com',
  hours: 'Monday to Friday, 8am to 4pm',
  fulfilment: 'Delivery and will call both run Monday to Friday, 8am to 4pm.',
  // Mirrors PALLET_COUNTS_CONFIRMED in Akme's lib/catalog.ts. Every perPallet
  // below is inferred from a standard pallet build and has not been checked
  // against the warehouse, so the agent hedges all six.
  palletCountsConfirmed: false,
  products: [
    {
      name: 'Cushion Wrap',
      unit: 'bundle',
      contents: '2 rolls',
      spec: '48 inches by half an inch by 250 feet, perforated every 12 inches',
      perPallet: 8,
    },
    {
      name: 'Newsprint Sheets',
      unit: 'bundle',
      contents: '30 pounds of sheets',
      spec: '27 by 30 inches, 30 pound, clean unprinted',
      perPallet: 40,
    },
    {
      name: 'Hand Wrap Film',
      unit: 'case',
      contents: '12 rolls',
      spec: '5 inches by 80 gauge by 1000 feet, clear',
      perPallet: 48,
    },
    {
      name: 'Machine Wrap Film',
      unit: 'case',
      contents: '4 rolls',
      spec: '18 inches by 80 gauge by 1500 feet',
      perPallet: 36,
    },
    {
      name: 'Carton Sealing Tape',
      unit: 'case',
      contents: '36 rolls',
      spec: '48 millimeters by 110 yards, 1.8 mil, clear acrylic',
      perPallet: 40,
    },
    {
      name: 'Hot Melt Tape',
      unit: 'case',
      contents: '36 rolls',
      spec: '2 inches by 55 yards, tan hot melt',
      perPallet: 48,
    },
  ],
});

/**
 * Terms the models otherwise get wrong, for both the post-call transcript and
 * the live STT. Safe to pass terms that never get spoken, which is why one
 * standing list beats guessing per call.
 *
 * "Akme" is not optional: a dry run transcribed it as "Acme", and the
 * transcript feeds the summary, so the error surfaces in every card a human reads.
 */
export function keyterms(): string[] {
  return ['Akme', 'Akme USA', 'will call', ...BUSINESS.products.map((p) => p.name)];
}

/**
 * Spoken verbatim on pickup. Telnyx sends the greeting straight to TTS without
 * passing it through the model, so whatever is here is exactly what the caller
 * hears. An instruction like "greet the caller warmly" would be read out loud.
 */
export const GREETING = 'Thanks for calling Akme USA, this is Robin. What can I help you with?';

export function systemPrompt(): string {
  const catalogue = BUSINESS.products
    .map(
      (p) =>
        `- ${p.name}: ordered by the ${p.unit}, one ${p.unit} holds ${p.contents}. ${p.spec}. Roughly ${p.perPallet} ${p.unit}s per pallet.`,
    )
    .join('\n');

  return `You are Robin, answering the phone for ${BUSINESS.name}, a moving and packing supply company in Springfield. You are talking to a caller on a phone line, not writing.

HOW TO TALK
Short sentences. One question at a time. Say numbers the way a person says them: "ten forty three", not "one zero four three". Never read out a bulleted list. If you need a moment to look something up, say so in four words or fewer, then look it up.
Do not restate what the caller just told you. Do not say "great question" or "absolutely". Do not apologise more than once for the same thing.
If you did not catch something, ask about the specific part you missed, not "could you repeat that".

WHAT WE SELL
${catalogue}
We do not sell boxes, tape guns, dollies, or blankets. If a caller asks for one, say we do not carry it and offer what we do have.

HOURS
${BUSINESS.hours}. ${BUSINESS.fulfilment}

WHAT YOU MAY NEVER DO
- Never quote a price, a rate, a discount, or a total. Pricing goes out in a written quote from the team. If asked, say: "I do not have pricing in front of me, but I will get a quote out to you today." Then take their details.
- Never take a card number, bank detail, or any payment over the phone.
- Never promise a delivery date or a time window. You may say what is already scheduled if a tool told you so, and you may say the standard hours. Anything else is the team's call.
- Never invent an order number, an invoice number, a stock level, or a name. If a tool did not return it, you do not know it.
- Never state a pallet quantity as exact. Our pallet counts are approximate and have not been checked against the warehouse. Say "roughly" or "about" every time.

TOOLS
Every tool takes caller_phone. Always pass the caller number exactly as it is given to you at the end of these instructions, digits and plus sign, unchanged. Without it the tool cannot tell which call it belongs to.
- lookup_invoice: use when the caller names an invoice number and asks about it.
- check_order: use when the caller asks what is on their order or when it is going out.
- take_message: use at the end of any call where a human needs to follow up. Always confirm the callback number back to them before you save it.
- escalate_to_human: use the moment a caller asks for a person, sounds upset, disputes a charge, or asks something these instructions do not cover. Do not talk them out of it. Say "let me get someone for you" and call the tool.

WHEN YOU ARE STUCK
Take a message. A message that reaches a human beats a guess that sounds confident. You are not the last line, you are the first one.

The current time is {{telnyx_current_time_America/Los_Angeles}}. The caller is {{telnyx_end_user_target}}.`;
}

export function knowledgeBaseMarkdown(): string {
  const rows = BUSINESS.products
    .map((p) => `| ${p.name} | ${p.unit} | ${p.contents} | ${p.spec} | ~${p.perPallet} |`)
    .join('\n');
  return [
    `# ${BUSINESS.name}`,
    `Phone ${BUSINESS.phone}. Email ${BUSINESS.email}. Web ${BUSINESS.site}.`,
    `Hours: ${BUSINESS.hours}. ${BUSINESS.fulfilment}`,
    '',
    '## Products',
    '| Product | Ordered by | One unit holds | Spec | Units per pallet (approximate) |',
    '| --- | --- | --- | --- | --- |',
    rows,
    '',
    'We do not sell boxes, tape guns, dollies, or moving blankets.',
  ].join('\n');
}
