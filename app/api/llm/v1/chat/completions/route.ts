import { blockedPresent, forwardBody, minimalBody, withCacheControl } from '@/lib/agent/gateway';
import { Stripper, stripMarkup } from '@/lib/agent/strip';
import { env, optionalEnv } from '@/lib/env';

/**
 * The model gateway the phone line talks to, and the only reason a cheap model
 * is safe here.
 *
 * WHY THERE IS A HOP AT ALL. Telnyx caches the system prompt automatically on
 * its OWN hosted models and not at all on the Anthropic passthrough: measured
 * 2026-08-15, MiniMax-M3 returned 293,760 of 302,133 prompt tokens cached, Haiku
 * returned zero and silently ignored an Anthropic `cache_control` block. Since
 * the 7,044 token prompt is resent on every turn, that difference is roughly 90
 * percent of the model bill, far more than the sticker price between them.
 *
 * The catch is that every cheap caching model on Telnyx is a reasoning model,
 * and MiniMax puts `</mm:think>` in front of the turn after a tool call. On the
 * plain assistant path that goes straight to TTS and the caller hears it. No
 * request flag suppresses it and prompt wording makes it worse (see lib/agent/
 * strip.ts). So the assistant points `external_llm` here, and this route is the
 * strip point that path otherwise does not have.
 *
 * FAILING SAFE IS THE POINT. This sits on a live phone number, so an upstream
 * wobble must not be a dead line: the cheap model gets one attempt with a short
 * deadline, and anything at all going wrong falls back to the Anthropic model
 * that has always answered this phone. The caller gets a more expensive answer,
 * never silence. Telnyx never sees the failure, which matters because assistant
 * level LLM fallback is undocumented and therefore not something to rely on.
 *
 * WHAT THAT FALLBACK DOES NOT COVER, learned by taking the line down with it on
 * 2026-08-15: a malformed REQUEST. Primary and fallback share one body, so both
 * failed identically on a field Telnyx's assistant sends and Telnyx's inference
 * rejects. Swapping the model cannot fix a request. That class is handled per
 * model instead, by `callUpstream` retrying on a 400 with a stripped body, and
 * the model fallback is only ever a defence against the model itself.
 *
 * AND THE FIX FOR THAT HAS ITS OWN LESSON, because it broke quality instead.
 * The first version answered the outage with a four-field allowlist, which threw
 * away `temperature` and made the agent recite scripts rather than answer the
 * caller. Nothing errored; it just got worse. Blocking is now limited to the two
 * fields proven to be rejected. See lib/agent/gateway.ts.
 *
 * This does not add a new single point of failure. `/api/agent/context` and
 * `/api/agent/tools/*` are already on this call's critical path, so Vercel being
 * up is already load-bearing for a working conversation.
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * Where the model actually runs.
 *
 * Telnyx hosts open-weight models and resells Anthropic; NEAR AI Cloud resells
 * Anthropic too. Same sticker price on Haiku across all of them ($1/$5 per M),
 * so the only thing that separates them is caching, and caching is worth more
 * than any price difference here: the prompt is 8,400 tokens and it is resent
 * every turn.
 *
 * Telnyx caches its OWN models automatically and never caches the Anthropic
 * passthrough, ignoring `cache_control` with a 200. NEAR AI honours it, which
 * makes Haiku there cost about what MiniMax costs on Telnyx (measured
 * 2026-08-15: 8,059 of 8,419 tokens cached, 96 percent, $0.00147 a request
 * against $0.00872 on Telnyx).
 */
const UPSTREAMS = {
  telnyx: () => ({ url: 'https://api.telnyx.com/v2/ai/chat/completions', key: env('TELNYX_API_KEY') }),
  near: () => ({
    url: `${optionalEnv('NEAR_AI_BASE_URL', 'https://cloud-api.near.ai/v1').replace(/\/$/, '')}/chat/completions`,
    key: env('NEAR_AI_API_KEY'),
  }),
} as const;

type UpstreamName = keyof typeof UPSTREAMS;

const PRIMARY_UPSTREAM = (): UpstreamName =>
  (optionalEnv('LLM_PROXY_UPSTREAM', 'telnyx') as UpstreamName) in UPSTREAMS
    ? (optionalEnv('LLM_PROXY_UPSTREAM', 'telnyx') as UpstreamName)
    : 'telnyx';

