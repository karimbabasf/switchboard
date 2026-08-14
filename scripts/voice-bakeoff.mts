/**
 * Renders every candidate voice saying the real lines, so the choice is made by
 * listening rather than by reading a list of names.
 *
 *   pnpm voice:bakeoff
 *
 * Same rule as type specimens: never pick from a catalogue. A voice that sounds
 * gorgeous in a browser can turn to mud on an 8kHz mu-law phone line, and that
 * is the only playback that counts.
 *
 * WHY THIS SHEET WAS RERUN (2026-08-14)
 *
 * The first sheet, on 2026-07-28, had six candidates and three of them were
 * `Telnyx.Bayan.*`, which won. Nobody knew then what Bayan is: Telnyx's ARABIC
 * model, 113 speakers across 13 Arabic dialects, with a set of English speakers
 * bolted on the side and 16kHz native audio. Four of its 4494 voices are English
 * female. `Telnyx.Natural` has 186 English voices, `NaturalHD` 39, `Ultra` 396,
 * and those are English-first models. The incumbent won a race it was the wrong
 * kind of runner for, because the sheet only had one kind of runner on it.
 *
 * Karim, off a test call on 2026-08-14: "no understanding of commas or
 * punctuation, it was just like one straight sentence... if I didn't know Akme
 * I don't think I would have understood a word of what she was saying."
 * Phrasing English at clause boundaries is exactly the thing an Arabic-first
 * model is not tuned to do, so the voice is now a suspect and not a given.
 *
 * Amanda stays on the sheet as the control. A bake-off without the incumbent
 * tells you which candidate you like, not whether it beats what you have.
 *
 * THREE THINGS THIS RENDERS THAT THE OLD SHEET DID NOT
 *
 *  1. The OPENER, the actual sentence Karim could not follow. The old sheet
 *     rendered GREETING, five words long, which is the one line on this call
 *     that no voice can fail.
 *  2. At voiceSpeed(), nested under `voice_settings`. A top-level `voice_speed`
 *     is accepted and silently ignored: measured on 2026-08-14, the opener at
 *     top-level 0.5 came back 6.4s against a 6.7-7.4s baseline, and the same
 *     number nested came back 15.1s. A sheet rendered at the wrong pace is a
 *     sheet of a voice this line will never use.
 *  3. An 8kHz mu-law copy, which is the phone line. The old sheet said "play it
 *     on a phone speaker", which is a proxy for band-limiting and a bad one:
 *     laptop-to-phone-speaker keeps every frequency the codec throws away.
 *
 * Candidate ids were read from GET /v2/text-to-speech/voices on 2026-08-14.
 * That endpoint returns its rows under `voices`, not `data`, and an id that is
 * not on the list is accepted and silently ignored, so ids here are not guesses.
 */
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { OPENER } from '../lib/agent/brief.ts';
import { voiceSpeed } from '../lib/telnyx/assistant.ts';

const run = promisify(execFile);

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
 * Two lines, and the second one decides it.
 *
 * The opener is what Karim complained about and what every caller hears cold,
 * before they have tuned into the voice at all. The order line carries two
 * product names, two quantities and a day, which is the exact shape of a real
 * Akme sentence and the thing this voice says all day. Plenty of voices handle
 * a warm hello and then fall apart on "four cases of hand wrap film".
 */
const LINES: { slug: string; text: string }[] = [
  { slug: '1-opener', text: OPENER },
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
  { id: 'Telnyx.Bayan.Amanda', why: 'THE CONTROL: current line, Arabic model, English bolted on, 16kHz' },
  { id: 'Telnyx.Natural.allison', why: 'Rime Mist, English-first, built for real-time agents' },
  { id: 'Telnyx.Natural.abbie', why: 'second Mist read, in case allison is the wrong character' },
  { id: 'Telnyx.NaturalHD.astra', why: 'Rime Arcana, the quality tier, 24kHz native' },
  { id: 'Telnyx.NaturalHD.luna', why: 'second Arcana read' },
  // Ultra ids are UUIDs. The docs name voices "Telnyx.Ultra.Clara" and no such
  // id exists on this account: every one of the 772 Ultra rows is a UUID, and a
  // name off a docs page rendered a 400. The human name is in the `name` field,
  // which is why it is written out here. Ultra is also the only model with
  // Expressive Mode, which the assistant already has a switch for and does not
  // use, so it is the one candidate that comes with a second lever behind it.
  {
    id: 'Telnyx.Ultra.1242fb95-7ddd-44ac-8a05-9e8a22a6137d',
    why: 'Ultra "Cindy - Receptionist", sub-100ms, literally the job',
  },
  {
    id: 'Telnyx.Ultra.358e650d-ac0b-4a74-b14f-aca3daa40d79',
    why: 'Ultra "Kendra - Smooth Communicator", clear and professional',
  },
  { id: 'AWS.Polly.Joanna-Neural', why: 'the cheap known-decent baseline, so the sheet has a floor' },
];

