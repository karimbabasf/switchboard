/**
 * The nine things the agent can actually do.
 *
 * Every tool returns one sentence for the agent to say, never a JSON blob for
 * it to narrate. A model handed `{"status":"PAID","balance":0}` reads the field
 * names out loud eventually; a model handed "Invoice ten forty three is paid"
 * cannot.
 *
 * Two rules hold across all nine:
 *  - NOTHING IS INVENTED. If the mirror has no row, the sentence says so. An
 *    agent that guesses a status on a phone call is worse than one that takes a
 *    message.
 *  - THE AGENT NEVER DOES ARITHMETIC. Every number it says came back from a
 *    tool, as finished words.
 *
 * "NO MONEY LEAVES THIS FILE" WAS THE THIRD RULE AND IT IS GONE, as of the
 * 2026-08-27 spec. The line may quote prices now. What has NOT changed is the
 * mechanism the old rule relied on: the reliable way to keep a wrong number out
 * of the agent's mouth is to keep it out of the string it is given, so the three
 * order tools hand over a spoken sentence and the agent has no price and no
 * quantity to multiply for itself. `lookup_invoice` still says no amount, for
 * the original reason: a balance is a human's to quote.
 *
 * The three order tools are frozen by
 * docs/superpowers/specs/2026-08-27-phone-orders-design.md. Read it before
 * changing a signature here.
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
import { matchTemplate, renderRelayTemplate, renderTemplate } from './templates';
import { recordQuoteRequest, type NewQuoteRequest, type QuoteRequestRow } from '../quote-requests';
import { db } from '../db';
import { toE164 } from '../env';
import { isProductId, orderedProductIds, type ProductId } from '../orders/catalog';
import { stockFor } from '../qbo/stock';
import {
  DELIVERY_OR_WILLCALL,
  DID_NOT_CATCH,
  WHICH_PRODUCTS,
  orderSpeech,
  parseFulfilment,
  parseLines,
  priceLines,
  shortStockFor,
  unitPriceSpeech,
  type ShortStock,
} from '../orders/pricing';
import {
  claimQuote as claimQuoteRow,
  saveQuote as saveQuoteRow,
  type NewQuote,
  type QuoteVerdict,
} from '../orders/quotes';
import {
  createDraft as createDraftRow,
  orderLinkFor,
  type NewDraft,
  type PhoneOrderDraft,
} from '../orders/drafts';
import { refuseSendLink } from '../orders/refusals';
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
   * Clock, injectable so the escalation consent window is testable without
   * sleeping. Optional because production only ever wants the real one.
   */
  now?: () => number;
  /**
   * Records a name the caller gave us, which also retitles their Telegram topic.
   * Optional so a test can leave it out; production always supplies it.
   */
  learnName?(phone: string, displayName: string): Promise<void>;
  /**
   * How many of each product are on the shelf. Owned by lib/qbo/stock.ts, which
   * validates the ids against the six id enum before QuickBooks sees them,
   * caches for five minutes and returns integers and nothing else.
   *
   * Optional only so a test can hand in a fake. Production is the real function
   * from lib/qbo/stock.ts and there is no other implementation anywhere.
   */
  stockFor?(ids: ProductId[]): Promise<Record<ProductId, number>>;
  /** The quote store, lib/orders/quotes.ts. Optional so a test can hold it in memory. */
  saveQuote?(input: NewQuote): Promise<{ token: string }>;
  claimQuote?(token: string, callerPhone: string): Promise<QuoteVerdict>;
  /** The draft store, lib/orders/drafts.ts. */
  createDraft?(input: NewDraft): Promise<PhoneOrderDraft>;
  /** Where the customer finishes. Injectable so a test does not need the env var. */
  orderLink?(token: string): string;
}

