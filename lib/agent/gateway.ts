/**
 * What the gateway forwards upstream.
 *
 * TWO FAILURES IN ONE DAY SHAPED THIS, IN OPPOSITE DIRECTIONS.
 *
 * First, passthrough took the phone line down. Telnyx's ASSISTANT sends
 * `stream_options.continuous_usage_stats`; Telnyx's own INFERENCE API rejects
 * it with 400 "Unknown parameter". Two products from one vendor, an
 * OpenAI-compatible dialect each, and they do not match.
 *
 * Then the fix for that took the QUALITY down, which is worse because nothing
 * errors. Panicking about unknown fields, it forwarded a four-field allowlist
 * and dropped everything else, `temperature` included. Telnyx sends 0.7;
 * MiniMax at its own server default stops answering the question it was asked
 * and recites the nearest scripted paragraph instead. Asked "tell me more about
 * the tape, how much does it cost", it skipped straight to the pricing routing
 * and never mentioned the two tapes. With 0.7 restored it answers properly,
 * indistinguishably from Haiku on the same turn. Measured on Karim's real call
 * transcript, replayed three ways, 2026-08-15.
 *
 * SO THE RULE IS: BLOCK WHAT IS PROVEN TO BREAK, FORWARD EVERYTHING ELSE.
 * Every field Telnyx sends was tested against Telnyx inference with tools
 * attached. Exactly two are rejected, and they are the two below. `temperature`,
 * `top_p`, `presence_penalty`, `frequency_penalty`, `seed`, `stop`,
 * `parallel_tool_calls`, `response_format`, `extra_metadata`, `user` and `n` are
 * all accepted, and some of them decide how the agent sounds.
 *
 * An allowlist looks safer and is not: a dropped field is a silent behaviour
 * change, and silence is the failure mode that reached a customer.
 */

/** Verified rejected by Telnyx inference. Everything else goes through. */
export const BLOCKED_FIELDS = [
  // 400: "max_completion_tokens (former max_tokens) and function tools can not
  // be used at the same time". The rehearsal harness hit this first, in 2026-07.
  'max_tokens',
  'max_completion_tokens',
  // 400: "Unknown parameter: 'stream_options.continuous_usage_stats'". The one
  // that took the line down.
  'stream_options',
] as const;

/**
 * The smallest body known to work, for the retry after an upstream 400.
 *
 * Not the normal path. If Telnyx adds another field its own inference rejects,
 * the first attempt fails and this one still answers the caller, so a future
 * dialect drift costs a little latency instead of the whole call.
 */
export const MINIMAL_FIELDS = ['messages', 'tools', 'tool_choice', 'stream'] as const;

export type ChatBody = Record<string, unknown>;

/** Normal path: everything except the fields proven to break. */
export function forwardBody(body: ChatBody, model: string): ChatBody {
  const out: ChatBody = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'model') continue;
    if ((BLOCKED_FIELDS as readonly string[]).includes(k)) continue;
    if (v !== undefined) out[k] = v;
  }
  out.model = model;
  return out;
}

/** Fallback path: only the fields the API cannot refuse. */
export function minimalBody(body: ChatBody, model: string): ChatBody {
  const out: ChatBody = { model };
  for (const k of MINIMAL_FIELDS) if (body[k] !== undefined) out[k] = body[k];
  return out;
}

/** Blocked field names present on this request, for logging. */
export function blockedPresent(body: ChatBody): string[] {
  return (BLOCKED_FIELDS as readonly string[]).filter((k) => body[k] !== undefined);
}