async function render(voice: string, text: string, path: string): Promise<void> {
  const res = await fetch(`${BASE}/text-to-speech/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    // Nested, not top level. See the header comment: top level is ignored.
    body: JSON.stringify({ voice, text, voice_settings: { voice_speed: voiceSpeed() } }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`${res.status} ${detail.slice(0, 200)}`);
  }

  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

/**
 * The phone line is 8kHz mu-law and it is unkind to voices that demo well. This
 * is the copy to judge on, and a missing ffmpeg costs the band-limited copy and
 * nothing else, because a sheet you can hear beats a sheet that would not build.
 */
async function toPhoneBand(src: string, dest: string): Promise<boolean> {
  try {
    await run('ffmpeg', ['-y', '-i', src, '-ar', '8000', '-ac', '1', '-c:a', 'pcm_mulaw', dest]);
    return true;
  } catch {
    return false;
  }
}

await mkdir(OUT, { recursive: true });

const failures: string[] = [];
let banded = 0;

console.log(`\nRendering at voice_speed ${voiceSpeed()}, the pace the line actually runs at.\n`);

for (const candidate of CANDIDATES) {
  for (const line of LINES) {
    const mp3 = `${OUT}/${candidate.id}.${line.slug}.mp3`;
    try {
      await render(candidate.id, line.text, mp3);
      const phone = `${OUT}/${candidate.id}.${line.slug}.phone.wav`;
      if (await toPhoneBand(mp3, phone)) banded += 1;
      console.log(`  ok    ${mp3}`);
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
if (banded === 0) {
  console.log('\nNo .phone.wav copies: ffmpeg is not on PATH. `brew install ffmpeg`, then');
  console.log('rerun, because the mp3s flatter every candidate equally and the line does not.');
}

console.log('\nHow to judge these, in order:');
console.log('  1. Play the .phone.wav files, not the mp3s. They are 8kHz mu-law, which is');
console.log('     the line. The mp3s are what the voice sounds like somewhere you do not work.');
console.log('  2. Play 1-opener first and ask ONE question: could a caller who has never');
console.log('     heard of us follow it? That is the whole complaint, in Karim\'s words:');
console.log('     "I don\'t think I would have understood a word of what she was saying."');
console.log('     Listen for the clause breaks. "Hi, this is Robin from Acme USA." should');
console.log('     land as a sentence and stop, not run into the next one.');
console.log('  3. Then 2-order: product names and quantities are what this voice says all day.');
console.log('  4. Compare every candidate against Telnyx.Bayan.Amanda, the current line. If');
console.log('     nothing clearly beats it, the voice was not the problem and the pace fix');
console.log('     was the whole fix, which is worth knowing before changing anything else.');
console.log('  5. Shortlist two, then hear them in conversation on a real call before');
console.log('     committing. A voice can pass here and still feel wrong with turn-taking.');
console.log('\nThen put the winner in .env.local as TELNYX_TTS, make it the default in');
console.log('lib/telnyx/assistant.ts with one line on why it beat the runner-up, and run');
console.log('pnpm assistant:sync AND deploy: the opener is spoken by our webhook and the');
console.log('greeting by Telnyx, so a voice change is live in two places or broken in one.\n');

if (failures.length > 0) {
  console.error(`Candidates that would not render: ${[...new Set(failures)].join(', ')}`);
  console.error('Check them against GET /v2/text-to-speech/voices (rows are under `voices`).\n');
  process.exit(1);
}
