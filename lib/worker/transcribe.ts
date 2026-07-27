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
import type { SpeechModel } from 'assemblyai';
import { env, optionalEnv } from '../env';
import { db } from '../db';
import type { Call } from '../types';

/** Plenty of time for AssemblyAI to fetch a call-length recording from our own signed URL. */
const SIGNED_URL_TTL_SECONDS = 300;

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
    // The installed SDK's SpeechModel literal type ("best" | "nano" | "slam-1"
    // | "universal") lags AssemblyAI's actual model names (e.g. "universal-2",
    // "universal-3.5"), which is what ASSEMBLYAI_MODEL actually holds.
    speech_model: optionalEnv('ASSEMBLYAI_MODEL', 'universal-2') as SpeechModel,
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