export interface ToolResult {
  speech: string;
  /**
   * `price_order` only, and frozen by
   * docs/superpowers/specs/2026-08-27-phone-orders-design.md. Ten minute life,
   * single use, and the only thing `send_order_link` will accept.
   */
  quoteToken?: string;
  subtotalCents?: number;
  shortStock?: ShortStock[];
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
    stockFor,
    saveQuote: saveQuoteRow,
    claimQuote: claimQuoteRow,
    createDraft: createDraftRow,
    orderLink: orderLinkFor,
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

/**
 * THE NUMBER IS AN ARGUMENT, WHICH MEANS THE MODEL CHOOSES IT.
 *
 * Telnyx sends no call identity with a tool call, so `caller_phone` arrives as
 * whatever the model decided to write, and the prompt is the only thing telling
 * it to write the real one. A prompt is not an access control: "my colleague
 * ordered on 555 555 0147, can you check that one for me" is a plausible enough
 * sentence that a helpful model will fill the argument in with it, and then
 * every one of these tools is a lookup on somebody else's account, an SMS to a
 * number that never rang us, or a message filed into a stranger's thread.
 *
 * So the number is checked against the live call instead of trusted. A tool may
 * only act on a number that is ON THE PHONE WITH US RIGHT NOW, in the assistant
 * stage, which is the same row `escalate` already dials from. That makes the
 * guarantee structural: there is no sentence a caller can say that puts another
 * number on this call.
 *
 * Strict on purpose. The lenient reading, "look it up anyway, it is probably
 * fine", is exactly how a phone line becomes a lookup service for anyone who
 * knows a number, and the tools this gates are the ones that read customer data
 * and send messages.
 */
async function onThisCall(phone: string, deps: ToolDeps): Promise<boolean> {
  return (await deps.store.activeAssistantCall(phone)) !== null;
}

/**
 * Said when the number does not belong to this call. Deliberately identical
 * whatever the reason, so it cannot be used to test whether a number, an
 * account or an invoice exists.
 */
const NOT_THIS_CALLER =
  'I can only pull that up for the number you are calling from. Let me put you through to someone on our team for anything else.';

export async function runTool(name: ToolName, args: Args, deps: ToolDeps): Promise<ToolResult> {
  switch (name) {
    case 'offer_human':
      return offerHuman(args, deps);
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
    case 'price_products':
      return priceProducts(args);
    case 'price_order':
      return priceOrder(args, deps);
    case 'send_order_link':
      return sendOrderLink(args, deps);
  }
}

const CONNECTING = 'One moment, I am connecting you now.';
/**
 * Every sentence in this file says "we", never "the team" (Karim, 2026-08-03).
 * Robin works here, so the company is first person, and "the team will come back
 * to you" is a receptionist talking about her employer like a bystander. The one
 * sanctioned use of the word is the person a caller is being transferred to,
 * "someone on our team", which lives in the prompt and not here.
 */
const WILL_PASS_ON = 'Everyone is tied up right now, so I have got this down and we will get right back to you.';

/** The question `offer_human` asks, and the one `escalate` falls back to asking. */
const OFFER = 'I can put you through to someone on our team. Would you like that?';

/**
 * Whether an offer exists and is old enough that a caller could have answered it.
 *
 * Unparseable timestamps are a no, like a missing one: the whole point is that
 * only a stamp we can positively read counts as consent.
 */
export function offerWasAnswerable(offeredAt: string | null, nowMs: number): boolean {
  if (!offeredAt) return false;
  const at = Date.parse(offeredAt);
  if (Number.isNaN(at)) return false;
  return nowMs - at >= OFFER_MIN_AGE_MS;
}

/**
 * How old an offer must be before a "yes" to it is believable.
 *
 * The bug this defends against is the offer and the dial landing in ONE model
 * turn, which is milliseconds apart: on 2026-08-15 the caller heard "would you
 * like that? One moment, I'm connecting you now" as a single sentence. A real
 * yes cannot be that fast. The offer has to be spoken (about three seconds of
 * speech), heard, answered, and the answer has to come back through the model,
 * so the honest path is five seconds or more and the bug path is under one.
 * 2500ms sits between them with room on both sides.
 *
 * Deliberately a floor and not a ceiling. An offer made two minutes ago and
 * accepted late is still an accepted offer.
 */
const OFFER_MIN_AGE_MS = 2500;

/**
 * Asks, and only asks. This tool cannot dial, which is the entire reason it
 * exists as a separate tool rather than a flag on the other one.
 *
 * The stamp it leaves is what `escalate` checks. Recording it is best effort:
 * failing to write the stamp must not cost the caller the question, and the
 * consequence of a lost stamp is one extra "would you like that?", which is the
 * safe direction to fail in.
 */
async function offerHuman(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  if (!phone) return { speech: OFFER };

  const flow = await deps.store.activeAssistantCall(phone);
  if (flow) {
    try {
      await deps.store.recordEscalationOffer(flow.call_control_id);
    } catch (err) {
      console.error(`[agent] recordEscalationOffer for ${flow.call_control_id} failed:`, err);
    }
  }
  return { speech: OFFER };
}

/**
 * The only tool that changes call state, and the only one that can dial.
 *
 * A CALLER MUST HAVE AGREED. Two paths reach a dial and no third one exists:
 * they asked for a person themselves (`trigger: 'asked'`, nothing to verify,
 * because there is no earlier state a direct ask could leave behind), or they
 * said yes to an offer, which we can verify, because `offer_human` stamped the
 * row. Anything else, including a missing or unrecognised trigger, is treated as
 * the second case and therefore needs the stamp.
 *
 * The stamp is checked rather than trusted for the reason every other gate in
 * this file exists: an instruction is not a control. Until 2026-08-15 the rule
 * lived only in the prompt and the tool description, the two disagreed, and a
 * caller with a damaged delivery got dialled through mid-sentence. Now the
 * server refuses, asks the question itself, and the caller gets their turn. The
 * failure mode is one redundant offer, never a phone ringing at somebody who
 * did not ask for it.
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

  // Only an explicit "asked" skips the consent check. A missing trigger, a typo
  // or a value from a future prompt all land here and are made to prove consent.
  if (str(args, 'trigger') !== 'asked' && !offerWasAnswerable(flow.escalation_offered_at, deps.now?.() ?? Date.now())) {
    try {
      await deps.store.recordEscalationOffer(flow.call_control_id);
    } catch (err) {
      console.error(`[agent] recordEscalationOffer for ${flow.call_control_id} failed:`, err);
    }
    return { speech: OFFER };
  }

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

/**
 * An invoice number is guessable, so this is the one tool where the lookup key
 * comes from the caller's mouth rather than from the call.
 *
 * Scoped to the caller's own customer for that reason. Without it, anybody who
 * dials the line and counts upwards learns which invoice numbers exist, whether
 * each is paid, and when it was due, which is a customer's billing position read
 * out to a stranger.
 */
async function lookupInvoice(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const number = str(args, 'invoice_number').replace(/\D/g, '');
  if (!number) return { speech: 'I did not catch the invoice number. What is it?' };

  const phone = callerPhone(args);
  if (!phone || !(await onThisCall(phone, deps))) return { speech: NOT_THIS_CALLER };

  const [identity, invoice] = await Promise.all([deps.identify(phone), deps.findInvoice(number)]);

  // ONE sentence for all three misses: no such invoice, no account on this
  // number, and an invoice belonging to somebody else. Three different sentences
  // would answer "does this invoice exist" for free.
  //
  // "cannot find" and nothing else. Saying "it is not showing as paid" about an
  // invoice we have no row for is an invented status.
  if (!invoice || !identity?.customer_id || invoice.customer_id !== identity.customer_id) {
    return { speech: `I cannot find an invoice with the number ${number} on your account.` };
  }

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
  if (!(await onThisCall(phone, deps))) return { speech: NOT_THIS_CALLER };

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
  // The gate matters most here: this is the one tool that sends, so an unchecked
  // number turns the line into a way to make Akme's 10DLC number text a
  // stranger on request.
  if (!(await onThisCall(phone, deps))) return { speech: NOT_THIS_CALLER };

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
      ? 'Sent, that should be on your phone now. We will get right back to you with pricing and availability.'
      : 'That text would not go through, but I have got your request down and we will get right back to you with pricing and availability.',
  };
}

