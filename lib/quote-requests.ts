/**
 * A quote request is the only thing this phone line is really trying to produce.
 *
 * The agent cannot price anything and must never try. What it can do is find out
 * what somebody needs and put that in front of a human as a work item. This
 * module is that work item: one row, plus a card in a standing Telegram topic
 * that exists to be a queue rather than a conversation.
 *
 * Why the card does not go in the customer's own topic: it does, as part of the
 * call summary, and that is the wrong place to WORK from. A per-contact topic
 * answers "what did this person say"; the index topic answers "what have we not
 * priced yet", and reading the second one out of the first means opening every
 * topic in the group. The row is the record, both cards are views.
 *
 * This module owns the row. lib/telegram owns how it is displayed, which is why
 * the only Telegram it touches is two named functions and an outbox insert.
 */

import { db } from './db';
import { formatPhoneForDisplay, resolveIndexTopic, resolveTopic, QUOTE_REQUESTS_TOPIC } from './telegram/topics';
import { quoteRequestCard, type TextCardPayload } from './telegram/cards';

export interface QuoteRequestRow {
  id: string;
  contact_phone: string;
  source: 'call' | 'sms';
  wants: string;
  caller_name: string | null;
  handled_at: string | null;
  telegram_message_id: number | null;
  created_at: string;
}

export interface NewQuoteRequest {
  phone: string;
  source: 'call' | 'sms';
  /** What the customer asked for, in their words wherever possible. */
  wants: string;
  callerName?: string | null;
}

/**
 * Records the request and queues its card. Returns the row so a caller that
 * needs to say something back ("I have put that in for you") is talking about a
 * request that definitely exists.
 *
 * The card is enqueued, never sent: Telegram caps a group at roughly 20 messages
 * a minute shared across every topic, and a burst of calls would otherwise start
 * dropping cards silently. Same rule as every other send in this codebase.
 *
 * A Telegram failure here must not lose the request. The row is written first and
 * committed regardless, so the worst case is a work item that exists in Postgres
 * with no card, which `openQuoteRequests` can still find.
 */
export async function recordQuoteRequest(input: NewQuoteRequest): Promise<QuoteRequestRow> {
  const wants = input.wants.trim();
  if (!wants) throw new Error('recordQuoteRequest: wants is empty, there is nothing to price');

  const inserted = await db()
    .from('quote_requests')
    .insert({
      contact_phone: input.phone,
      source: input.source,
      wants,
      caller_name: input.callerName?.trim() || null,
    })
    .select('*')
    .single();

  if (inserted.error) throw new Error(`recordQuoteRequest: ${inserted.error.message}`);
  const row = inserted.data as QuoteRequestRow;

  const card = await quoteRequestCard({
    id: row.id,
    who: input.callerName?.trim() || formatPhoneForDisplay(input.phone),
    phone: input.phone,
    source: input.source,
    wants,
  }).catch((err) => {
    console.error(`[quote-requests] card render failed for ${row.id}:`, err);
    return null;
  });

  // Two chances to be seen, because a request nobody sees is the same as a
  // request nobody took. The index topic is where this is WORKED from, so it is
  // tried first; the contact's own topic is where it is at least READ, and it
  // needs no topic creation to succeed, so it is what the fallback aims at.
  if (card) {
    try {
      await enqueue(await resolveIndexTopic(QUOTE_REQUESTS_TOPIC), card);
    } catch (err) {
      console.error(`[quote-requests] index card failed for ${row.id}, falling back to the contact topic:`, err);
      try {
        await enqueue(await resolveTopic(input.phone), card);
      } catch (fallbackErr) {
        // Now genuinely swallowed. The row is committed and a human can still
        // find it; throwing here would fail the tool call the agent is waiting
        // on mid-sentence, which the caller would hear.
        console.error(`[quote-requests] contact-topic fallback also failed for ${row.id}:`, fallbackErr);
      }
    }
  }

  return row;
}

async function enqueue(threadId: number, payload: TextCardPayload): Promise<void> {
  const { error } = await db().from('outbox').insert({ thread_id: threadId, kind: 'text', payload });
  if (error) throw new Error(`outbox insert failed: ${error.message}`);
}

/** Called by the Done button. Idempotent: a double tap is a no-op, not an overwrite. */
export async function markQuoteRequestHandled(id: string, by: string): Promise<boolean> {
  const res = await db()
    .from('quote_requests')
    .update({ handled_at: new Date().toISOString(), handled_by: by })
    .eq('id', id)
    .is('handled_at', null)
    .select('id');
  if (res.error) throw new Error(`markQuoteRequestHandled: ${res.error.message}`);
  return (res.data?.length ?? 0) > 0;
}
