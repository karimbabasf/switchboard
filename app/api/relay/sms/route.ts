// Relative rather than `@/`, so the route can be imported straight into a test
// the way app/api/qbo-sync/route.ts is.
import {
  RELAY_TEMPLATE_NAMES,
  isRelayTemplateName,
  relayTemplateVars,
  renderRelayTemplate,
} from '../../../../lib/agent/templates';
import { SmsBlocked, sendSms } from '../../../../lib/telnyx/sms';
import { env, toE164 } from '../../../../lib/env';

/**
 * Akme's SMS sender, because Akme has no number.
 *
 * A recognition code has to arrive from the number the customer already knows,
 * and that number is registered to a 10DLC campaign that lives in this repo. The
 * alternative, a second unregistered number on Akme's side, is the thing
 * carriers filter and eventually block, and it would teach customers that a
 * second number is us.
 *
 * A TEMPLATE NAME AND VARIABLES, NEVER A BODY. This is the whole security
 * property of the endpoint. Akme's desk reads customer email and customer text
 * and hands both to a model; if this door accepted a `body`, then any sentence
 * that talked that model into calling it would be a sentence sent from our
 * registered number to anybody. It accepts three template names, the words live
 * in lib/agent/templates.ts, and the variables are length checked, GSM-7 checked
 * and dropped INSIDE the template rather than replacing it.
 *
 * Two doors, in this order:
 *   1. `x-relay-secret`, compared in length independent time. Its own secret,
 *      distinct from every other one this app holds, so a leak of one hands over
 *      nothing else.
 *   2. SMS_ALLOWLIST, enforced inside sendSms where every other sender meets it.
 *      This route deliberately holds no copy of that check: the door is in
 *      lib/telnyx/sms.ts and there is exactly one of it.
 */

export const runtime = 'nodejs';
export const maxDuration = 15;

/** Length-independent compare, so a wrong secret cannot be found byte by byte. */
function secretMatches(given: string | null): boolean {
  const expected = env('RELAY_SECRET');
  if (!given || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface RelayBody {
  to?: unknown;
  template?: unknown;
  vars?: unknown;
}

/** Every reply has this shape, including the refusals, so Akme has one thing to read. */
function answer(sent: boolean, reason?: string, status = 200): Response {
  return Response.json(sent ? { sent } : { sent, reason }, { status });
}

export async function POST(request: Request): Promise<Response> {
  if (!secretMatches(request.headers.get('x-relay-secret'))) {
    return answer(false, 'bad relay secret', 403);
  }

  let body: RelayBody;
  try {
    body = (await request.json()) as RelayBody;
  } catch {
    return answer(false, 'invalid json', 400);
  }

  const to = typeof body.to === 'string' ? toE164(body.to) : null;
  if (!to) return answer(false, 'to is not a phone number', 400);

  if (!isRelayTemplateName(body.template)) {
    return answer(false, `template must be one of ${RELAY_TEMPLATE_NAMES.join(', ')}`, 400);
  }

  // Values must be strings. An object or a number here is a caller bug, and
  // coercing it would put "[object Object]" in a customer's text.
  const raw = body.vars;
  const vars: Record<string, string> = {};
  if (raw !== undefined) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return answer(false, 'vars must be an object of strings', 400);
    }
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'string') return answer(false, `vars.${key} is not a string`, 400);
      vars[key] = value;
    }
  }

  const text = renderRelayTemplate(body.template, vars);
  if (!text) {
    // Named rather than generic: the overwhelmingly likely cause is a missing
    // variable, and Akme can only fix what it is told.
    return answer(
      false,
      `${body.template} needs ${relayTemplateVars(body.template).join(', ')}, each a short plain string`,
      400,
    );
  }

  try {
    await sendSms(to, text);
    return answer(true);
  } catch (err) {
    // A blocked recipient is a normal answer, not a fault: the allowlist is
    // doing its job, or the customer has opted out, and Akme needs to know
    // which so it can fall back to email rather than retry.
    if (err instanceof SmsBlocked) return answer(false, err.message);
    console.error(`[relay] ${body.template} to ${to} failed:`, err);
    return answer(false, 'the carrier rejected the message', 502);
  }
}
