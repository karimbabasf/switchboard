import { db } from '../db.ts';
import { env } from '../env.ts';
import { telegram } from '../telegram/client.ts';

/**
 * The switchboard half of the SHARED ops surface.
 *
 * Akme and switchboard post into ONE Telegram group with one topic per party
 * (a customer as a person, across every channel they reach us on) plus four
 * standing topics. The party resolver and the topic claim protocol live in
 * Postgres, not here, because the two repos share a database and no package:
 * see Akme's supabase/migrations/20260804000019_crm_unified_surface.sql.
 *
 * This module is a thin client for those functions, deliberately the same shape
 * as Akme's lib/ops/surface/index.ts so a reader of one recognises the other.
 * What used to map a CONTACT to a topic now maps a PARTY to a topic, which is
 * the whole point: somebody who calls and also emails gets one thread.
 */

/**
 * The standing topics. Akme's lib/ops/surface/index.ts owns this set and this
 * is a copy of it, because the two repos share a database and no package.
 *
 * It had DRIFTED and that is worth recording: this file still said
 * `'needs_you' | 'system'` with a 🚨 System title on 2026-08-18, months after
 * Akme retired that topic into 🧑 Human Intervention. Nothing called it, so
 * nothing broke, but claiming `index_key = 'system'` would have minted a fifth
 * topic in the shared group that only one of the two bots knew about.
 *
 * `willcall` and `delivery` are the fulfilled-order boards added 2026-08-18.
 * The keys are Akme's FulfilmentMethod strings verbatim, so an order routes by
 * its own column rather than through a translation table.
 */
export type IndexKey = 'needs_you' | 'human' | 'willcall' | 'delivery';

/** Must stay identical to Akme's INDEX_TITLES: both repos claim the same rows. */
export const INDEX_TITLES: Record<IndexKey, string> = {
  needs_you: '🔴 Needs You',
  human: '🧑 Human Intervention',
  willcall: '📦 Will Call',
  delivery: '🚚 Delivery',
};

export interface Party {
  id: string;
  display_name: string;
  customer_id: string | null;
  primary_email: string | null;
  primary_phone: string | null;
}

interface TopicRow {
  kind: 'party' | 'index';
  party_id: string | null;
  index_key: string | null;
  thread_id: number | null;
  title: string | null;
  status: string;
}

const POLL_ATTEMPTS = 20;
const POLL_DELAY_MS = 150;