/** The model the phone line runs on. Overridable so a bad release is one env var away. */
const PRIMARY = () => optionalEnv('LLM_PROXY_MODEL', 'MiniMaxAI/MiniMax-M3-MXFP8');
/** What has always answered this phone, kept as the fallback. */
const FALLBACK = () => optionalEnv('LLM_PROXY_FALLBACK_MODEL', 'anthropic/claude-haiku-4-5');
/**
 * The fallback always goes through Telnyx, even when the primary does not.
 *
 * Today's lesson, twice over: a fallback is only worth having when it differs
 * from the primary in the way the primary breaks. Sharing a body made it
 * useless against a malformed request; sharing a provider would make it useless
 * against that provider being down. Telnyx is also the shorter network path and
 * the one already load-bearing for the rest of the call.
 */
const FALLBACK_UPSTREAM: UpstreamName = 'telnyx';
/**
 * How long the cheap model gets before we stop waiting.
 *
 * A caller is listening to silence for this whole time, so it is a UX budget,
 * not a network one. MiniMax answered in ~1.2s in testing; 6s is generous
 * enough to absorb a slow turn and short enough that falling back still beats
 * the pause a retry would add.
 */
const DEADLINE_MS = () => Number(optionalEnv('LLM_PROXY_DEADLINE_MS', '6000'));

function unauthorized(reason: string): Response {
  return Response.json({ error: { message: reason, type: 'invalid_request_error' } }, { status: 401 });
}

/** Constant-time-ish compare so the shared secret cannot be probed byte by byte. */
function sameSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface ChatBody {
  model?: string;
  stream?: boolean;
  messages?: unknown[];
  /** Telnyx adds this when `forward_metadata` is on. Not an OpenAI field. */
  extra_metadata?: unknown;
  [k: string]: unknown;
}

/** Logged once per cold start so a change in what Telnyx sends is visible. */
let loggedShape = false;

function post(where: UpstreamName, payload: Record<string, unknown>, signal: AbortSignal): Promise<Response> {
  const { url, key } = UPSTREAMS[where]();
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });
}

/**
 * One model, two shots at a body it will accept.
 *
 * The full body first, because `temperature` and friends are what make the
 * agent answer the question instead of reciting at the caller. A 400 means
 * Telnyx sent a field its own inference refuses, which has happened once
 * already, so the retry strips back to the fields the API cannot refuse. That
 * turns a future dialect drift into a little latency rather than a dead line.
 */
async function callUpstream(
  body: ChatBody,
  model: string,
  where: UpstreamName,
  signal: AbortSignal,
): Promise<Response> {
  const raw = body as Record<string, unknown>;

  if (!loggedShape) {
    loggedShape = true;
    const blocked = blockedPresent(raw);
    console.log(
      `llm proxy: telnyx sends [${Object.keys(raw).join(', ')}]` +
        (blocked.length ? `; blocking [${blocked.join(', ')}]` : ''),
    );
  }

  // Cache breakpoint before anything else: it changes the body, and the retry
  // below has to send the same shape or it writes a second cache entry.
  const prepared = withCacheControl(forwardBody(raw, model), model);

  const full = await post(where, prepared, signal);
  if (full.status !== 400) return full;

  const detail = (await full.text()).slice(0, 200).replace(/\s+/g, ' ');
  console.error(`llm proxy: ${model} on ${where} rejected the full body (400: ${detail}); retrying minimal`);
  return post(where, withCacheControl(minimalBody(raw, model), model), signal);
}

/**
 * Rewrite an SSE stream, taking the thinking out of every delta as it passes.
 *
 * One `Stripper` per choice index, because state has to survive across chunks:
 * a tag split over two deltas is the normal case, not an edge one.
 */
