import { env, optionalEnv } from '../env';
import { agentVoice, voiceSpeed } from './assistant';

/**
 * Telnyx Call Control v2 commands.
 *
 * Hand-rolled instead of the SDK because the surface used here is seven commands
 * and the failure shape is what actually matters: Telnyx answers a bad command
 * with an HTTP error plus an `errors` array, and the caller needs that detail to
 * tell "the leg already hung up" (expected, ignorable) from "wrong parameters"
 * (a bug that would otherwise disappear into a swallowed promise).
 */

const BASE = 'https://api.telnyx.com/v2';

/**
 * Every command runs after the webhook response is already committed, so a hung
 * Telnyx request cannot delay the 200. It can still hold the function open past
 * maxDuration, which is what this bounds.
 */
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Telnyx's basic TTS, which every account has and which cannot be rejected for a
 * bad voice id. Only ever reached when the configured premium voice is refused.
 */
const BASIC_VOICE_FALLBACK = 'female';

export class TelnyxError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`telnyx ${path}: ${status} ${detail}`);
  }

  /**
   * The leg this command targeted is already gone. Heuristic, not a documented
   * error code: 404 is unambiguous, and a 422 naming an ended or missing call is
   * the shape Telnyx returns when a command races a hangup. Callers use it to
   * decide whether a failed best-effort hangup deserves a log line.
   */
  get isCallGone(): boolean {
    return this.status === 404 || (this.status === 422 && /not found|already|ended|hangup/i.test(this.detail));
  }
}

interface TelnyxErrorBody {
  errors?: { code?: string | number; title?: string; detail?: string }[];
}

async function post<T>(path: string, body: object = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON body (gateway HTML, empty 502). `text` below still carries it.
  }

  if (!res.ok) {
    const errors = (parsed as TelnyxErrorBody).errors ?? [];
    const detail =
      errors
        .map((e) => [e.code, e.title, e.detail].filter(Boolean).join(' '))
        .join('; ') || text.slice(0, 300);
    throw new TelnyxError(path, res.status, detail || 'empty error body');
  }

  return (parsed as { data: T }).data;
}

/**
 * client_state is the only way to attach our own meaning to a leg: Telnyx stores
 * whatever a command sets and echoes it back verbatim on every later webhook for
 * that leg. It must be base64, and it is how a `call.speak.ended` tells us which
 * speak finished (the disclosure or the voicemail prompt) and how a `call.answered`
 * identifies itself as one of our dialed responder legs.
 */
export function encodeClientState(state: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64');
}

export function decodeClientState<T>(encoded: string | null | undefined): T | null {
  if (!encoded) return null;
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as T;
  } catch {
    return null;
  }
}

export interface DialResult {
  call_control_id: string;
  call_leg_id: string;
  call_session_id: string;
}

export interface SpeakParams {
  payload: string;
  client_state?: string;
}

export interface RecordStartParams {
  channels: 'single' | 'dual';
  format: 'mp3' | 'wav';
  max_length?: number;
  client_state?: string;
  /** Same dedupe as the assistant start, for the same reason: see voice.ts. */
  command_id?: string;
}

export interface DialParams {
  to: string;
  timeout_secs: number;
  client_state?: string;
}

/**
 * `assistant` carries `id` plus per-call overrides of anything on the stored
 * assistant. Read off the OpenAPI spec on 2026-08-19, which describes it as
 * "All fields except `id` are optional - the assistant's stored configuration
 * will be used as fallback for any omitted fields."
 *
 * A previous version of this comment said the body was "exactly this and nothing
 * else" and that client_state was not accepted. Both are wrong: the spec lists
 * `client_state` and `command_id` alongside `greeting`, `instructions`,
 * `voice_settings` and `dynamic_variables`. Written down because that mistaken
 * comment is what kept `command_id` off this command, and `command_id` is what
 * lets the start be issued before the database claim rather than after it.
 *
 * `dynamic_variables` IS THE POINT OF THIS TYPE. Supplying the caller's context
 * here is what takes the dynamic-variables webhook off the critical path: see
 * the note above `startAssistant` below.
 */
export interface StartAssistantParams {
  assistant: {
    id: string;
    dynamic_variables?: Record<string, string>;
  };
  /**
   * Telnyx ignores a repeat of the same command_id on the same call, which is
   * the idempotency that used to come from the compare-and-set in the database.
   * Having it here is what allows this command to go out FIRST.
   */
  command_id?: string;
}

export interface PlaybackStartParams {
  /** A file already uploaded to /v2/media. Mutually exclusive with audio_url. */
  media_name?: string;
  audio_url?: string;
  /** Telnyx keeps the decoded audio warm, so a repeat play skips the fetch. */
  cache_audio?: boolean;
  client_state?: string;
}

export interface StartAssistantResult {
  /** Ties our call row to the conversation in Mission Control. Absent on older responses. */
  conversation_id?: string;
  result?: string;
}

