import { db } from '../db.ts';
import { resolveParty } from './surface.ts';
import type { CallSummary } from '../types.ts';

/**
 * The switchboard half of the shared crm_timeline: texts and calls, written
 * next to Akme's emails so a customer has ONE thread instead of three.
 *
 * OWNERSHIP EXCEPTION, and the only one in this repo. 20260727000000_init.sql
 * and 20260804000019_crm_unified_surface.sql both say the same thing:
 * switchboard reads Akme's tables and writes only its own. crm_timeline is the
 * deliberate exception, because the table is a READING SURFACE rather than a
 * book of record and it is worthless if only half the channels reach it. Akme
 * owns the schema and the migration; both repos append rows. Nothing here
 * updates or deletes a row, and every row points back at the switchboard table
 * that owns the truth (`messages`, `calls`), so the exception buys the agent a
 * complete thread without moving where any fact lives.
 *
 * Deliberately the same shape as Akme's lib/ops/agent/timeline.ts, for the same
 * reason lib/crm/surface.ts mirrors its lib/ops/surface/index.ts: two repos, one
 * database, no shared package, so a reader of one has to recognise the other.
 *
 * Everything here THROWS on failure, and every caller catches. A reading surface
 * is not allowed to cost a customer their text or strand a call mid-pipeline, so
 * the swallow lives at the three call sites where a reader can see what it
 * protects, exactly as Akme's scan.ts does it.
 */

export type TimelineChannel = 'email' | 'sms' | 'call' | 'human';
export type TimelineDirection = 'in' | 'out';

export interface TimelineRow {
  id: string;
  party_id: string;
  channel: TimelineChannel;
  direction: TimelineDirection;
  body: string;
  occurred_at: string;
  source_table: string | null;
  source_id: string | null;
  order_id: string | null;
  shadow: boolean;
  created_at: string;
}

export interface NewTimelineEntry {
  partyId: string;
  channel: TimelineChannel;
  direction: TimelineDirection;
  body: string;
  occurredAt: Date;
  sourceTable?: string;
  sourceId?: string;
  shadow?: boolean;
}

/** Append one event. Idempotent on (sourceTable, sourceId) when both are given. */
export async function appendTimeline(entry: NewTimelineEntry): Promise<TimelineRow> {
  const sourceTable = entry.sourceTable ?? null;
  const sourceId = entry.sourceId ?? null;

  const row: Record<string, unknown> = {
    party_id: entry.partyId,
    channel: entry.channel,
    direction: entry.direction,
    body: entry.body,
    occurred_at: entry.occurredAt.toISOString(),
    source_table: sourceTable,
    source_id: sourceId,
  };
  // Left out rather than sent as null when the caller said nothing: the column
  // defaults to true, and shadow is the default at every layer.
  if (entry.shadow !== undefined) row.shadow = entry.shadow;

  const ins = await db().from('crm_timeline').insert(row).select('*').single();
  if (!ins.error) return ins.data as TimelineRow;

  // A retried webhook or a re-run worker, not an error. The unique index over
  // (source_table, source_id) already holds the row this call was about to
  // write, so the caller gets that one back and the timeline stays a single
  // record of a single event. Anything else, including a duplicate with no
  // source pointer, is a real failure and is raised.
  if (ins.error.code !== '23505' || !sourceTable || !sourceId) {
    throw new Error(`appendTimeline failed: ${ins.error.message}`);
  }

  const existing = await db()
    .from('crm_timeline')
    .select('*')
    .eq('source_table', sourceTable)
    .eq('source_id', sourceId)
    .maybeSingle();
  if (existing.error) throw new Error(`appendTimeline failed: ${existing.error.message}`);
  if (!existing.data) {
    throw new Error(`appendTimeline: duplicate on ${sourceTable}/${sourceId} but no row to return`);
  }
  return existing.data as TimelineRow;
}

/**
 * A timestamp from a webhook or a database row, or now if it is unusable.
 *
 * occurred_at is NOT NULL and a bad string would take the whole write down. The
 * time an event happened is worth reaching for, but not worth losing the event
 * over: an entry stamped a second late still reads correctly, and a missing one
 * does not read at all.
 */
function at(value: string | null | undefined): Date {
  if (value) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return new Date();
}

export interface InboundSmsEntry {
  phone: string;
  body: string | null;
  messageId: string;
  occurredAt: string;
  displayName?: string | null;
}

/** An inbound text. `messageId` is the `messages` row, which owns the truth. */
export async function noteInboundSms(input: InboundSmsEntry): Promise<TimelineRow> {
  const party = await resolveParty('phone', input.phone, input.displayName ?? null);
  return appendTimeline({
    partyId: party.id,
    channel: 'sms',
    direction: 'in',
    // An MMS with no text is still an event: the attachment is the message,
    // and a silent gap in the thread reads as nothing happening.
    body: input.body?.trim() || '(no text, attachment only)',
    occurredAt: at(input.occurredAt),
    sourceTable: 'messages',
    sourceId: input.messageId,
  });
}

export interface OutboundSmsEntry {
  phone: string;
  body: string;
  messageId: string;
  occurredAt: string | null;
}

/**
 * A text that actually reached the customer.
 *
 * `shadow: false` is the whole point of writing this at the send door rather
 * than at any one decision point: the row means a real message went out, so it
 * is never a draft, whichever of the four callers sent it.
 */
export async function noteOutboundSms(input: OutboundSmsEntry): Promise<TimelineRow> {
  const party = await resolveParty('phone', input.phone, null);
  return appendTimeline({
    partyId: party.id,
    channel: 'sms',
    direction: 'out',
    body: input.body,
    occurredAt: at(input.occurredAt),
    sourceTable: 'messages',
    sourceId: input.messageId,
    shadow: false,
  });
}

export interface CallSummaryEntry {
  phone: string;
  callId: string;
  summary: CallSummary;
  occurredAt: string | null;
}

/**
 * A finished call, as the summary the worker just produced.
 *
 * `direction: 'in'` because every row switchboard writes to `calls` is inbound
 * (lib/telnyx/voice.ts is the only writer and it hard-codes it). An outbound
 * call would need this mapped, not defaulted.
 */
export async function noteCallSummary(input: CallSummaryEntry): Promise<TimelineRow> {
  const party = await resolveParty('phone', input.phone, null);
  return appendTimeline({
    partyId: party.id,
    channel: 'call',
    direction: 'in',
    body: renderCallSummary(input.summary),
    occurredAt: at(input.occurredAt),
    sourceTable: 'calls',
    sourceId: input.callId,
  });
}

/**
 * The summary as prose, not as a card.
 *
 * completedCallCard renders the same object with HTML tags and bullets for a
 * human reading Telegram. This is read by a model alongside emails and texts,
 * so the markup would be noise it has to spend attention discarding.
 */
export function renderCallSummary(summary: CallSummary): string {
  const lines = [summary.headline];
  if (summary.caller_wanted.trim()) lines.push(`Wanted: ${summary.caller_wanted}`);
  if (summary.commitments.length > 0) lines.push(`We committed to: ${summary.commitments.join('; ')}`);
  if (summary.action_items.length > 0) lines.push(`Action items: ${summary.action_items.join('; ')}`);
  if (summary.needs_followup) lines.push('Needs followup.');
  return lines.join('\n');
}
