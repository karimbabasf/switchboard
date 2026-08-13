/**
 * Orchestrates the post-call pipeline: new -> fetching -> transcribing ->
 * summarizing -> posted. Each status names the step whose output the row now
 * carries, so a claimed row's current status tells run.ts exactly which
 * action to perform next: 'new' needs the recording fetched, 'fetching' needs
 * it transcribed, 'transcribing' needs it summarized, 'summarizing' needs the
 * Telegram outbox rows enqueued (which is what finally marks it 'posted').
 *
 * Concurrency: claiming is a conditional UPDATE keyed on (id, status, attempts)
 * all read together in the same query. Two workers racing on the same row
 * both try to increment attempts starting from that same value; only the
 * first UPDATE matches (the second's WHERE no longer matches once attempts
 * has moved), so exactly one of them proceeds. No SELECT ... FOR UPDATE or
 * separate locking table needed, which matters because pg_cron ticks every 2
 * minutes without waiting for the previous tick to finish.
 */

import { db } from '../db';
import { env } from '../env';
import type { Call, CallStatus } from '../types';
import { fetchRecording, RecordingExpiredError } from './recording';
import { transcribeCall } from './transcribe';
import { summarizeCall } from './summarize';
import { noteCallSummary } from '../crm/timeline';
import type { AudioCardPayload, OutboxPayload } from '../telegram/cards';

/** Generous headroom for the outbox drain's own backoff retries, well past the ~seconds it takes to actually send. */
const OUTBOX_AUDIO_URL_TTL_SECONDS = 60 * 60 * 24;

// The card is assembled lazily rather than imported at module scope: that
// keeps this file resilient to lib/telegram/cards.ts and lib/telegram/topics.ts
// being edited or momentarily unavailable while they're owned by another
// agent in a concurrently building repo, and lets tests inject a fake via
// RunWorkerOptions.callCard without needing the real modules to exist on disk.
export type CallCardFn = (call: Call) => Promise<OutboxPayload[]>;

/** Mirrors DrainResult in lib/telegram/outbox.ts, kept structural to avoid importing it at module scope. */
export type DrainFn = (limit: number) => Promise<{
  processed: number;
  sent: number;
  throttled: number;
  repaired: number;
  failed: number;
}>;

export interface RunWorkerOptions {
  /** Injectable for tests; production default lazily imports lib/telegram/cards.ts. */
  callCard?: CallCardFn;
  /** Injectable for tests; production default lazily imports lib/telegram/outbox.ts. */
  drain?: DrainFn;
  /** Injectable clock for tests. */
  now?: () => Date;
}

export interface RunWorkerResult {
  claimed: number;
  advanced: number;
  posted: number;
  errored: number;
  failed: number;
  /** Zeroed when the drain itself threw; the tick still reports what the calls did. */
  sent: number;
  throttled: number;
}

/** Per-step retry budget. Attempts reset to 0 whenever a step succeeds, so this is a budget per pipeline step, not a lifetime total. */
export const MAX_ATTEMPTS = 5;

type StepOutcome = 'advanced' | 'posted' | 'errored' | 'failed';