export const telnyx = {
  answer: (callControlId: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/answer`),

  /**
   * The disclosure and the voicemail prompt.
   *
   * `voice` is the SAME value the assistant speaks with, from agentVoice(). This
   * used to read its own TELNYX_VOICE, defaulting to `female`, which is Telnyx's
   * basic engine: the caller heard a robot read the legal notice and then a
   * different, human-sounding voice say hello, three seconds apart. The speak
   * command takes the premium `<Provider>.<Model>.<VoiceId>` form as well as the
   * basic male/female words, so one voice covers both.
   *
   * `language` only applies to the basic voices and to `alice`; it is ignored
   * when a provider-prefixed voice is named. Kept because it costs nothing and
   * is correct if the voice is ever set back to a basic one.
   */
  /**
   * The disclosure is spoken in the assistant's own voice so the caller hears one
   * person rather than a robot reading a legal notice followed by somebody else.
   *
   * SAME VOICE WAS ONLY HALF OF IT. `voice_settings` carries the pace, and this
   * command sent none, so the opener ran at the voice's natural 1.0 while every
   * word after it ran at voiceSpeed(). That did not matter much while beat 1 was
   * a bare notice. It matters a lot since 2026-08-11, when the whole
   * introduction moved here: the densest sentence on the call, the one a first
   * time caller has to parse cold, became the only sentence with no pace control
   * on it. Karim, off a test call on 2026-08-14: "the introduction felt
   * extremely fast... as if the words were being cut off".
   *
   * MEASURED, not read off the docs, because this API stores fields it ignores.
   * Rendering the opener through POST /v2/text-to-speech/speech at 0.5: a
   * top-level `voice_speed` changed the duration not at all (6.4s against a
   * 6.7-7.4s baseline, inside the noise), and the same number nested under
   * `voice_settings` took it to 15.1s. Nesting is the whole difference between
   * a working pace control and a silently ignored one, on all three models
   * tested. The assistant already nests it correctly; this did not send it.
   *
   * The fallback deliberately drops `voice_settings`. It exists for one job, a
   * call that stays alive when the premium voice id is rejected, and a basic
   * voice is a different engine with different settings, so sending it a
   * premium-shaped setting is a second way to 4xx on the retry that is supposed
   * to be the safe one.
   *
   * The fallback is not defensive padding, it is the only thing standing between
   * a bad voice id and a dead phone line. `call.speak.ended` is what triggers
   * `record_start` and the agent handoff, so a speak that never succeeds means
   * that event never fires: the caller sits in silence, the retry throws again,
   * and the call is stuck until they hang up. A 4xx here is almost always the
   * voice id, so retrying once with the basic voice trades a worse-sounding
   * disclosure for a call that still works. Anything 5xx or already-hung-up is
   * rethrown, because a retry cannot help either one.
   */
  speak: async (callControlId: string, params: SpeakParams) => {
    const path = `/calls/${callControlId}/actions/speak`;
    const body = { ...params, language: optionalEnv('TELNYX_LANGUAGE', 'en-US') };
    try {
      return await post<{ result: string }>(path, {
        ...body,
        voice: agentVoice(),
        voice_settings: { voice_speed: voiceSpeed() },
      });
    } catch (err) {
      if (!(err instanceof TelnyxError) || err.status >= 500 || err.isCallGone) throw err;
      console.error(`[telnyx] speak rejected voice "${agentVoice()}", retrying basic: ${err.detail}`);
      return post<{ result: string }>(path, { ...body, voice: BASIC_VOICE_FALLBACK });
    }
  },

  /**
   * The same disclosure, pre-rendered, played from a file instead of synthesized
   * on the call.
   *
   * WHY THIS EXISTS AT ALL. `speak` has to render 5.7 seconds of premium TTS
   * before the first sample reaches the caller, and it renders the identical
   * bytes on every single call. Measured across two real calls: 1.72s and 2.04s
   * between `call.answered` and `call.speak.started`, which the caller hears as
   * dead air on pickup. A file that Telnyx already holds starts playing without
   * that step.
   *
   * The second reason is durability. `speak` takes a voice id, and Telnyx
   * deleted the whole NaturalHD tier under this line on 2026-08-18 without
   * notice; the disclosure then fell back to the basic robot voice mid-incident.
   * A rendered file cannot stop existing because a voice was retired.
   *
   * The file is named for the hash of the text and voice that produced it, so a
   * changed opener cannot keep playing the old recording: `openerMediaName()`
   * recomputes the name and a mismatch means nothing is configured, which falls
   * back to `speak`. A stale legal notice is the one failure worth being loud
   * about, so preflight checks the same hash.
   */
  playbackStart: (callControlId: string, params: PlaybackStartParams) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/playback_start`, params),

  recordStart: (callControlId: string, params: RecordStartParams) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/record_start`, params),

  dial: (params: DialParams) =>
    post<DialResult>('/calls', {
      connection_id: env('TELNYX_CONNECTION_ID'),
      from: env('TELNYX_NUMBER'),
      ...params,
    }),

  /**
   * Hands the live leg to the AI agent. The caller stays on the same call, so
   * the dual-channel recording started at the disclosure keeps running across
   * the whole conversation and the post-call pipeline is untouched.
   *
   * PASS `dynamic_variables` HERE RATHER THAN LETTING TELNYX FETCH THEM. With
   * `dynamic_variables_webhook_url` set, Telnyx calls us back at conversation
   * start and holds the caller in silence until we answer or the timeout
   * expires. That callback lands on /api/agent/context, a different Vercel
   * function with its own cold start, so it was a cold start sitting between the
   * disclosure and the first word. Sending the variables with the start command
   * means the lookup happens on our side, during the disclosure, out of the
   * caller's hearing.
   */
  startAssistant: (callControlId: string, params: StartAssistantParams) =>
    post<StartAssistantResult>(`/calls/${callControlId}/actions/ai_assistant_start`, params),

  bridge: (callControlId: string, bridgeWith: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/bridge`, {
      call_control_id_to_bridge_with: bridgeWith,
    }),

  hangup: (callControlId: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/hangup`),
};

export type TelnyxCommands = typeof telnyx;
