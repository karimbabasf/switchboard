import { db, unwrap } from '../db';
import type { Contact } from '../types';
import { telegram } from './client';

/**
 * Maps contacts to Telegram forum topics and repairs the mapping when a topic
 * is gone. Any group admin can permanently delete a topic with no recovery
 * path on Telegram's side, so `telegram_topic_id` is treated as replaceable,
 * never durable: Supabase is the source of truth, the topic is just a view.
 */

const TOPIC_NAME_MAX = 128;
const TOPIC_NAME_SEPARATOR = ' · ';

/** Returns the topic for a phone, creating both the contact row and the topic if needed. */
export async function resolveTopic(phone: string): Promise<number> {
  const contact = await getOrCreateContact(phone);
  if (contact.telegram_topic_id !== null) return contact.telegram_topic_id;
  return createAndStoreTopic(phone, contact.display_name);
}

/**
 * Clears a dead mapping and opens a fresh topic for the same contact. Telegram
 * gives no way to recover the old topic's history, so the durable message log
 * in `messages` (not Telegram) stays the record of what was said before.
 */
export async function recreateTopic(phone: string): Promise<number> {
  const { error } = await db()
    .from('contacts')
    .update({ telegram_topic_id: null, topic_created_at: null })
    .eq('phone', phone);
  if (error) throw new Error(`recreateTopic: clear mapping for ${phone}: ${error.message}`);

  const res = await db().from('contacts').select('*').eq('phone', phone).maybeSingle();
  if (res.error) throw new Error(`recreateTopic: reload contact ${phone}: ${res.error.message}`);
  const contact = res.data as Contact | null;
  return createAndStoreTopic(phone, contact?.display_name ?? null);
}

/**
 * Repairs a topic known only by its now-dead thread id, e.g. from a failed
 * send. Tries a contact first, then a standing index topic (Quote Requests
 * and any future one), since an index topic has no contacts row at all and
 * contactByThreadId alone would never find it.
 *
 * That gap was a real bug: an admin deleting the Quote Requests topic made
 * the outbox drain's repair path throw "no contact maps to thread N" forever
 * (every retry hit the exact same dead end), because this function never
 * looked anywhere else. Reproduced against the pre-fix version before this
 * fallback was added; see the index-topic case in tests/telegram.test.ts.
 */
export async function repairTopic(oldThreadId: number): Promise<number> {
  const contact = await contactByThreadId(oldThreadId);
  if (contact) return recreateTopic(contact.phone);

  const indexKey = await indexTopicKeyByThreadId(oldThreadId);
  if (indexKey) return recreateIndexTopic(indexKey);

  throw new Error(`repairTopic: no contact or index topic maps to thread ${oldThreadId}, cannot recreate`);
}

/** Reverse lookup used by the webhook to attribute an inbound reply to a contact. */
export async function contactByThreadId(threadId: number): Promise<Contact | null> {
  const res = await db().from('contacts').select('*').eq('telegram_topic_id', threadId).maybeSingle();
  if (res.error) throw new Error(`contactByThreadId(${threadId}): ${res.error.message}`);
  return (res.data as Contact | null) ?? null;
}

/** Plain lookup, no create. Used by card renderers that want a display name but must not race resolveTopic's own upsert. */
export async function getContact(phone: string): Promise<Contact | null> {
  const res = await db().from('contacts').select('*').eq('phone', phone).maybeSingle();
  if (res.error) throw new Error(`getContact(${phone}): ${res.error.message}`);
  return (res.data as Contact | null) ?? null;
}

/**
 * Records a contact's name and, if they already have a topic, renames it to
 * match. Topic titles carry both name and number once a name is known (see
 * topicTitle below), so a contact who gets a name later must not keep a
 * topic titled only with their number: unsearchable by either the name or a
 * complete label, which is exactly the problem carrying both is meant to fix.
 *
 * No caller in this codebase invokes this yet: grepping the repo turns up
 * nowhere that writes contacts.display_name at all today. This is the
 * primitive whatever eventually learns a caller's name (e.g. an agent tool)
 * needs to call; wiring that trigger is outside lib/telegram's ownership.
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

  if (contact.telegram_topic_id === null) return; // no topic yet; the next resolveTopic call will use the name
  await telegram.editForumTopic(contact.telegram_topic_id, topicTitle(name, phone));
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

async function createAndStoreTopic(phone: string, displayName: string | null): Promise<number> {
  const name = topicTitle(displayName, phone);
  const topic = await telegram.createForumTopic(name);

  const { error } = await db()
    .from('contacts')
    .update({ telegram_topic_id: topic.message_thread_id, topic_created_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) throw new Error(`createAndStoreTopic: persist topic for ${phone}: ${error.message}`);

  return topic.message_thread_id;
}

/**
 * Both name and number when a name is known, so the topic list is searchable
 * by either: a contact who later gets a name must not keep a topic titled
 * only with their number. The phone number always survives truncation at
 * Telegram's 128-character cap; only an unusually long name gets cut, since
 * the number is the one identifier guaranteed to be short and always known.
 */
