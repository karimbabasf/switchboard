import { env, optionalEnv } from '../env';

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
}

export interface DialParams {
  to: string;
  timeout_secs: number;
  client_state?: string;
}

export const telnyx = {
  answer: (callControlId: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/answer`),

  /**
   * `voice` and `language` are optional per the API reference but sending them is
   * safe either way, and pinning them keeps the disclosure sounding identical
   * across calls rather than drifting with an account default.
   */
  speak: (callControlId: string, params: SpeakParams) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/speak`, {
      ...params,
      voice: optionalEnv('TELNYX_VOICE', 'female'),
      language: optionalEnv('TELNYX_LANGUAGE', 'en-US'),
    }),

  recordStart: (callControlId: string, params: RecordStartParams) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/record_start`, params),

  dial: (params: DialParams) =>
    post<DialResult>('/calls', {
      connection_id: env('TELNYX_CONNECTION_ID'),
      from: env('TELNYX_NUMBER'),
      ...params,
    }),

  bridge: (callControlId: string, bridgeWith: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/bridge`, {
      call_control_id_to_bridge_with: bridgeWith,
    }),

  hangup: (callControlId: string) =>
    post<{ result: string }>(`/calls/${callControlId}/actions/hangup`),
};

export type TelnyxCommands = typeof telnyx;