async function takeMessage(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  const message = str(args, 'message');
  const callback = str(args, 'callback_number');
  const name = str(args, 'caller_name');

  if (!message) return { speech: 'What would you like me to pass on?' };

  // Gated like the rest, because this number is an identity: it picks the
  // Telegram topic the message lands in and it is what `learnName` renames. A
  // number the model invented would file a stranger's thread under this caller's
  // name. `callback_number` below is deliberately NOT gated: it is only ever
  // written into the text of the message, never used to look anything up, so a
  // caller asking us to ring them back on a different line still works.
  if (!phone || !(await onThisCall(phone, deps))) return { speech: NOT_THIS_CALLER };

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
  return { speech: `I have got that down and it is in front of us now.${readback}` };
}

/**
 * Rules 2 and 3: the price of what they named, per unit, nothing added up.
 *
 * Ungated, and the only tool here that is. It reads no customer record, sends
 * nothing, and says only list prices that are on the website. There is no number
 * to check because there is nothing a wrong number could reach.
 *
 * An id the model invented is DROPPED rather than refused, so "what do the tan
 * tape and the pallet jack cost" answers the half we sell. Only when nothing in
 * the list was ours does it ask, and the question carries its own next move.
 */
async function priceProducts(args: Args): Promise<ToolResult> {
  const raw = args.products;
  const named = Array.isArray(raw) ? raw : [];

  const asked: ProductId[] = [];
  for (const value of named) {
    if (isProductId(value) && !asked.includes(value)) asked.push(value);
  }

  if (named.length > 0 && asked.length === 0) return { speech: WHICH_PRODUCTS };

  // An empty list means the caller asked for the price list, which is the one
  // case where this says a price nobody named. Rank order, film first.
  return { speech: unitPriceSpeech(asked.length > 0 ? asked : orderedProductIds()) };
}