function topicTitle(displayName: string | null, phone: string): string {
  const formatted = formatPhoneForDisplay(phone);
  const name = displayName?.trim();
  if (!name) return formatted.slice(0, TOPIC_NAME_MAX);

  const budget = TOPIC_NAME_MAX - TOPIC_NAME_SEPARATOR.length - formatted.length;
  if (budget <= 0) return formatted.slice(0, TOPIC_NAME_MAX); // pathological: number alone is already at the cap
  const truncatedName = name.length > budget ? name.slice(0, budget) : name;
  return `${truncatedName}${TOPIC_NAME_SEPARATOR}${formatted}`;
}

/** Best-effort display formatting for a US E.164 number; anything else is shown as-is. */
export function formatPhoneForDisplay(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}

// --- Index topics: standing, non-contact queues. Currently just Quote Requests, --
// --- but resolveIndexTopic and repairTopic's index-topic path are generic. -------

/** Passed to resolveIndexTopic by lib/quote-requests.ts. Also the switchboard_settings row's key. */
export const QUOTE_REQUESTS_TOPIC = 'quote_requests';

const INDEX_TOPIC_TITLES: Record<string, string> = {
  [QUOTE_REQUESTS_TOPIC]: '📋 Quote Requests',
};

/** Written while a claim is in flight, so a fast-path read can tell "not created yet" apart from "being created right now". */
const INDEX_TOPIC_PENDING = '__pending__';
const INDEX_TOPIC_POLL_ATTEMPTS = 20;
const INDEX_TOPIC_POLL_DELAY_MS = 150;

/**
 * Resolves a standing topic by a logical key (e.g. QUOTE_REQUESTS_TOPIC),
 * creating it on first use. The thread id lives in switchboard_settings
 * (key/value), not .env: it does not exist until this code runs, and it
 * changes if an admin deletes the topic, the same replaceable relationship
 * contacts have to their own telegram_topic_id column.
 *
 * Concurrent first-use is resolved at the database, not in memory, because
 * two Vercel invocations racing this share nothing else: switchboard_settings'
 * primary key on `key` makes the claim below atomic, so only the caller whose
 * upsert actually inserts a row goes on to call createForumTopic. Every other
 * concurrent caller polls for the value the winner writes, the same
 * claim-and-check idiom as claimEvent's dedupe in lib/telnyx/sms.ts.
 */
export async function resolveIndexTopic(key: string): Promise<number> {
  const existing = await readIndexTopicValue(key);
  if (existing !== null) return existing;

  const claim = await db()
    .from('switchboard_settings')
    .upsert({ key, value: INDEX_TOPIC_PENDING }, { onConflict: 'key', ignoreDuplicates: true })
    .select('key');
  if (claim.error) throw new Error(`resolveIndexTopic: claim ${key}: ${claim.error.message}`);
  const wonClaim = (claim.data?.length ?? 0) > 0;

  if (!wonClaim) return pollIndexTopicValue(key);

  const topic = await telegram.createForumTopic(indexTopicTitle(key));
  const { error } = await db()
    .from('switchboard_settings')
    .update({ value: String(topic.message_thread_id) })
    .eq('key', key);
  if (error) throw new Error(`resolveIndexTopic: persist ${key}: ${error.message}`);
  return topic.message_thread_id;
}

async function readIndexTopicValue(key: string): Promise<number | null> {
  const res = await db().from('switchboard_settings').select('value').eq('key', key).maybeSingle();
  if (res.error) throw new Error(`resolveIndexTopic: read ${key}: ${res.error.message}`);
  const value = (res.data as { value: string } | null)?.value ?? null;
  return value === null || value === INDEX_TOPIC_PENDING ? null : Number(value);
}

async function pollIndexTopicValue(key: string): Promise<number> {
  for (let attempt = 0; attempt < INDEX_TOPIC_POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(INDEX_TOPIC_POLL_DELAY_MS);
    const value = await readIndexTopicValue(key);
    if (value !== null) return value;
  }
  throw new Error(`resolveIndexTopic: timed out waiting for ${key}; another caller may have failed mid-create`);
}

function indexTopicTitle(key: string): string {
  return (INDEX_TOPIC_TITLES[key] ?? key).slice(0, TOPIC_NAME_MAX);
}

/**
 * Reverse lookup for the index-topic half of repairTopic's recovery: an index
 * topic has no contacts row, so contactByThreadId alone never finds it.
 */
async function indexTopicKeyByThreadId(threadId: number): Promise<string | null> {
  const res = await db().from('switchboard_settings').select('key').eq('value', String(threadId)).maybeSingle();
  if (res.error) throw new Error(`indexTopicKeyByThreadId(${threadId}): ${res.error.message}`);
  return (res.data as { key: string } | null)?.key ?? null;
}

async function recreateIndexTopic(key: string): Promise<number> {
  const topic = await telegram.createForumTopic(indexTopicTitle(key));
  const { error } = await db()
    .from('switchboard_settings')
    .update({ value: String(topic.message_thread_id) })
    .eq('key', key);
  if (error) throw new Error(`recreateIndexTopic: persist ${key}: ${error.message}`);
  return topic.message_thread_id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
