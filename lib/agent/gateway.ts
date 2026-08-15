/**
 * What the gateway forwards upstream, and nothing else.
 *
 * THIS IS AN ALLOWLIST BECAUSE A BLOCKLIST TOOK THE PHONE LINE DOWN.
 * The first version forwarded the caller's body verbatim minus one field it
 * knew was bad. On the first real call, 2026-08-15, every turn failed: Telnyx's
 * ASSISTANT sends `stream_options.continuous_usage_stats`, and Telnyx's own
 * INFERENCE API rejects it with 400 "Unknown parameter". Two products from the
 * same vendor, one OpenAI-compatible dialect each, and they do not match.
 *
 * THE FALLBACK DID NOT SAVE IT, WHICH IS THE LESSON WORTH KEEPING. Primary and
 * fallback both received the same poisoned body and both returned 400. A
 * fallback only helps when the second attempt differs in the way the first one
 * was broken, and swapping the model does nothing about a malformed request.
 *
 * The published rehearsal harness had already recorded a sibling of this bug
 * (Telnyx rejects `max_tokens` alongside function tools, error 10015), which is
 * the tell that passthrough was never safe here.
 *
 * Dropping a field can cost a nicety like usage reporting. Forwarding an
 * unknown one can cost every call. So: nothing travels unless it is named here.
 */
export const FORWARD_FIELDS = ['messages', 'tools', 'tool_choice', 'stream'] as const;

export type ChatBody = Record<string, unknown>;

/**
 * Build the upstream request body.
 *
 * `model` is always ours: the caller names a model, and the gateway overrides
 * it so the choice lives in one env var rather than in the assistant.
 */
export function forwardBody(body: ChatBody, model: string): ChatBody {
  const out: ChatBody = { model };
  for (const key of FORWARD_FIELDS) {
    if (body[key] !== undefined) out[key] = body[key];
  }
  return out;
}

/** Field names that arrived and were not forwarded. Logged once, to see drift. */
export function droppedFields(body: ChatBody): string[] {
  return Object.keys(body).filter(
    (k) => k !== 'model' && !FORWARD_FIELDS.includes(k as (typeof FORWARD_FIELDS)[number]),
  );
}
