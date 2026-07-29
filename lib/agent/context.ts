/**
 * Caller context, merged into the agent's prompt before it says hello.
 *
 * Telnyx POSTs the dynamic-variables webhook once at the start of every
 * conversation and interpolates whatever JSON comes back as {{variables}}. Two
 * consequences shape everything here:
 *
 *  1. EVERY VALUE IS A STRING, and never null or undefined. The value is pasted
 *     into a prompt, so a null renders as the literal word "null" and the agent
 *     reads it out to the caller.
 *  2. THERE IS A HARD TIMEOUT. Telnyx waits `dynamic_variables_webhook_timeout_ms`
 *     and then proceeds best effort. A slow or throwing lookup does not fail the
 *     call, it just spends the whole budget first and greets a regular customer
 *     as a stranger, so this catches rather than propagates.
 */
import { identifyCaller, recentOrdersFor, type CallerIdentity } from '../qbo/lookup';
import type { AkmeOrder } from '../types';

export interface ContextDeps {
  identify(phone: string): Promise<CallerIdentity | null>;
  recentOrders(customerId: string): Promise<AkmeOrder[]>;
}

export function contextDeps(): ContextDeps {
  return {
    identify: identifyCaller,
    recentOrders: (customerId) => recentOrdersFor(customerId, 1),
  };
}

/** The shape Telnyx merges into the prompt. Flat strings only, by contract. */
export type CallerVariables = {
  first_name: string;
  is_known_caller: 'yes' | 'no';
  recent_order: string;
};

const STRANGER: CallerVariables = {
  first_name: '',
  is_known_caller: 'no',
  recent_order: '',
};

/**
 * The agent says this out loud, so it is the first name only. "Hi Maria" is a
 * receptionist; "Hi Maria Delgado" is a machine reading a database row.
 */
function firstName(displayName: string | null): string {
  return displayName?.trim().split(/\s+/)[0] ?? '';
}

/**
 * One line the agent can say back. Deliberately carries no money: the agent may
 * never quote a price, and the reliable way to keep a number out of its mouth is
 * to keep it out of its prompt.
 */
function describeOrder(order: AkmeOrder | undefined): string {
  if (!order) return '';
  const ref = order.reference ?? `order ${order.seq}`;
  const parts = [ref, order.status];
  if (order.need_by) parts.push(`needed by ${order.need_by}`);
  return parts.join(', ');
}

async function lookup(phone: string, deps: ContextDeps): Promise<CallerVariables> {
  try {
    const identity = await deps.identify(phone);
    if (!identity) return STRANGER;

    let recent_order = '';
    if (identity.customer_id) {
      const orders = await deps.recentOrders(identity.customer_id);
      recent_order = describeOrder(orders[0]);
    }

    return {
      first_name: firstName(identity.display_name),
      // Known means we have a row for this number, with or without a name on it.
      // The agent uses it to decide whether to ask who is calling.
      is_known_caller: 'yes',
      recent_order,
    };
  } catch (err) {
    console.error(`[agent] callerContext failed for ${phone}:`, err);
    return STRANGER;
  }
}

// --- Prewarm ----------------------------------------------------------------

/**
 * The assistant will not greet anybody until the dynamic-variables webhook
 * answers, so that lookup sits directly in front of the caller. It does not have
 * to: we know who is calling several seconds earlier, at `call.answered`, and
 * the disclosure playing over those seconds is time nobody is using.
 *
 * So the lookup is kicked off there and parked here, and the webhook that arrives
 * afterwards reads the answer instead of asking the question again.
 *
 * What is cached is the PROMISE, not the value. A webhook that lands while the
 * lookup is still in flight then waits on the one already running rather than
 * starting a second round trip, which is the case this is most needed in.
 *
 * In-process and best effort by construction. Dev is one `next dev` process so
 * it is always a hit; on a multi-instance deployment the webhook can land on an
 * instance that never saw the call, and then it simply does the lookup itself.
 * Nothing is ever wrong because of a miss, only slower.
 */
const CACHE_TTL_MS = 60_000;

/** Bounds a process that answers calls for weeks. Nothing here is worth memory. */
const CACHE_MAX_ENTRIES = 500;

const cache = new Map<string, { expires: number; value: Promise<CallerVariables> }>();

function cached(phone: string, deps: ContextDeps): Promise<CallerVariables> {
  const now = Date.now();
  const hit = cache.get(phone);
  if (hit && hit.expires > now) return hit.value;

  for (const [key, entry] of cache) if (entry.expires <= now) cache.delete(key);
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value as string);

  const value = lookup(phone, deps);
  cache.set(phone, { expires: now + CACHE_TTL_MS, value });
  return value;
}

/**
 * Starts the lookup and returns immediately. Never awaited by the caller and
 * never throws: `lookup` catches, and this is running on a live call whose only
 * job right now is to play the disclosure.
 */
export function prewarmCallerContext(phone: string, deps: ContextDeps = contextDeps()): void {
  if (!phone) return;
  void cached(phone, deps).catch(() => {});
}

/** Drops everything. For tests, which must not see the previous test's caller. */
export function clearCallerContextCache(): void {
  cache.clear();
}

export async function callerContext(phone: string, deps: ContextDeps): Promise<CallerVariables> {
  return cached(phone, deps);
}
