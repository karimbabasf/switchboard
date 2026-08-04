import { db, unwrap } from '../db.ts';
import {
  indexThread,
  partyByThreadId,
  partyThread,
  repairThread,
  resolveParty,
  setPartyName,
  type IndexKey,
} from '../crm/surface.ts';
import type { Contact } from '../types';

/**
 * Maps a phone number to the Telegram thread it belongs in.
 *
 * Since 2026-08-04 that thread belongs to a PARTY, not to a contact, and it
 * lives in the one shared ops group with Akme's email and order cards (see
 * lib/crm/surface.ts and Akme's docs/crm-surface.md). Somebody who calls and
 * also emails now has one thread instead of one per repo.
 *
 * This file stays the seam every caller in switchboard already imports, so the
 * change is a swap of what backs these functions rather than a rewrite of every
 * call site. `contacts` is still this repo's record of a phone number and its
 * display name; `contacts.telegram_topic_id` is no longer read or written,
 * because the topic mapping now has exactly one home in `crm_topics`.
 */

const TOPIC_NAME_MAX = 128;

/** Returns the party thread for a phone, creating the contact row and the topic if needed. */
export async function resolveTopic(phone: string): Promise<number> {
  const contact = await getOrCreateContact(phone);
  const party = await resolveParty('phone', phone, contact.display_name);
  return partyThread(party);
}

/**
 * Clears a dead mapping and opens a fresh topic for the same party. Telegram
 * gives no way to recover a deleted topic's history, so the durable message log
 * in `messages` (not Telegram) stays the record of what was said before.
 */
export async function recreateTopic(phone: string): Promise<number> {
  const contact = await getContact(phone);
  const party = await resolveParty('phone', phone, contact?.display_name ?? null);
  const existing = await db()
    .from('crm_topics')
    .select('thread_id')
    .eq('party_id', party.id)
    .eq('status', 'active')
    .maybeSingle();
  const threadId = (existing.data as { thread_id: number | null } | null)?.thread_id ?? null;
  if (threadId !== null) return repairThread(threadId);
  return partyThread(party);
}

/**
 * Repairs a topic known only by its now-dead thread id, e.g. from a failed
 * send. Party topics and standing topics are both covered, because the
 * crm_topics row says which kind it was: the old version had to try a contacts
 * lookup and then a settings lookup, and the settings half was missing for a
 * while, which wedged the outbox drain on every retry.
 */
export async function repairTopic(oldThreadId: number): Promise<number> {
  return repairThread(oldThreadId);
}

/**
 * Reverse lookup used by the webhook to attribute a typed reply to a contact,
 * so plain typing in a topic sends that person an SMS.
 *
 * Returns null for a thread that belongs to an email-only party: there is no
 * number to text, and the webhook's existing behaviour for an unmapped thread
 * (drop it) is the right one. The contacts row is created on demand because the
 * party may have arrived through Akme's side, where a phone can be known
 * without this repo ever having seen a call from it.
 */
export async function contactByThreadId(threadId: number): Promise<Contact | null> {
  const party = await partyByThreadId(threadId);
  if (!party?.primary_phone) return null;
  return getOrCreateContact(party.primary_phone);
}

/** Plain lookup, no create. Used by card renderers that want a display name but must not race resolveTopic's own upsert. */
export async function getContact(phone: string): Promise<Contact | null> {
  const res = await db().from('contacts').select('*').eq('phone', phone).maybeSingle();
  if (res.error) throw new Error(`getContact(${phone}): ${res.error.message}`);
  return (res.data as Contact | null) ?? null;
}

/**
 * Records a caller's name in both places it has to be true: this repo's
 * `contacts` row and the shared party the topic is titled after.
 *
 * The party is what the topic title comes from now, so writing only the contact
 * row would leave a thread titled with a bare number for somebody whose name we
 * know, which is exactly the unsearchable state carrying both is meant to fix.
 */
export async function learnContactName(phone: string, displayName: string): Promise<void> {
  const name = displayName.trim();
  if (!name) throw new Error('learnContactName: displayName is empty');

  const res = await db()
    .from('contacts')
    .update({ display_name: name })
    .eq('phone', phone)
    .select('*')
    .maybeSingle();
  if (res.error) throw new Error(`learnContactName: update display_name for ${phone}: ${res.error.message}`);
  const contact = res.data as Contact | null;
  if (!contact) throw new Error(`learnContactName: no contact for ${phone}`);

  const party = await resolveParty('phone', phone, name);
  await setPartyName(party, name);
}

async function getOrCreateContact(phone: string): Promise<Contact> {
  // Upsert-then-select rather than insert-then-catch: two concurrent first
  // contacts for the same phone would otherwise race on the primary key.
  const { error: upsertError } = await db()
    .from('contacts')
    .upsert({ phone }, { onConflict: 'phone', ignoreDuplicates: true });
  if (upsertError) throw new Error(`getOrCreateContact: upsert ${phone}: ${upsertError.message}`);

  const res = await db().from('contacts').select('*').eq('phone', phone).single();
  return unwrap(res, `getOrCreateContact: load ${phone}`);
}

/** Best-effort display formatting for a US E.164 number; anything else is shown as-is. */
export function formatPhoneForDisplay(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

// --- Standing topics -------------------------------------------------------
// The group has exactly four, they are Akme's INDEX_TITLES, and both repos
// claim the same rows. This repo's own "📋 Quote Requests" topic is retired:
// a second queue meant a human had two places to look for work, and the
// 2026-08-04 decision (one group, two bots, one queue) is that there is one.

/**
 * Kept as the name lib/quote-requests.ts imports, now pointing at the shared
 * queue. A quote request IS a thing a human owes somebody, which is what
 * 🔴 Needs You is for.
 */
export const QUOTE_REQUESTS_TOPIC = 'needs_you';

const INDEX_KEYS: Record<string, IndexKey> = {
  needs_you: 'needs_you',
  pipeline: 'pipeline',
  handled: 'handled',
  system: 'system',
  // The pre-consolidation key, still accepted so an in-flight caller or an old
  // outbox row does not throw on a name that used to be right.
  quote_requests: 'needs_you',
};

/** Resolves a standing topic by key, creating it on first use. */
export async function resolveIndexTopic(key: string): Promise<number> {
  const mapped = INDEX_KEYS[key];
  if (!mapped) throw new Error(`resolveIndexTopic: unknown standing topic ${JSON.stringify(key)}`);
  return indexThread(mapped);
}

export { TOPIC_NAME_MAX };
