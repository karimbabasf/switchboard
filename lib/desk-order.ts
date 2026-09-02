import { createHmac } from 'node:crypto';

/**
 * Sending a caller's order to the desk.
 *
 * Until 2026-09-02 a phone order lived only in this repo's tables and its link
 * pointed at the website, so the desk, which is where every text and email
 * order goes, knew a call had happened and nothing about the order it produced.
 * Two order systems for one business, and a caller who then texted about their
 * order was talking to something that could not see it.
 *
 * Nothing about how the phone SOUNDS changes here. The assistant still answers,
 * still decides what the caller wants, still says its own sentences. Only the
 * destination of the order moves.
 *
 * A FAILURE HERE IS NOT FATAL. The caller is on the line and the old path still
 * works, so `createDeskOrder` returns null rather than throwing and the tool
 * falls back to the local draft and the website link. This can make the phone
 * more reliable and, by construction, cannot make it less.
 */
export type DeskLine = { productId: string; quantity: number };

export type DeskOrder = {
  orderRef: string;
  url: string;
  token: string;
  subtotalCents: number;
};

const TIMEOUT_MS = 6000;

export async function createDeskOrder(input: {
  callerPhone: string;
  lines: DeskLine[];
}): Promise<DeskOrder | null> {
  const base = (process.env.DESK_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const secret = (process.env.DESK_SHARED_SECRET ?? '').trim();

  // A base url and its secret are one credential. One without the other sends
  // an order nowhere or sends it unsigned, so neither is used alone.
  if (!base || !secret) {
    console.warn('[desk-order] DESK_BASE_URL and DESK_SHARED_SECRET are not both set; using the local path');
    return null;
  }

  const body = JSON.stringify({ callerPhone: input.callerPhone, lines: input.lines });
  const signature = createHmac('sha256', secret).update(body, 'utf8').digest('hex');

  let res: Response;
  try {
    res = await fetch(`${base}/api/order/phone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-akme-signature': signature },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error('[desk-order] the desk did not answer:', err);
    return null;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    console.error(`[desk-order] the desk refused with ${res.status}: ${detail.slice(0, 200)}`);
    return null;
  }

  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.error('[desk-order] the desk answered with something unreadable:', err);
    return null;
  }

  const url = typeof json.url === 'string' ? json.url : null;
  const orderRef = typeof json.orderRef === 'string' ? json.orderRef : null;
  const token = typeof json.token === 'string' ? json.token : null;
  if (!url || !orderRef || !token) {
    console.error('[desk-order] the desk answered without a url, a ref or a token');
    return null;
  }

  return {
    orderRef,
    url,
    token,
    subtotalCents: Number(json.subtotalCents) || 0,
  };
}