function stripStream(upstream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  const strippers = new Map<number, Stripper>();
  let buffered = '';

  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += dec.decode(value, { stream: true });

          // SSE events are separated by a blank line. Anything after the last
          // separator is a partial event and waits for the next chunk.
          const events = buffered.split('\n\n');
          buffered = events.pop() ?? '';

          for (const event of events) {
            const line = event.trimStart();
            if (!line.startsWith('data:')) {
              controller.enqueue(enc.encode(`${event}\n\n`));
              continue;
            }
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') {
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
              continue;
            }
            try {
              const json = JSON.parse(payload);
              for (const choice of json.choices ?? []) {
                const delta = choice.delta ?? {};
                if (typeof delta.content === 'string' && delta.content.length > 0) {
                  const i = choice.index ?? 0;
                  let s = strippers.get(i);
                  if (!s) {
                    s = new Stripper();
                    strippers.set(i, s);
                  }
                  delta.content = s.push(delta.content);
                }
              }
              controller.enqueue(enc.encode(`data: ${JSON.stringify(json)}\n\n`));
            } catch {
              // Not JSON we understand. Pass it through untouched rather than
              // dropping a frame the caller may need.
              controller.enqueue(enc.encode(`${event}\n\n`));
            }
          }
        }
        if (buffered.trim()) controller.enqueue(enc.encode(buffered));
      } finally {
        controller.close();
        reader.releaseLock();
      }
    },
  });
}

/** Take the thinking out of a non-streamed completion. */
function stripBody(json: Record<string, unknown>): Record<string, unknown> {
  for (const choice of (json.choices as { message?: { content?: unknown } }[]) ?? []) {
    const m = choice.message;
    if (m && typeof m.content === 'string' && m.content.length > 0) m.content = stripMarkup(m.content);
  }
  return json;
}

export async function POST(request: Request): Promise<Response> {
  const auth = request.headers.get('authorization') ?? '';
  const presented = auth.replace(/^Bearer\s+/i, '').trim();
  if (!presented) return unauthorized('missing bearer token');
  let expected: string;
  try {
    expected = env('LLM_PROXY_SECRET');
  } catch {
    return Response.json({ error: { message: 'proxy not configured' } }, { status: 500 });
  }
  if (!sameSecret(presented, expected)) return unauthorized('bad token');

  let body: ChatBody;
  try {
    body = (await request.json()) as ChatBody;
  } catch {
    return Response.json({ error: { message: 'invalid json' } }, { status: 400 });
  }

  const wantsStream = body.stream === true;

  // Attempt 1: the cheap model that caches, on a deadline the caller can bear.
  const timer = AbortSignal.timeout(DEADLINE_MS());
  try {
    const res = await callUpstream(body, PRIMARY(), PRIMARY_UPSTREAM(), timer);
    if (res.ok) {
      if (wantsStream && res.body) {
        return new Response(stripStream(res.body), {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Switchboard-Model': `${PRIMARY_UPSTREAM()}:${PRIMARY()}`,
          },
        });
      }
      const json = (await res.json()) as Record<string, unknown>;
      return Response.json(stripBody(json), { headers: { 'X-Switchboard-Model': `${PRIMARY_UPSTREAM()}:${PRIMARY()}` } });
    }
    console.error(`llm proxy: primary ${PRIMARY_UPSTREAM()}:${PRIMARY()} returned ${res.status}, falling back`);
  } catch (err) {
    console.error(`llm proxy: primary ${PRIMARY_UPSTREAM()}:${PRIMARY()} failed (${err instanceof Error ? err.message : err}), falling back`);
  }

  // Attempt 2: the model that has always answered this phone. No deadline of our
  // own here, because at this point falling back again means silence.
  try {
    const res = await callUpstream(body, FALLBACK(), FALLBACK_UPSTREAM, AbortSignal.timeout(20000));
    if (!res.ok) {
      const detail = (await res.text()).slice(0, 200);
      console.error(`llm proxy: fallback ${FALLBACK()} returned ${res.status}: ${detail}`);
      return Response.json({ error: { message: 'upstream unavailable' } }, { status: 502 });
    }
    if (wantsStream && res.body) {
      // Strip on this path too. Haiku does not emit thinking tags, but the
      // fallback model is an env var and the next one might.
      return new Response(stripStream(res.body), {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Switchboard-Model': `${FALLBACK_UPSTREAM}:${FALLBACK()}`,
        },
      });
    }
    const json = (await res.json()) as Record<string, unknown>;
    return Response.json(stripBody(json), { headers: { 'X-Switchboard-Model': `${FALLBACK_UPSTREAM}:${FALLBACK()}` } });
  } catch (err) {
    console.error(`llm proxy: fallback failed: ${err instanceof Error ? err.message : err}`);
    return Response.json({ error: { message: 'upstream unavailable' } }, { status: 502 });
  }
}