/** Numeric because crm_claim_topic takes a bigint, and env() gives a string. */
function chatIdNum(): number {
  const raw = env('TELEGRAM_CHAT_ID');
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) {
    throw new Error(`TELEGRAM_CHAT_ID is not numeric: ${JSON.stringify(raw)}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

/**
 * Find or create the party behind a phone number or an email address.
 *
 * Normalisation is the function's job, not the caller's: phones are expected in
 * E.164 (switchboard's `contacts.phone` is where that convention comes from)
 * and `crm_normalize_phone` inside the resolver is what makes Akme's
 * `14155550142` and our `+14155550142` land on one party instead of two.
 */
export async function resolveParty(
  kind: 'email' | 'phone',
  value: string,
  displayName?: string | null,
): Promise<Party> {
  const { data, error } = await db().rpc('crm_resolve_party', {
    p_kind: kind,
    p_value: value,
    p_display_name: displayName ?? null,
  });
  if (error) throw new Error(`crm_resolve_party(${kind}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`crm_resolve_party(${kind}): no row for ${value}`);
  return row as Party;
}

export async function partyById(id: string): Promise<Party | null> {
  const res = await db()
    .from('crm_parties')
    .select('id,display_name,customer_id,primary_email,primary_phone')
    .eq('id', id)
    .maybeSingle();
  if (res.error) throw new Error(`partyById(${id}): ${res.error.message}`);
  return (res.data as Party | null) ?? null;
}

// ---------------------------------------------------------------------------
// Topics: claim in Postgres, mint at Telegram, commit back
// ---------------------------------------------------------------------------

interface Claim {
  topic_id: string;
  thread_id: number | null;
  must_create: boolean;
}

async function claim(
  kind: 'party' | 'index',
  partyId: string | null,
  indexKey: string | null,
  title: string,
): Promise<Claim> {
  const { data, error } = await db().rpc('crm_claim_topic', {
    p_chat_id: chatIdNum(),
    p_kind: kind,
    p_party_id: partyId,
    p_index_key: indexKey,
    p_title: title,
  });
  if (error) throw new Error(`crm_claim_topic(${kind}): ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('crm_claim_topic returned nothing');
  return row as Claim;
}

/**
 * Losers of a claim wait for the winner to commit rather than minting a second
 * topic. Same claim-and-poll idiom this repo already used for its index topics,
 * except the claim is now a row two codebases can both see.
 */
async function pollForThread(kind: 'party' | 'index', key: string): Promise<number> {
  const column = kind === 'party' ? 'party_id' : 'index_key';
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    await sleep(POLL_DELAY_MS);
    const { data } = await db()
      .from('crm_topics')
      .select('thread_id,status')
      .eq('chat_id', chatIdNum())
      .eq(column, key)
      .neq('status', 'gone')
      .maybeSingle();
    const row = data as { thread_id: number | null; status: string } | null;
    if (row?.status === 'active' && row.thread_id !== null) return row.thread_id;
  }
  throw new Error(`crm topic claim never committed for ${kind}:${key}`);
}

async function resolveThread(
  kind: 'party' | 'index',
  partyId: string | null,
  indexKey: string | null,
  title: string,
): Promise<number> {
  const claimed = await claim(kind, partyId, indexKey, title);
  if (!claimed.must_create && claimed.thread_id !== null) return claimed.thread_id;
  if (!claimed.must_create) return pollForThread(kind, (partyId ?? indexKey) as string);

  const topic = await telegram.createForumTopic(title);
  const { error } = await db().rpc('crm_commit_topic', {
    p_topic_id: claimed.topic_id,
    p_thread_id: topic.message_thread_id,
  });
  if (error) throw new Error(`crm_commit_topic: ${error.message}`);
  return topic.message_thread_id;
}

/** Telegram rejects a forum topic name longer than this. */
export const TOPIC_NAME_MAX = 128;
const TOPIC_NAME_SEPARATOR = ' · ';

/**
 * Name AND reachable handle, because a human searches Telegram for whichever
 * one they remember.
 *
 * The same function as Akme's partyTopicTitle, deliberately: Akme renames the
 * topic to ITS title whenever it learns a name, so any disagreement here is a
 * topic that flaps between two spellings on every touch. That is also why this
 * does not use this repo's prettier `(415) 555-0142` form, which still shows
 * inside every card body, where only one repo is writing.
 *
 * Over the cap the NAME is what gets cut, never the handle: the handle is the
 * identifier that is always known and always short, and a title truncated to
 * "AAAA..." is findable by nothing.
 */
export function partyTopicTitle(party: Party): string {
  const handle = party.primary_phone ?? party.primary_email ?? '';
  const name = party.display_name;
  if (!handle || name === handle) return name.slice(0, TOPIC_NAME_MAX);

  const budget = TOPIC_NAME_MAX - TOPIC_NAME_SEPARATOR.length - handle.length;
  if (budget <= 0) return handle.slice(0, TOPIC_NAME_MAX); // pathological: the handle alone fills the cap
  return `${name.slice(0, budget)}${TOPIC_NAME_SEPARATOR}${handle}`;
}

export async function partyThread(party: Party): Promise<number> {
  return resolveThread('party', party.id, null, partyTopicTitle(party));
}

export async function indexThread(key: IndexKey): Promise<number> {
  return resolveThread('index', null, key, INDEX_TITLES[key]);
}

/**
 * The thread ids of the standing topics, live.
 *
 * Read rather than held in a constant because a topic id is minted by Telegram
 * and can change (a human deletes a topic, the repair mints a fresh one), so a
 * cached list is a list that is wrong exactly when it matters.
 *
 * Used by the outbox to decide which sends are silent: everything that is NOT
 * one of these is a customer's own thread. Asking the question that way round
 * is deliberate, because there are four standing topics and an unbounded number
 * of customer ones, and a new customer must default to quiet rather than to
 * buzzing Karim's phone until somebody adds them to a list.
 */
export async function activeIndexThreadIds(): Promise<Set<number>> {
  const res = await db()
    .from('crm_topics')
    .select('thread_id')
    .eq('chat_id', chatIdNum())
    .eq('kind', 'index')
    .eq('status', 'active');
  if (res.error) throw new Error(`activeIndexThreadIds: ${res.error.message}`);
  const rows = (res.data ?? []) as { thread_id: number | null }[];
  return new Set(rows.map((r) => r.thread_id).filter((id): id is number => id !== null));
}

/** Telegram forgets a deleted topic entirely, so Postgres has to be told. */
export async function markTopicGone(threadId: number): Promise<void> {
  const { error } = await db().rpc('crm_mark_topic_gone', {
    p_chat_id: chatIdNum(),
    p_thread_id: threadId,
  });
  if (error) throw new Error(`crm_mark_topic_gone(${threadId}): ${error.message}`);
}

async function topicRowByThreadId(threadId: number): Promise<TopicRow | null> {
  const res = await db()
    .from('crm_topics')
    .select('kind,party_id,index_key,thread_id,title,status')
    .eq('chat_id', chatIdNum())
    .eq('thread_id', threadId)
    .neq('status', 'gone')
    .maybeSingle();
  if (res.error) throw new Error(`topicRowByThreadId(${threadId}): ${res.error.message}`);
  return (res.data as TopicRow | null) ?? null;
}

/**
 * A thread id that is known to be dead, traded for a live one.
 *
 * Marking gone BEFORE re-claiming is the whole trick: crm_claim_topic hands
 * back any row that is not `gone`, so re-claiming first would return the same
 * dead thread and the retry would fail identically forever.
 */
export async function repairThread(threadId: number): Promise<number> {
  const row = await topicRowByThreadId(threadId);
  if (!row) throw new Error(`repairThread: no crm_topics row maps to thread ${threadId}, cannot recreate`);

  await markTopicGone(threadId);

  if (row.kind === 'index') {
    if (!row.index_key) throw new Error(`repairThread: index topic ${threadId} has no index_key`);
    return indexThread(row.index_key as IndexKey);
  }

  if (!row.party_id) throw new Error(`repairThread: party topic ${threadId} has no party_id`);
  const party = await partyById(row.party_id);
  if (!party) throw new Error(`repairThread: party ${row.party_id} for thread ${threadId} is gone`);
  return partyThread(party);
}

/** The party a topic belongs to, for attributing a message typed into it. */
export async function partyByThreadId(threadId: number): Promise<Party | null> {
  const row = await topicRowByThreadId(threadId);
  if (!row || row.kind !== 'party' || !row.party_id) return null;
  return partyById(row.party_id);
}

/**
 * Record a real name on the party and rename its topic to match.
 *
 * The rename is best effort: the name is already durable in Postgres by then,
 * and a Telegram title that lags is a cosmetic problem, while throwing here
 * would fail whatever call the agent was in the middle of.
 */
export async function setPartyName(party: Party, displayName: string): Promise<Party> {
  const name = displayName.trim();
  if (!name) throw new Error('setPartyName: displayName is empty');

  const res = await db()
    .from('crm_parties')
    .update({ display_name: name })
    .eq('id', party.id)
    .select('id,display_name,customer_id,primary_email,primary_phone')
    .maybeSingle();
  if (res.error) throw new Error(`setPartyName(${party.id}): ${res.error.message}`);
  const updated = ((res.data as Party | null) ?? { ...party, display_name: name }) as Party;

  const row = await db()
    .from('crm_topics')
    .select('thread_id,title')
    .eq('chat_id', chatIdNum())
    .eq('party_id', party.id)
    .eq('status', 'active')
    .maybeSingle();
  const current = row.data as { thread_id: number | null; title: string | null } | null;
  const want = partyTopicTitle(updated);
  if (current?.thread_id != null && current.title !== want) {
    try {
      await telegram.editForumTopic(current.thread_id, want);
      await db()
        .from('crm_topics')
        .update({ title: want })
        .eq('chat_id', chatIdNum())
        .eq('party_id', party.id);
    } catch (err) {
      console.error(`[surface] retitle of party ${party.id} failed:`, err);
    }
  }

  return updated;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
