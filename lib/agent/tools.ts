/**
 * The five things the agent can actually do.
 *
 * Every tool returns one sentence for the agent to say, never a JSON blob for
 * it to narrate. A model handed `{"status":"PAID","balance":0}` reads the field
 * names out loud eventually; a model handed "Invoice ten forty three is paid"
 * cannot.
 *
 * Two rules hold across all five:
 *  - NO MONEY LEAVES THIS FILE. Akme quotes no prices by policy, and the
 *    reliable way to keep a number out of the agent's mouth is to keep it out
 *    of the string it is given.
 *  - NOTHING IS INVENTED. If the mirror has no row, the sentence says so. An
 *    agent that guesses a status on a phone call is worse than one that takes a
 *    message.
 */
import { startWave, supabaseStore, type VoiceStore } from '../telnyx/voice';
import { telnyx, type TelnyxCommands } from '../telnyx/client';
import { sendSms } from '../telnyx/sms';
import {
  findInvoiceByDocNumber,
  identifyCaller,
  recentOrdersFor,
  type CallerIdentity,
  type OpenInvoice,
} from '../qbo/lookup';
import { learnContactName, resolveTopic } from '../telegram/topics';
import { matchTemplate, renderTemplate } from './templates';
import { recordQuoteRequest, type NewQuoteRequest, type QuoteRequestRow } from '../quote-requests';
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
  /** The one SMS sender, in lib/telnyx/sms.ts. There is deliberately no second one. */
  sendText(phone: string, body: string): Promise<void>;
  /** The work item a human prices. Owned by lib/quote-requests.ts. */
  recordQuote(input: NewQuoteRequest): Promise<QuoteRequestRow>;
  /**
   * Records a name the caller gave us, which also retitles their Telegram topic.
   * Optional so a test can leave it out; production always supplies it.
   */
  learnName?(phone: string, displayName: string): Promise<void>;
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
    sendText: async (phone, body) => {
      await sendSms(phone, body);
    },
    recordQuote: recordQuoteRequest,
    learnName: learnContactName,
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
    case 'text_me_the_list':
      return textTheList(args, deps);
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

/**
 * The whole point of the phone line, in one tool.
 *
 * The agent may not price anything, so the useful thing it can do on a pricing
 * call is put the list in the caller's hand and the request on a human's queue.
 * Both, in one turn, while they are still on the phone.
 *
 * The message body is `renderTemplate('catalogue')` and nothing else. That
 * template is the reviewed copy of what we stock, it already ends with how to
 * get a quote, and the last time this codebase kept a second copy of the product
 * list it shipped four products Akme does not sell.
 */
async function textTheList(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  if (!phone) return { speech: 'I do not have a number I can text. What is the best mobile for you?' };

  const wants = str(args, 'wants') || 'the full product list';
  const name = str(args, 'caller_name') || null;

  let texted = true;
  try {
    await deps.sendText(phone, renderTemplate('catalogue'));
  } catch (err) {
    // The request is what matters and it is still recorded below. Losing it
    // because a carrier rejected one message would be the worse failure, and
    // the sentence at the end tells the caller the truth either way.
    texted = false;
    console.error(`[agent] text_me_the_list send to ${phone} failed:`, err);
  }

  await deps.recordQuote({ phone, source: 'call', wants, callerName: name });

  return {
    speech: texted
      ? 'Sent, that should be on your phone now. The team will come back to you with pricing.'
      : 'That text would not go through, but I have put your request in front of the team and they will come back to you.',
  };
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

  // A caller who says their name is the only way a contact ever stops being a
  // bare phone number: nothing else in this system writes display_name. Recorded
  // best effort, because a failed rename must not cost the caller their message.
  if (name && phone) {
    try {
      await (deps.learnName ?? learnContactName)(phone, name);
    } catch (err) {
      console.error(`[agent] could not record the name ${JSON.stringify(name)} for ${phone}:`, err);
    }
  }

  // A message that is plainly a pricing question is a quote request, and it has
  // to land on the quote queue as well as in the caller's topic, or the only
  // record of it is a sentence in a thread nobody works from. `matchTemplate` is
  // the same matcher the SMS side uses to decide the same thing, deliberately:
  // it under-matches, and a request that misses is still filed as a message.
  if (matchTemplate(message) === 'quote') {
    try {
      await deps.recordQuote({
        phone: phone || callback,
        source: 'call',
        wants: message,
        callerName: name || null,
      });
    } catch (err) {
      // The message is already in front of a human. A failed second write must
      // not take the tool call down mid-sentence.
      console.error(`[agent] take_message quote request for ${phone || callback} failed:`, err);
    }
  }

  const readback = callback ? ` We will call you back on ${callback}.` : '';
  return { speech: `I have got that down and passed it to the team.${readback}` };
}
