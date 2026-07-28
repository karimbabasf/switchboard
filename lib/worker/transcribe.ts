/**
 * Transcribe step: turns the stored recording into a readable, speaker-labeled
 * transcript via AssemblyAI.
 *
 * Recordings are dual-channel (one party per physical channel), so multichannel
 * is enabled and speaker diarization is deliberately left off: the channel
 * split already answers "who is who", and diarization on top of that would
 * just be a second, less reliable guess at the same answer.
 */

import { AssemblyAI } from 'assemblyai';
import { env, optionalEnv } from '../env';
import { db } from '../db';
import type { Call } from '../types';

/** Plenty of time for AssemblyAI to fetch a call-length recording from our own signed URL. */
const SIGNED_URL_TTL_SECONDS = 300;

/**
 * The only two values `speech_models` accepts. Kept here rather than imported
 * because the SDK types it as a bare string[], so a typo is otherwise a runtime
 * failure on a recording that cannot be replayed. Preflight checks against this.
 */
export const SUPPORTED_SPEECH_MODELS = ['universal-3-5-pro', 'universal-2'] as const;

/** Broadly available and the automatic language fallback, so it is always last in the list. */
const FALLBACK_SPEECH_MODEL = 'universal-2';

/**
 * `speech_models` is an ordered availability fallback, not parallel execution:
 * the first model that is reachable produces the single transcript.
 */
function speechModels(): string[] {
  const primary = optionalEnv('ASSEMBLYAI_MODEL', 'universal-3-5-pro').trim();
  return primary === FALLBACK_SPEECH_MODEL ? [FALLBACK_SPEECH_MODEL] : [primary, FALLBACK_SPEECH_MODEL];
}

interface TranscriptLike {
  status: string;
  error?: string | null;
  text?: string | null;
  utterances?: { channel?: string | null; text: string }[] | null;
}

export async function transcribeCall(call: Call): Promise<string> {
  if (!call.storage_path) {
    throw new Error(`call ${call.id} has no storage_path; the recording has not been fetched yet`);
  }

  const bucket = env('SUPABASE_STORAGE_BUCKET');
  const { data, error } = await db().storage.from(bucket).createSignedUrl(call.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    throw new Error(`could not sign storage_path for transcription: ${error?.message ?? 'no data returned'}`);
  }

  const client = new AssemblyAI({ apiKey: env('ASSEMBLYAI_API_KEY') });

  const transcript = (await client.transcripts.transcribe({
    audio_url: data.signedUrl,
    multichannel: true,
    speaker_labels: false, // the channel split already identifies who is who
    // Plural array, not the deprecated singular `speech_model`. Passing it
    // explicitly is required to get the flagship: omitting it lets the API pick.
    speech_models: speechModels(),
  })) as TranscriptLike;

  if (transcript.status === 'error') {
    throw new Error(`AssemblyAI transcription failed: ${transcript.error ?? 'unknown error'}`);
  }

  return formatTranscript(transcript);
}

/** Renders one line per utterance labeled by physical channel; falls back to plain text if AssemblyAI returned no utterances. */
function formatTranscript(transcript: TranscriptLike): string {
  if (transcript.utterances && transcript.utterances.length > 0) {
    return transcript.utterances.map((u) => `Speaker ${u.channel ?? '?'}: ${u.text}`).join('\n');
  }
  return transcript.text ?? '';
}
