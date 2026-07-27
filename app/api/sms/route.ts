import { after } from 'next/server';
import {
  verifyTelnyxWebhook,
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
} from '../../../lib/telnyx/signature';
import { handleTelnyxSmsEvent, type TelnyxWebhookBody } from '../../../lib/telnyx/sms';

/**
 * Telnyx messaging webhook: `message.received`, `message.sent`, `message.finalized`.
 *
 * Messaging webhooks time out at 2 seconds and retry up to 6 times on anything
 * but a 2xx, so this handler verifies the signature and acks immediately.
 * Every Supabase write (dedupe, contact resolution, message/outbox inserts)
 * runs in `after()`, after the response is already committed.
 */
export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get(TELNYX_SIGNATURE_HEADER);
  const timestamp = request.headers.get(TELNYX_TIMESTAMP_HEADER);

  const verified = verifyTelnyxWebhook(rawBody, signature, timestamp);
  if (!verified.ok) {
    return new Response(verified.reason ?? 'invalid signature', { status: 403 });
  }

  let body: TelnyxWebhookBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response('invalid JSON', { status: 400 });
  }

  after(async () => {
    try {
      await handleTelnyxSmsEvent(body);
    } catch (err) {
      console.error('sms webhook processing failed', err);
    }
  });

  return new Response(null, { status: 200 });
}
