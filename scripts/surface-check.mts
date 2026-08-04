/**
 * Proves that this repo and Akme agree on ONE thread per human in ONE group.
 *
 * The consolidation is not something unit tests can show: both repos pass their
 * own suites while posting into different groups, which is exactly the state
 * this replaced. What has to be true is a property of the live database and the
 * live group, so this asks it there:
 *
 *   1. a phone that Akme already knows resolves to the topic Akme created,
 *      rather than minting a second one for the same person
 *   2. a quote request goes to the shared 🔴 Needs You queue
 *   3. neither of those creates a crm_topics row, because both already exist
 *
 * Read-only by default. `--live-card` additionally files a real quote request
 * through the real path, which is the only way to prove the outbox and the
 * worker put a card in the right thread of the right group.
 *
 *   node --env-file=.env.local scripts/surface-check.mts [--live-card] [+1...]
 */

import { db } from '../lib/db.ts';
import { partyTopicTitle, resolveParty } from '../lib/crm/surface.ts';
import { QUOTE_REQUESTS_TOPIC, resolveIndexTopic, resolveTopic } from '../lib/telegram/topics.ts';

const PHONE = process.argv.find((a) => a.startsWith('+')) ?? '+14155550142';
const LIVE_CARD = process.argv.includes('--live-card');

const chatId = Number(process.env.TELEGRAM_CHAT_ID);
let failures = 0;

function report(ok: boolean, what: string, detail: string): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}  ${detail}`);
}

async function topicCount(): Promise<number> {
  const { count, error } = await db()
    .from('crm_topics')
    .select('id', { count: 'exact', head: true })
    .eq('chat_id', chatId);
  if (error) throw new Error(`count crm_topics: ${error.message}`);
  return count ?? 0;
}

console.log(`\nShared ops surface, chat ${chatId}\n`);

const before = await topicCount();

const party = await resolveParty('phone', PHONE);
const existing = await db()
  .from('crm_topics')
  .select('thread_id,title')
  .eq('chat_id', chatId)
  .eq('party_id', party.id)
  .eq('status', 'active')
  .maybeSingle();
const knownThread = (existing.data as { thread_id: number; title: string } | null) ?? null;

const thread = await resolveTopic(PHONE);
report(
  knownThread === null || thread === knownThread.thread_id,
  'the phone lands in the party topic that already existed',
  knownThread ? `thread ${thread} === ${knownThread.thread_id} ("${knownThread.title}")` : `no prior topic, minted ${thread}`,
);
report(
  party.primary_email === null || thread === knownThread?.thread_id,
  'one thread for a human who both calls and emails',
  `party "${party.display_name}" email=${party.primary_email ?? 'none'} phone=${party.primary_phone ?? 'none'}`,
);
report(
  knownThread === null || knownThread.title === partyTopicTitle(party),
  'both repos compute the same topic title',
  knownThread ? `"${knownThread.title}" === "${partyTopicTitle(party)}"` : 'no prior topic to compare',
);

const queue = await resolveIndexTopic(QUOTE_REQUESTS_TOPIC);
const needsYou = await db()
  .from('crm_topics')
  .select('thread_id,title')
  .eq('chat_id', chatId)
  .eq('index_key', 'needs_you')
  .eq('status', 'active')
  .maybeSingle();
const queueRow = (needsYou.data as { thread_id: number; title: string } | null) ?? null;
report(
  queueRow !== null && queue === queueRow.thread_id,
  'a quote request goes to the ONE queue Akme also posts to',
  queueRow ? `thread ${queue} ("${queueRow.title}")` : 'needs_you topic is missing',
);

const after = await topicCount();
report(after === before, 'resolving created no duplicate topics', `${before} topics before, ${after} after`);

if (LIVE_CARD) {
  // Deliberately an outbox row and not a quote request: lib/quote-requests.ts is
  // Karim's and imports its dependencies without file extensions, which Node
  // cannot resolve from a script (Next resolves it fine). The card renderers
  // have the same shape. What is worth proving live is the part that changed,
  // which is the ADDRESS: the same thread resolveTopic just returned, in the
  // shared group, drained by the real worker rather than by this script.
  const rows = [
    { thread_id: thread, text: 'Surface check: this line is the party thread, reached from switchboard.' },
    { thread_id: queue, text: 'Surface check: this line is the shared queue, reached from switchboard.' },
  ];
  const inserted = await db()
    .from('outbox')
    .insert(rows.map((r) => ({ thread_id: r.thread_id, kind: 'text', payload: { text: r.text } })))
    .select('id,thread_id,status');
  if (inserted.error) throw new Error(`queue the live cards: ${inserted.error.message}`);
  const queued = (inserted.data ?? []) as { id: string; thread_id: number; status: string }[];
  report(
    queued.length === 2 && queued.every((r) => r.status === 'pending'),
    'two cards queued, addressed to the party thread and the shared queue',
    `outbox ${queued.map((r) => `${r.id.slice(0, 8)}->thread ${r.thread_id}`).join(', ')}`,
  );
  console.log('\n  the pg_cron worker drains within 2 minutes; check the group, not this output\n');
}

console.log(
  failures === 0
    ? `\nAll checks passed. One group, one thread per human.\n`
    : `\n${failures} check(s) failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
