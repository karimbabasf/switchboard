/**
 * The four things the agent can actually do.
 *
 * Every tool returns one sentence for the agent to say, never a JSON blob for
 * it to narrate. A model handed `{"status":"PAID","balance":0}` reads the field
 * names out loud eventually; a model handed "Invoice ten forty three is paid"
 * cannot.
 *
 * Two rules hold across all four:
 *  - NO MONEY LEAVES THIS FILE. Akme quotes no prices by policy, and the
 *    reliable way to keep a number out of the agent's mouth is to keep it out
 *    of the string it is given.
 *  - NOTHING IS INVENTED. If the mirror has no row, the sentence says so. An
 *    agent that guesses a status on a phone call is worse than one that takes a
 *    message.
 */
import { startWave, supabaseStore, type VoiceStore } from '../telnyx/voice';
import { telnyx, type TelnyxCommands } from '../telnyx/client';
import {
  findInvoiceByDocNumber,
  identifyCaller,
  recentOrdersFor,
  type CallerIdentity,
  type OpenInvoice,
} from '../qbo/lookup';
import { resolveTopic } from '../telegram/topics';
import { db } from '../db';
import { toE164 } from '../env';
import type { AkmeOrder } from '../types';
import type { ToolName } from '../telnyx/assistant';

export interface ToolDeps {
  store: VoiceStore;
  commands: TelnyxCommands;
  findInvoice(docNumber: string): Promise<OpenInvoice | null>;
  identify(phone: string): Promise<CallerIdentity | null>;
  recentOrders(customerId: string): Promise<AkmeOrder[]>;
  /** Puts a message in front of a human, in the caller's Telegram topic. */
  postToTeam(phone: string, text: string): Promise<void>;
}

export interface ToolResult {
  speech: string;
}

export function toolDeps(): ToolDeps {
  return {
    store: supabaseStore(),
    commands: telnyx,
    findInvoice: findInvoiceByDocNumber,
    identify: identifyCaller,
    recentOrders: (customerId) => recentOrdersFor(customerId, 1),
    postToTeam: async (phone, text) => {
      const threadId = await resolveTopic(phone);
      const { error } = await db()
        .from('outbox')
        .insert({ thread_id: threadId, kind: 'text', payload: { text } });
      if (error) throw new Error(`postToTeam failed: ${error.message}`);
    },
  };
}

type Args = Record<string, unknown>;

function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * The agent is told to pass the caller number verbatim, but a model that
 * paraphrases it into "415 555 0101" must not silently resolve to no call.
 */
function callerPhone(args: Args): string | null {
  return toE164(str(args, 'caller_phone'));
}

export async function runTool(name: ToolName, args: Args, deps: ToolDeps): Promise<ToolResult> {
  switch (name) {
    case 'escalate_to_human':
      return escalate(args, deps);
    case 'lookup_invoice':
      return lookupInvoice(args, deps);
    case 'check_order':
      return checkOrder(args, deps);
    case 'take_message':
      return takeMessage(args, deps);
  }
}

const CONNECTING = 'One moment, I am connecting you now.';
const WILL_PASS_ON = 'Everyone is tied up right now, so I have passed this straight to the team.';

/**
 * The only tool that changes call state, and the only one that can dial.
 *
 * Idempotency is free: the compare-and-set from `assistant` to `ringing` is what
 * dials, so a retried tool call finds the stage already moved, updates nothing,
 * and returns the same sentence without ringing anybody a second time.
 *
 * Escalation goes back through the existing ring group rather than a Telnyx
 * transfer, so the wave ordering, the simulring and the voicemail fallback all
 * still apply and all stay under the tests that already cover them.
 */
async function escalate(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  if (!phone) return { speech: WILL_PASS_ON };

  const flow = await deps.store.activeAssistantCall(phone);
  // No call in the assistant stage means it already escalated, already ended, or
  // the number did not resolve. All three are "do not dial".
  if (!flow) return { speech: CONNECTING };

  const responders = await deps.store.activeResponders();
  const first = responders[0];
  if (!first) {
    await deps.postToTeam(phone, `Caller asked for a person and nobody is on the rota. Reason: ${str(args, 'reason') || 'not given'}`);
    return { speech: WILL_PASS_ON };
  }

  const moved = await deps.store.advanceStage(flow.call_control_id, ['assistant'], 'ringing', {
    wave: first.ring_order,
  });
  if (!moved) return { speech: CONNECTING };

  await startWave(moved, first.ring_order, responders, { store: deps.store, commands: deps.commands });
  return { speech: CONNECTING };
}

async function lookupInvoice(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const number = str(args, 'invoice_number').replace(/\D/g, '');
  if (!number) return { speech: 'I did not catch the invoice number. What is it?' };

  const invoice = await deps.findInvoice(number);
  // "cannot find" and nothing else. Saying "it is not showing as paid" about an
  // invoice we have no row for is an invented status.
  if (!invoice) return { speech: `I cannot find an invoice with the number ${number}.` };

  const balance = invoice.balance_cents ?? 0;
  if (balance <= 0) return { speech: `Invoice ${number} is paid.` };

  const due = invoice.due_date ? ` It was due ${invoice.due_date}.` : '';
  // Deliberately no amount: the agent may not quote money, and the balance is
  // money. A human calls back with the figure.
  return { speech: `Invoice ${number} is still open.${due}` };
}

async function checkOrder(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  if (!phone) return { speech: 'I do not have your number in front of me. What is the best one for you?' };

  const identity = await deps.identify(phone);
  if (!identity?.customer_id) {
    return { speech: 'I do not see an account for this number, so let me take the details and have someone check.' };
  }

  const [order] = await deps.recentOrders(identity.customer_id);
  if (!order) return { speech: 'I do not see a recent order on your account.' };

  const ref = order.reference ?? `order ${order.seq}`;
  const due = order.need_by ? `, needed by ${order.need_by}` : '';
  return { speech: `Your most recent order is ${ref}, currently ${order.status}${due}.` };
}

async function takeMessage(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args) ?? str(args, 'caller_phone');
  const message = str(args, 'message');
  const callback = str(args, 'callback_number');
  const name = str(args, 'caller_name');

  if (!message) return { speech: 'What would you like me to pass on?' };

  const lines = [
    'Message from the phone line',
    name ? `From: ${name}` : null,
    `Callback: ${callback || phone || 'not given'}`,
    '',
    message,
  ].filter((l) => l !== null);

  await deps.postToTeam(phone || callback, lines.join('\n'));

  const readback = callback ? ` We will call you back on ${callback}.` : '';
  return { speech: `I have got that down and passed it to the team.${readback}` };
}
