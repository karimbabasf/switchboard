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

/**
 * Ask Anthropic to cache the prompt, which nobody does for us.
 *
 * WHY THIS IS THE WHOLE TRICK. Open-weight models get automatic prefix caching
 * from whatever serves them, which is why MiniMax comes back 97 percent cached
 * on Telnyx with no flag. Anthropic caching is OPT-IN: it needs an explicit
 * `cache_control` breakpoint, and Telnyx's assistant never sends one, so Haiku
 * re-buys the whole 8,400 token prompt on every single turn.
 *
 * Measured 2026-08-15 on NEAR AI Cloud with the real prompt and tools: without
 * this, three identical requests report `cached_tokens: 0`. With it, request one
 * writes the cache and requests two and three come back 8,059 of 8,419 cached,
 * 96 percent, at a tenth of the input rate. That is Haiku quality at roughly
 * MiniMax's price.
 *
 * Only Anthropic models need it and only they understand it. Telnyx accepts the
 * block with a 200 and ignores it, so this is safe to apply on either upstream
 * and costs nothing where it does not work.
 *
 * The breakpoint goes on the SYSTEM message because that is the stable prefix.
 * Everything after it (the conversation) changes every turn and is not worth
 * caching; everything before it is nothing. Anthropic caching is a prefix match,
 * so a single breakpoint at the end of the system prompt is the whole win.
 */
export function withCacheControl(body: ChatBody, model: string): ChatBody {
  if (!model.startsWith('anthropic/')) return body;

  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;

  const first = messages[0] as { role?: string; content?: unknown } | undefined;
  if (!first || first.role !== 'system') return body;
  // Already an array means someone set this up deliberately; leave it alone.
  if (Array.isArray(first.content)) return body;
  if (typeof first.content !== 'string' || first.content.length === 0) return body;

  const rewritten = [
    { role: 'system', content: [{ type: 'text', text: first.content, cache_control: { type: 'ephemeral' } }] },
    ...messages.slice(1),
  ];
  return { ...body, messages: rewritten };
}
