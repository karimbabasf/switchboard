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
 * SECOND RERUN, SAME DAY, because that sheet still got the pace wrong. Every
 * candidate was rendered at one shared speed, so it silently tested two things
 * at once: how a voice sounds, and how it survives being stretched to a target.
 * abbie won it and then had to run at 0.70, because her natural opener is 5.23s
 * against a 7.40s target. Karim, on the result: "the tone is not professional at
 * all... so down-pitched, as if the voice were slowed down." A 30 percent stretch is
 * where that comes from. The sheet now renders each candidate at the speed it
 * would really ship at, and the shortlist is voices already near target at 1.0.
 *
 * The incumbent always stays on the sheet, at the speed it is running today. A
 * bake-off without it tells you which candidate you like, not whether it beats
 * what you have.
 *
 * THREE THINGS THIS RENDERS THAT THE OLD SHEET DID NOT
 *
 *  1. The OPENER, the actual sentence Karim could not follow. The old sheet
 *     rendered GREETING, five words long, which is the one line on this call
 *     that no voice can fail.
 *  2. Each candidate at its OWN pace, nested under `voice_settings`, which is
 *     the only place the field works: a top-level `voice_speed` is accepted and
 *     silently ignored, measured at 6.4s against a 6.7-7.4s baseline where the
 *     nested form gave 15.1s.
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
import { BRIDGE, OPENER, SPOKEN_LIST } from '../lib/agent/brief.ts';

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
 * The opener is what every caller hears cold, before they have tuned into the
 * voice at all, and it carries "Acme U S A", which Karim could not make out on
 * 2026-08-14. The list answer is the most-asked question on the line and the
 * longest thing this voice says, so it is where a character shows up.
 */
const LINES: { slug: string; text: string }[] = [
  { slug: '1-opener', text: OPENER },
  // The single most-asked question on the line, in the words it now answers it
  // with. This is the clip that carries the tone complaint: it is long enough to
  // hear a character in, and it ends on the question the whole call turns on.
  { slug: '2-list', text: `Yeah, definitely. ${SPOKEN_LIST} ${BRIDGE}` },
];

interface Candidate {
  id: string;
  why: string;
  /**
   * The speed this candidate is judged at, defaulting to its natural pace.
   *
   * THE POINT OF THE 2026-08-14 SECOND RERUN. Every voice was being rendered at
   * one shared number, which quietly made the sheet a test of two different
   * things: how a voice sounds, and how it survives being stretched. abbie won
   * that sheet and then had to run at 0.70 to hit the pace Karim approved,
   * because her natural opener is 5.23s against a 7.40s target. A 30 percent
   * stretch is where drawl comes from, and Karim's word for the result was that
   * she sounded "down-pitched, as if the voice were slowed down".
   *
   * Measured, since pitch was the obvious suspect and pitch was innocent: median
   * F0 is 246Hz at 1.0 and 258Hz at 0.70, so the stretch is not resampling and
   * the voice is not being pitched down. What changes is duration alone, which
   * is exactly what a drawl is.
   *
   * So the sheet now renders each candidate at the speed it would actually ship
   * at, and the shortlist is voices whose NATURAL pace is already near target.
   * Picking a voice and then fighting it with a multiplier is the mistake.
   */
  speed?: number;
}

const CANDIDATES: Candidate[] = [
  // The control is what Karim heard and disliked, at the speed he heard it.
  { id: 'Telnyx.Natural.abbie', speed: 0.7, why: 'THE CONTROL: current line, stretched 30% to hit the pace' },
  {
    id: 'Telnyx.NaturalHD.luna',
    why: 'Rime Arcana, 7.60s natural against a 7.40s target: the only one needing no stretch at all',
  },
  { id: 'Telnyx.NaturalHD.astra', why: 'Rime Arcana, 8.61s natural, the quality tier' },
  // Ultra ids are UUIDs. The docs name voices "Telnyx.Ultra.Clara" and no such
  // id exists on this account: every one of the 772 Ultra rows is a UUID, and a
  // name off a docs page rendered a 400. The human name is in the `name` field,
  // which is why it is written out here. Ultra is also the only model with
  // Expressive Mode, which the assistant already has a switch for and does not
  // use, so it is the one candidate that comes with a second lever behind it.
  {
    id: 'Telnyx.Ultra.358e650d-ac0b-4a74-b14f-aca3daa40d79',
    why: 'Ultra "Kendra - Smooth Communicator", 8.20s natural, labelled clear and professional',
  },
  {
    id: 'Telnyx.Ultra.1242fb95-7ddd-44ac-8a05-9e8a22a6137d',
    why: 'Ultra "Cindy - Receptionist", 8.76s natural, literally the job',
  },
  {
    id: 'Telnyx.Ultra.0ee8beaa-db49-4024-940d-c7ea09b590b3',
    why: 'Ultra "Morgan - Executive Expert", for when professional is the whole complaint',
  },
  { id: 'AWS.Polly.Joanna-Neural', why: 'the cheap known-decent baseline, so the sheet has a floor' },
];

async function render(voice: string, text: string, path: string, speed: number): Promise<void> {
  const res = await fetch(`${BASE}/text-to-speech/speech`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    // Nested, not top level. See the header comment: top level is ignored.
    body: JSON.stringify({ voice, text, voice_settings: { voice_speed: speed } }),
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

console.log('\nEach candidate at its OWN pace: natural 1.0 unless the entry says otherwise.\n');

for (const candidate of CANDIDATES) {
  for (const line of LINES) {
    const mp3 = `${OUT}/${candidate.id}.${line.slug}.mp3`;
    try {
      await render(candidate.id, line.text, mp3, candidate.speed ?? 1);
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
