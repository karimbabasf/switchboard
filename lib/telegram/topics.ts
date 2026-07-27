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

/** Repairs a topic known only by its now-dead thread id, e.g. from a failed send. */
export async function repairTopic(oldThreadId: number): Promise<number> {
  const contact = await contactByThreadId(oldThreadId);
  if (!contact) {
    throw new Error(`repairTopic: no contact maps to thread ${oldThreadId}, cannot recreate`);
  }
  return recreateTopic(contact.phone);
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
  const name = (displayName?.trim() || formatPhoneForDisplay(phone)).slice(0, TOPIC_NAME_MAX);
  const topic = await telegram.createForumTopic(name);

  const { error } = await db()
    .from('contacts')
    .update({ telegram_topic_id: topic.message_thread_id, topic_created_at: new Date().toISOString() })
    .eq('phone', phone);
  if (error) throw new Error(`createAndStoreTopic: persist topic for ${phone}: ${error.message}`);

  return topic.message_thread_id;
}

/** Best-effort display formatting for a US E.164 number; anything else is shown as-is. */
export function formatPhoneForDisplay(phone: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
}