export async function runWorker(limit: number, options: RunWorkerOptions = {}): Promise<RunWorkerResult> {
  const now = options.now ?? (() => new Date());
  const result: RunWorkerResult = {
    claimed: 0,
    advanced: 0,
    posted: 0,
    errored: 0,
    failed: 0,
    sent: 0,
    throttled: 0,
  };

  const candidates = await selectCandidates(limit);

  for (const candidate of candidates) {
    const claimed = await claimRow(candidate);
    if (!claimed) continue; // lost the race to another invocation; leave it for next tick
    result.claimed += 1;

    const outcome = await runStep(claimed, now(), options);
    result[outcome] += 1;
  }

  // Draining is part of a tick, not a separate schedule: nothing else calls it,
  // and an enqueued card that never sends is indistinguishable from a broken
  // pipeline. It runs unconditionally because inbound SMS enqueues rows too, so
  // a tick that processed zero calls can still have a full outbox. It runs LAST
  // so a card enqueued by this same tick goes out now rather than in two minutes.
  try {
    const drain = options.drain ?? (await loadDrain());
    // Two rows per call card. The real ceiling is the TokenBucket inside the
    // drain, which holds the group to Telegram's ~20 messages/minute.
    const drained = await drain(limit * 2);
    result.sent = drained.sent;
    result.throttled = drained.throttled;
  } catch (err) {
    // A drain failure must not discard what the calls just did: those rows have
    // already advanced, and the outbox is durable, so the next tick retries.
    console.error(`[worker] outbox drain failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return result;
}

async function selectCandidates(limit: number): Promise<Call[]> {
  const { data, error } = await db()
    .from('calls')
    .select('*')
    .not('status', 'in', '(posted,failed)')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`failed to list pending calls: ${error.message}`);
  return (data ?? []) as Call[];
}

/** The atomic claim: a conditional UPDATE keyed on (id, status, attempts) read in the same query. */
async function claimRow(call: Call): Promise<Call | null> {
  const { data, error } = await db()
    .from('calls')
    .update({ attempts: call.attempts + 1 })
    .eq('id', call.id)
    .eq('status', call.status)
    .eq('attempts', call.attempts)
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`failed to claim call ${call.id}: ${error.message}`);
  return (data as Call | null) ?? null;
}

async function runStep(call: Call, now: Date, options: RunWorkerOptions): Promise<StepOutcome> {
  try {
    switch (call.status) {
      case 'new': {
        const storage_path = await fetchRecording(call, now);
        await advance(call, 'fetching', { storage_path });
        return 'advanced';
      }
      case 'fetching': {
        const transcript = await transcribeCall(call);
        await advance(call, 'transcribing', { transcript });
        return 'advanced';
      }
      case 'transcribing': {
        const summary = await summarizeCall(call);
        await advance(call, 'summarizing', { summary });
        // Onto the shared timeline as soon as the summary is durable, so the
        // call joins the customer's texts and emails rather than only their
        // Telegram topic. After advance() and not before: a row pointing at a
        // summary that was never stored would be a reading surface that
        // disagrees with the book of record. Stamped with when the CALL
        // happened, not when the worker got to it, which can be several
        // retries later. Swallowed rather than thrown, or a timeline that is
        // down would send this row back round the retry loop and eventually
        // fail a call that was already summarized. See lib/crm/timeline.ts for
        // the ownership exception that lets this repo write crm_timeline.
        try {
          await noteCallSummary({
            phone: call.contact_phone,
            callId: call.id,
            summary,
            occurredAt: call.ended_at ?? call.started_at,
          });
        } catch (err) {
          console.error(`[timeline] call ${call.id} not recorded:`, err);
        }
        return 'advanced';
      }
      case 'summarizing': {
        const callCard = options.callCard ?? (await loadCallCard());
        const payloads = await callCard(call);
        await enqueueOutbox(payloads);
        await advance(call, 'posted', {});
        return 'posted';
      }
      default:
        // 'posted' and 'failed' rows are excluded by selectCandidates, so this is unreachable.
        return 'advanced';
    }
  } catch (err) {
    if (err instanceof RecordingExpiredError) {
      // Aged past the 10-minute presigned URL window: no amount of retrying helps.
      await fail(call, err.message);
      return 'failed';
    }
    const message = err instanceof Error ? err.message : String(err);
    if (call.attempts >= MAX_ATTEMPTS) {
      await fail(call, message);
      return 'failed';
    }
    await recordError(call, message);
    return 'errored';
  }
}

/**
 * Builds the two outbox rows a finished call produces: the recording (audio)
 * and the summary (text).
 *
 * The topic is RESOLVED here, not deferred to the drain. A null thread_id is not
 * "not known yet", it is an instruction to post in the General topic, and an
 * outbox row carries no phone number so the drain cannot turn null into the
 * right thread. A first-time caller has no topic yet, so deferring would put
 * their call card in General, which is the same bug that shipped in sms.ts.
 */
/** Lazy for the same reason as loadCallCard: lib/telegram is a separate module's territory. */
async function loadDrain(): Promise<DrainFn> {
  const { drainOutbox } = await import('../telegram/outbox');
  return drainOutbox;
}

async function loadCallCard(): Promise<CallCardFn> {
  const [{ completedCallCard }, { getContact, resolveTopic }] = await Promise.all([
    import('../telegram/cards'),
    import('../telegram/topics'),
  ]);

  return async (call: Call): Promise<OutboxPayload[]> => {
    if (!call.storage_path) {
      throw new Error(`call ${call.id} has no storage_path; cannot attach the recording to the outbox card`);
    }
    if (!call.summary) {
      throw new Error(`call ${call.id} has no summary; cannot build the completed-call card`);
    }

    const contact = await getContact(call.contact_phone);
    const threadId = await resolveTopic(call.contact_phone);

    const bucket = env('SUPABASE_STORAGE_BUCKET');
    const { data, error } = await db().storage.from(bucket).createSignedUrl(call.storage_path, OUTBOX_AUDIO_URL_TTL_SECONDS);
    if (error || !data) {
      throw new Error(`could not sign the recording for the outbox: ${error?.message ?? 'no data returned'}`);
    }
    const audio: AudioCardPayload = { audio_url: data.signedUrl };

    const text = await completedCallCard({
      callId: call.id,
      contactPhone: call.contact_phone,
      displayName: contact?.display_name ?? null,
      durationSec: call.duration_sec,
      summary: call.summary,
    });

    return [
      { thread_id: threadId, kind: 'audio', payload: audio as unknown as Record<string, unknown> },
      { thread_id: threadId, kind: 'text', payload: text as unknown as Record<string, unknown> },
    ];
  };
}

/** Advancing resets attempts: each pipeline step gets its own retry budget. */
async function advance(call: Call, status: CallStatus, patch: Record<string, unknown>): Promise<void> {
  const { error } = await db()
    .from('calls')
    .update({ ...patch, status, attempts: 0, last_error: null })
    .eq('id', call.id);
  if (error) throw new Error(`failed to advance call ${call.id} to ${status}: ${error.message}`);
}

async function fail(call: Call, message: string): Promise<void> {
  const { error } = await db().from('calls').update({ status: 'failed', last_error: message }).eq('id', call.id);
  if (error) throw new Error(`failed to mark call ${call.id} failed: ${error.message}`);
}

async function recordError(call: Call, message: string): Promise<void> {
  const { error } = await db().from('calls').update({ last_error: message }).eq('id', call.id);
  if (error) throw new Error(`failed to record error on call ${call.id}: ${error.message}`);
}

async function enqueueOutbox(payloads: OutboxPayload[]): Promise<void> {
  if (payloads.length === 0) return;
  const rows = payloads.map((p) => ({ thread_id: p.thread_id, kind: p.kind, payload: p.payload }));
  const { error } = await db().from('outbox').insert(rows);
  if (error) throw new Error(`failed to enqueue outbox rows: ${error.message}`);
}
