import { after } from 'next/server';
import { processTelnyxEvent, receiveTelnyxWebhook, voiceDeps } from '@/lib/telnyx/voice';

/**
 * Telnyx Call Control webhook.
 *
 * The whole design of this handler is one constraint: Telnyx's webhook timeout is
 * 2 SECONDS, and any non-2xx (3xx included) is treated as a failure and retried.
 * So the request path does exactly two things, both CPU-only: verify the Ed25519
 * signature over the raw body, and parse the JSON. Answering the call, dialing
 * responders and every database write happen in `after`, which Next runs once the
 * response is committed. Nothing slow may move above the return.
 *
 * Because the work runs after the 200, a failure in it is invisible to Telnyx and
 * cannot be signalled by a status code. That is deliberate: processTelnyxEvent
 * drops its claim on the event when it throws, so the next Telnyx retry of the
 * same webhook re-runs it. Retries are the recovery mechanism, not the response.
 */

// node:crypto in the signature check and Buffer in client_state both need Node.
export const runtime = 'nodejs';

// `after` runs inside the route's budget, so this bounds the post-response work
// (one dial per responder in a wave) rather than the response itself.
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  // request.text(), never request.json(): the signature covers the exact bytes
  // Telnyx sent, and a parse-then-reserialize round trip does not reproduce them.
  const rawBody = await request.text();

  const outcome = receiveTelnyxWebhook(rawBody, request.headers);
  if (!outcome.ok) {
    return new Response(outcome.reason, { status: outcome.status });
  }

  const event = outcome.event;
  after(async () => {
    try {
      await processTelnyxEvent(event, voiceDeps());
    } catch (err) {
      // processTelnyxEvent already releases the event claim on failure. This is
      // the last resort so a throw cannot escape into an unhandled rejection.
      console.error(`[voice] ${event.data.event_type} ${event.data.id} failed:`, err);
    }
  });

  return new Response(null, { status: 200 });
}
