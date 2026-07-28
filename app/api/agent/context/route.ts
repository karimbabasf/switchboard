import { callerContext, contextDeps } from '@/lib/agent/context';
import {
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
  verifyTelnyxWebhook,
} from '@/lib/telnyx/signature';

/**
 * Telnyx dynamic-variables webhook: who is calling, answered before hello.
 *
 * Called once at the start of every conversation, with a timeout Telnyx enforces
 * (`dynamic_variables_webhook_timeout_ms`, set to 8s on our assistant). Unlike
 * the Call Control webhook there is nothing to defer to `after`: the response
 * body IS the work, so it has to be fast rather than merely prompt.
 *
 * Signed with the same Ed25519 scheme as every other Telnyx webhook, over
 * `${timestamp}|${rawBody}`, so the existing verifier applies unchanged.
 */

export const runtime = 'nodejs';
export const maxDuration = 10;

interface InitPayload {
  data?: {
    event_type?: string;
    payload?: {
      telnyx_end_user_target?: string;
      call_control_id?: string;
    };
  };
}

export async function POST(request: Request): Promise<Response> {
  // Raw bytes, never request.json(): the signature covers exactly what was sent.
  const rawBody = await request.text();

  const verdict = verifyTelnyxWebhook(
    rawBody,
    request.headers.get(TELNYX_SIGNATURE_HEADER),
    request.headers.get(TELNYX_TIMESTAMP_HEADER),
  );
  if (!verdict.ok) {
    return new Response(verdict.reason ?? 'bad signature', { status: 403 });
  }

  let body: InitPayload;
  try {
    body = JSON.parse(rawBody) as InitPayload;
  } catch {
    return new Response('invalid json', { status: 400 });
  }

  const caller = body.data?.payload?.telnyx_end_user_target;
  if (!caller) {
    // No caller to look up. Answer with the stranger shape rather than an error:
    // a 4xx here buys nothing and Telnyx would proceed without variables anyway,
    // which is the same conversation with a wasted timeout in front of it.
    return Response.json({ dynamic_variables: { first_name: '', is_known_caller: 'no', recent_order: '' } });
  }

  const dynamic_variables = await callerContext(caller, contextDeps());
  return Response.json({ dynamic_variables });
}
