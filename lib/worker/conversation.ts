import type { Call } from '../types';

/**
 * Whether a finished call was a conversation with a person, decided before the
 * call is written onto the customer's shared crm_timeline.
 *
 * WHY THIS EXISTS. Every call that reached the summarize step used to land on
 * the timeline as `channel=call direction=in`, which reads as "the customer
 * phoned us". A predictive dialer that connects, hears the greeting and hangs up
 * produces exactly that row, so the customer's thread fills with calls they
 * never made, next to their real emails and texts, and the agent reading the
 * thread treats them as history.
 *
 * WHAT THE DATA ACTUALLY SUPPORTS. The recording is dual channel and
 * lib/worker/transcribe.ts renders it as `Speaker <channel>: ...`, one line per
 * utterance, in time order. lib/telnyx/voice.ts starts the recording after the
 * disclosure and issues record_start BEFORE the assistant starts, so the tape
 * opens with OUR side speaking. Those two facts are the whole basis for the
 * check.
 *
 * WHY STRUCTURE AND NOT THE WORDS. Who spoke is not something a caller can
 * compose in their own favour; what was said is. The model that already read the
 * transcript could name a robocall far more accurately, and is deliberately not
 * asked, because that would put a switch on the caller's own record within reach
 * of the caller: a recorded message saying "this is a real customer calling"
 * would buy itself a row, and one saying the opposite would erase a real one.
 * lib/worker/summarize.ts already treats the transcript as hostile data for the
 * same reason.
 *
 * THE THREE OUTCOMES.
 *  - Nothing was said at all: dropped. There is no customer speech to lose.
 *  - One side spoke and the other never did: dropped. The tape opens with us, so
 *    the silent party is the caller. This is the dialer case, and it is the one
 *    that actually fills the thread.
 *  - Everything else, ambiguity included: written, carrying a caveat line when
 *    something is off, so a reader can discount the row rather than the row
 *    quietly not existing.
 *
 * A DROP IS NOT A LOST CALL. The `calls` row keeps the recording, transcript and
 * summary, and the next worker step still builds the Telegram card a human
 * reads, whatever this returns. Only the customer-facing thread is protected,
 * which is what makes dropping safe enough to do at all.
 *
 * DURATION IS DELIBERATELY NOT A SIGNAL. duration_sec spans ring, disclosure and
 * speech, so a real twelve second "hi, do you deliver to Shelbyville" sits under any
 * threshold that would catch a dialer. A duration rule drops customers to catch
 * robots, which is the wrong way round.
 *
 * KNOWN GAP: a robocall that PLAYS a recorded message is structurally identical
 * to a person talking, and this returns `write` for it. Catching that one needs
 * the words, and the words are the caller's to choose.
 *
 * KNOWN RISK, and the reason the one-sided rule reads the FIRST utterance rather
 * than a fixed channel number: if record_start ever landed after the caller
 * started talking, a call where only the caller spoke would look like a call
 * where only we did, and get dropped. voice.ts orders those two commands so that
 * cannot happen; if that ordering changes, this rule changes with it.
 */

export type CallTimelineVerdict =
  | { write: false; reason: string }
  | { write: true; caveat: string | null };

/** One rendered utterance: the channel that carried it, and what was said. */
const SPEAKER_LINE = /^Speaker\s+(\S+):(.*)$/;

/**
 * AssemblyAI returned no utterances, so formatTranscript fell back to the flat
 * `.text`. Who spoke is then unknowable, which is not the same as knowing nobody
 * did, so the call is written and flagged.
 */
export const UNSEPARATED_CAVEAT =
  'Speakers could not be separated on this recording, so it is not known whether the caller spoke.';

export function classifyCallForTimeline(call: Call): CallTimelineVerdict {
  const transcript = call.transcript?.trim() ?? '';
  if (!transcript) return { write: false, reason: 'the recording carries no speech at all' };

  const channels = new Set<string>();
  let labelled = 0;
  let spoken = 0;
  for (const line of transcript.split('\n')) {
    const match = SPEAKER_LINE.exec(line.trim());
    if (!match) continue;
    labelled += 1;
    if (!match[2].trim()) continue; // a label with nothing after it is not speech
    spoken += 1;
    channels.add(match[1]);
  }

  if (labelled === 0) return { write: true, caveat: UNSEPARATED_CAVEAT };
  if (spoken === 0) return { write: false, reason: 'the recording carries no speech at all' };
  if (channels.size === 1) {
    return { write: false, reason: 'only one side of the call ever spoke, and the recording opens with ours' };
  }

  return { write: true, caveat: null };
}
