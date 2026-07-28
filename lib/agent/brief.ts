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

export function systemPrompt(): string {
  // Filled in properly in Task 2. This stub only has to satisfy the guarantees
  // the tests assert, so the facts module can land and be reviewed on its own.
  return [
    `You answer the phone for ${BUSINESS.name}, a moving and packing supply company.`,
    `Hours: ${BUSINESS.hours}. ${BUSINESS.fulfilment}`,
    'You never quote a price, a rate, or a total. Pricing goes out with a written quote from the team.',
    'Pallet quantities are approximate and have not been confirmed against the warehouse. Say so whenever you give one.',
  ].join('\n');
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
