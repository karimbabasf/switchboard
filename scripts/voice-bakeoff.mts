/**
 * Renders every candidate voice saying the real lines, so the choice is made by
 * listening rather than by reading a list of names.
 *
 *   pnpm voice:bakeoff
 *
 * Same rule as type specimens: never pick from a catalogue. A voice that sounds
 * gorgeous in a browser can turn to mud on an 8kHz mu-law phone line, and that
 * is the only playback that counts, so listen to these on a phone speaker.
 *
 * Two lines per candidate, deliberately:
 *  1. The greeting, which is the first thing every caller hears.
 *  2. A line thick with product names and quantities, which is what this voice
 *     will actually spend its life saying. Plenty of voices handle a warm hello
 *     and then fall apart on "four cases of hand wrap film".
 *
 * Candidate ids were read from GET /v2/text-to-speech/voices on 2026-07-28.
 * That endpoint returns its rows under `voices`, not `data`, and an id that is
 * not on the list is accepted and silently ignored, so ids here are not guesses.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { GREETING } from '../lib/agent/brief.ts';

const BASE = 'https://api.telnyx.com/v2';
const OUT = 'out/voices';

function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`\nMissing required env var: ${name}\n`);
    process.exit(1);
  }
  return v.trim();
}

/**
 * The second line is the one that decides it. It carries two product names, two
 * quantities and a day, which is the exact shape of a real Akme sentence.
 */
const LINES: { slug: string; text: string }[] = [
  { slug: '1-greeting', text: GREETING },
  {
    slug: '2-order',
    text: 'I have got you down for four cases of hand wrap film and two bundles of newsprint, going out Thursday.',
  },
];

interface Candidate {
  id: string;
  why: string;
}

const CANDIDATES: Candidate[] = [
  { id: 'Telnyx.Bayan.Amanda', why: 'native, current default, en-US female' },
  { id: 'Telnyx.Bayan.Barbara', why: 'native, second female read' },
  { id: 'Telnyx.Bayan.Brian', why: 'native male, in case a male voice suits the trade better' },
  { id: 'XAI.eve', why: 'xAI, different character to the Telnyx set' },
  { id: 'XAI.ara', why: 'xAI, second female read' },
  { id: 'AWS.Polly.Joanna-Neural', why: 'the cheap known-decent baseline, so the sheet has a floor' },
];

async function render(voice: string, text: string, path: string): Promise<void> {
  const res = await fetch(`${BASE}/text-to-speech/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ voice, text }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }

  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

await mkdir(OUT, { recursive: true });

const failures: string[] = [];

for (const candidate of CANDIDATES) {
  for (const line of LINES) {
    const path = `${OUT}/${candidate.id}.${line.slug}.mp3`;
    try {
      await render(candidate.id, line.text, path);
      console.log(`  ok    ${path}`);
    } catch (err) {
      // One bad candidate must not cost the whole sheet: the point is to end up
      // with something to listen to, not to be right about every id.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  FAIL  ${candidate.id} (${line.slug}): ${message}`);
      failures.push(candidate.id);
    }
  }
}

console.log(`\nWrote to ${OUT}/`);
console.log('\nHow to judge these, in order:');
console.log('  1. Play them on a PHONE speaker, not laptop speakers and not headphones.');
console.log('     The line is 8kHz mu-law and it is unkind to voices that demo well.');
console.log('  2. Ignore the greeting at first. Listen to the order line: product');
console.log('     names and quantities are what this voice says all day.');
console.log('  3. Shortlist two, then hear them in conversation on a real call before');
console.log('     committing. A voice can pass here and still feel wrong with turn-taking.');
console.log('\nThen put the winner in .env.local as TELNYX_TTS, make it the default in');
console.log('lib/telnyx/assistant.ts with one line on why it beat the runner-up, and run');
console.log('pnpm assistant:sync.\n');

if (failures.length > 0) {
  console.error(`Candidates that would not render: ${[...new Set(failures)].join(', ')}`);
  console.error('Check them against GET /v2/text-to-speech/voices (rows are under `voices`).\n');
  process.exit(1);
}