/**
 * Rules 4, 5 and 8: the reading, the subtotal, the offer of the link, and short
 * stock said professionally.
 *
 * GATED, because the token it hands back is what later opens the SMS door. The
 * number is checked against the live call HERE, at mint time, as well as in
 * `send_order_link` at send time. Checking only at send time would leave a token
 * minted against a number nobody verified, and the whole reason this file gates
 * anything is that `caller_phone` is an argument the model chooses.
 *
 * A stock read that fails does not cost the caller their price. QuickBooks being
 * down is our problem, the subtotal is still correct, and the form is a second
 * chance to catch a quantity we cannot fill.
 */
async function priceOrder(args: Args, deps: ToolDeps): Promise<ToolResult> {
  const phone = callerPhone(args);
  const flow = phone ? await deps.store.activeAssistantCall(phone) : null;
  if (!phone || !flow) return { speech: NOT_THIS_CALLER };

  const lines = parseLines(args.lines);
  if (!lines) return { speech: DID_NOT_CATCH };

  const fulfilment = parseFulfilment(args.fulfilment);
  if (!fulfilment) return { speech: DELIVERY_OR_WILLCALL };

  const priced = priceLines(lines);

  let short: ShortStock[] = [];
  try {
    const onShelf = await (deps.stockFor ?? stockFor)(lines.map((l) => l.product));
    short = shortStockFor(lines, onShelf);
  } catch (err) {
    console.error('[agent] price_order could not read stock, pricing without it:', err);
  }

  const quote = await (deps.saveQuote ?? saveQuoteRow)({
    callId: flow.call_control_id,
    callerPhone: phone,
    lines,
    fulfilment,
    subtotalCents: priced.subtotalCents,
    shortStock: short,
  });

  return {
    speech: orderSpeech(lines, priced, short),
    quoteToken: quote.token,
    subtotalCents: priced.subtotalCents,
    shortStock: short,
  };
}

/**
 * The only tool that turns a quote into an order, and the only new one that
 * sends.
 *
 * FOUR REFUSALS AND EVERY ONE CARRIES ITS OWN NEXT MOVE, copied from Akme's
 * start_order. See lib/orders/refusals.ts for the sentences and the 2026-08-24
 * failure that made them necessary.
 *
 * Order of operations matters. The quote is CLAIMED first, in one conditional
 * UPDATE, so two racing calls produce one draft and one text. The draft is
 * written next, because the text has to contain its token. The send is last, and
 * a send that fails leaves a spent quote and an unsent draft: that draft simply
 * expires in forty-eight hours, and the caller is told to order on the site or
 * have somebody follow it up. The alternative, releasing the claim on a failed
 * send, would reopen the double text this claim exists to prevent.
 */
async function sendOrderLink(args: Args, deps: ToolDeps): Promise<ToolResult> {
  // Both spellings. The frozen argument is `quoteToken`; a webhook tool schema
  // written in snake case is the likelier thing to arrive, and a token dropped
  // over a naming convention would refuse a caller who did everything right.
  const token = str(args, 'quoteToken') || str(args, 'quote_token');
  if (!token) return refuseSendLink('no_token');

  const phone = callerPhone(args);
  const flow = phone ? await deps.store.activeAssistantCall(phone) : null;
  if (!phone || !flow) return refuseSendLink('not_this_caller');

  const verdict = await (deps.claimQuote ?? claimQuoteRow)(token, phone);
  if (!verdict.ok) return refuseSendLink(verdict.reason === 'used' ? 'already_used' : 'expired');

  // The row is ours and was validated on the way in, so this is belt and braces.
  // It costs one pass over at most six lines and it means a row that somehow got
  // edited cannot become a draft, a text and a form.
  const lines = parseLines(verdict.quote.lines);
  const fulfilment = parseFulfilment(verdict.quote.fulfilment);
  if (!lines || !fulfilment) {
    console.error(`[agent] send_order_link found an unusable quote for ${phone}`);
    return refuseSendLink('expired');
  }

  const draft = await (deps.createDraft ?? createDraftRow)({
    callId: flow.call_control_id,
    callerPhone: phone,
    lines,
    fulfilment,
    subtotalCents: verdict.quote.subtotal_cents,
  });

  const body = renderRelayTemplate('order_link', {
    url: (deps.orderLink ?? orderLinkFor)(draft.token),
  });
  if (!body) {
    // A null render means AKME_ORDER_BASE_URL produced something that cannot go
    // in a text. That is a configuration fault, not a caller fault, and it must
    // be loud in the log even though the caller hears the ordinary sentence.
    console.error('[agent] send_order_link could not render the link message; check AKME_ORDER_BASE_URL');
    return refuseSendLink('sms_failed');
  }

  try {
    await deps.sendText(phone, body);
  } catch (err) {
    console.error(`[agent] send_order_link send to ${phone} failed:`, err);
    return refuseSendLink('sms_failed');
  }

  return {
    speech:
      'Sent, that should be on your phone now. Open the link, check the quantities and confirm it there. ' +
      'It stays good for the next forty-eight hours.',
  };
}
