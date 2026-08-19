import { db, unwrap } from '../db';
import { callerContext, contextDeps, prewarmCallerContext, warmCallerContextRoute } from '../agent/context';
import { optionalEnv, toE164 } from '../env';
import { openerAudioUrl, openerPlaybackEnabled, openerText } from './opener';
import type { Responder } from '../types';
import {
  decodeClientState,
  encodeClientState,
  telnyx,
  TelnyxError,
  type StartAssistantResult,
  type TelnyxCommands,
} from './client';
import {
  TELNYX_SIGNATURE_HEADER,
  TELNYX_TIMESTAMP_HEADER,
  verifyTelnyxWebhook,
} from './signature';

/**
 * The inbound call state machine.
 *
 * Sequence, and why it is this sequence:
 *
 *   call.initiated   -> answer
 *   call.answered    -> play the OPENER: who is calling, and the two notices
 *   call.playback.ended -> hand the caller to the agent, start a DUAL channel
 *                          recording, or ring the responders if there is no agent
 *   call.speak.ended -> the same thing, for the synthesized fallback opener
 *   call.answered    -> first responder leg to pick up is bridged, the rest are hung up
 *   (no answer)      -> next wave, then voicemail
 *   call.hangup      -> close out the calls row
 *   call.recording.saved -> hand the URL to the worker, download nothing here
 *
 * California is an all-party consent state, so the recording cannot start until
 * the disclosure has finished playing. That single ordering constraint is the
 * reason this uses dial plus bridge instead of transfer: transfer gives no
 * independent handle on the second leg while it rings, so there is no way to
 * guarantee the disclosure completed before the far end is connected.
 *
 * Nothing here may assume a webhook arrives once, or in order. Telnyx retries on
 * any non-2xx and documents no ordering guarantee, so every transition below is a
 * compare-and-set against stored state, and every event is claimed exactly once
 * in telnyx_events before any command is issued.
 *
 * ONE COMMAND BREAKS THAT LAST RULE ON PURPOSE: `ai_assistant_start`, which goes
 * out before the claim, because the claim is a database round trip and the
 * caller is listening to silence through it. It carries a `command_id` instead,
 * which moves the same guarantee to Telnyx. See beginAgentHandoff for the
 * measurements, and for why record_start was NOT given the same treatment.
 */

// --- Webhook shapes ---------------------------------------------------------

export interface TelnyxCallPayload {
  call_control_id: string;
  call_leg_id?: string;
  call_session_id?: string;
  connection_id?: string;
  client_state?: string | null;
  from?: string;
  to?: string;
  direction?: string;
  state?: string;
  hangup_cause?: string;
  hangup_source?: string;
  reason?: string;
  channels?: string;
  recording_urls?: Record<string, string | null> | null;
  public_recording_urls?: Record<string, string | null> | null;
}

export interface TelnyxWebhook {
  data: {
    id: string;
    event_type: string;
    occurred_at: string;
    record_type?: string;
    payload: TelnyxCallPayload;
  };
}

/** Set on our speak commands so call.speak.ended says WHICH speak just ended. */
interface SpeakState {
  speak: 'disclosure' | 'voicemail';
}

/** Set on every responder leg we dial, so its events identify themselves. */
interface ResponderState {
  role: 'responder';
  call_id: string;
  wave: number;
  responder_id: string;
}

// --- Tunables ---------------------------------------------------------------

/** A caller with caller ID blocked still needs a contacts row, and contacts.phone
 *  is the primary key. Area code 000 is unassignable in the NANP, so this can
 *  never collide with a real caller. */
const ANONYMOUS_CALLER = '+10000000000';

/** Bounds a recording that nobody ever ends, e.g. a caller who leaves the line open. */
const RECORDING_MAX_SECONDS = 3600;

const ringWaveSeconds = () => Number(optionalEnv('RING_WAVE_SECONDS', '15'));

const voicemailPrompt = () =>
  optionalEnv(
    'VOICEMAIL_PROMPT',
    'Sorry, nobody is available right now. Please leave a message after the tone and we will call you back.',
  );

// --- Stage 1: authenticate and parse, on the request path -------------------

export type WebhookOutcome =
  | { ok: true; event: TelnyxWebhook }
  | { ok: false; status: number; reason: string };

/**
 * Runs BEFORE the 200 goes out, so it does no I/O. Telnyx's webhook timeout is 2
 * seconds and any non-2xx (3xx included) triggers a retry, so the only work on
 * the request path is a signature check and a JSON parse.
 */
export function receiveTelnyxWebhook(
  rawBody: string,
  headers: Headers,
  now: number = Date.now(),
): WebhookOutcome {
  const verified = verifyTelnyxWebhook(
    rawBody,
    headers.get(TELNYX_SIGNATURE_HEADER),
    headers.get(TELNYX_TIMESTAMP_HEADER),
    now,
  );
  if (!verified.ok) return { ok: false, status: 403, reason: verified.reason ?? 'unverified' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, reason: 'body is not JSON' };
  }

  const data = (parsed as TelnyxWebhook | null)?.data;
  if (!data?.id || !data.event_type || !data.occurred_at) {
    return { ok: false, status: 400, reason: 'missing data.id, data.event_type or data.occurred_at' };
  }

  return { ok: true, event: { data } };
}

// --- Persistence ------------------------------------------------------------

export interface CallFlow {
  call_control_id: string;
  call_id: string;
  stage: 'initiated' | 'answered' | 'assistant' | 'ringing' | 'bridged' | 'voicemail' | 'ended';
  wave: number | null;
  recording_started: boolean;
  /**
   * When the agent last offered this caller a person. Null means it never did,
   * which is the only reading that is safe to act on: `escalate_to_human` will
   * not dial on the "they accepted" path without a stamp here.
   */
  escalation_offered_at: string | null;
}

export interface CallLeg {
  call_control_id: string;
  call_id: string;
  responder_id: string | null;
  phone: string;
  wave: number;
  status: 'ringing' | 'answered' | 'dead';
}

/**
 * Everything the machine touches in the database, named by intent rather than by
 * table. Keeping it an interface is what makes the flow testable without a
 * database, which matters here because the flow cannot be exercised against
 * Telnyx at all until an account exists.
 */
export interface VoiceStore {
  /** Insert-or-lose. True means this process owns the event, false means duplicate. */
  claimEvent(row: {
    id: string;
    event_type: string;
    call_control_id: string | null;
    occurred_at: string;
  }): Promise<boolean>;
  markEventDone(id: string): Promise<void>;
  /** Drops the claim so the next Telnyx retry can have another go. */
  releaseEvent(id: string, error: string): Promise<void>;

  upsertContact(phone: string): Promise<void>;
  createCall(row: { contact_phone: string; provider_call_id: string; started_at: string }): Promise<string>;
  createFlow(row: { call_control_id: string; call_id: string }): Promise<void>;

  getFlow(callControlId: string): Promise<CallFlow | null>;
  getFlowByCall(callId: string): Promise<CallFlow | null>;
  /** Compare-and-set on stage. Returns the new row, or null if `from` did not match. */
  advanceStage(
    callControlId: string,
    from: CallFlow['stage'][],
    to: CallFlow['stage'],
    patch?: Partial<Pick<CallFlow, 'wave' | 'recording_started'>>,
  ): Promise<CallFlow | null>;
  /** Compare-and-set on wave, so two simultaneous leg deaths cannot both advance. */
  advanceWave(callControlId: string, from: number, to: number): Promise<boolean>;
  markRecordingStarted(callControlId: string): Promise<void>;
  /** Records the Telnyx conversation the agent is running on this call. */
  markConversationStarted(callControlId: string, conversationId: string): Promise<void>;
  /** The call the agent is currently holding for this caller, newest first. */
  activeAssistantCall(callerPhone: string): Promise<CallFlow | null>;
  /**
   * Stamps that the caller was offered a person. Deliberately NOT a stage move:
   * an offer changes nothing about the call, it only starts the clock that
   * `escalate_to_human` checks before it is allowed to dial.
   */
  recordEscalationOffer(callControlId: string): Promise<void>;

  activeResponders(): Promise<Responder[]>;
  addLeg(leg: Omit<CallLeg, 'status'>): Promise<void>;
  getLeg(callControlId: string): Promise<CallLeg | null>;
  /** Atomic winner election. 'lost' covers both losing the race and arriving late. */
  electWinner(callControlId: string): Promise<'won' | 'lost'>;
  ringingLegs(callId: string, wave?: number): Promise<CallLeg[]>;
  answeredLeg(callId: string): Promise<CallLeg | null>;
  markLegDead(callControlId: string): Promise<void>;
  /** Marks every still-ringing leg dead and returns them, so the caller can hang them up. */
  killRingingLegs(callId: string): Promise<CallLeg[]>;

  markCallAnswered(callId: string, answeredAt: string): Promise<void>;
  /**
   * `wasAnswered` here means "the stage this call ended in counts as answered".
   * Implementations MUST NOT use it to clear a call already marked answered by
   * markCallAnswered: an agent that handled a caller and then escalated into a
   * ring group nobody picked up still answered the call.
   */
  finishCall(args: {
    callId: string;
    endedAt: string;
    wasAnswered: boolean;
    recordingStarted: boolean;
  }): Promise<void>;
  saveRecording(callId: string, url: string): Promise<void>;
  failCall(callId: string, error: string): Promise<void>;
}

export function supabaseStore(): VoiceStore {
  return {
    async claimEvent(row) {
      const res = await db().from('telnyx_events').upsert(row, { onConflict: 'id', ignoreDuplicates: true }).select('id');
      if (res.error) throw new Error(`claimEvent: ${res.error.message}`);
      return (res.data?.length ?? 0) > 0;
    },

    async markEventDone(id) {
      await db().from('telnyx_events').update({ processed_at: new Date().toISOString() }).eq('id', id);
    },

    async releaseEvent(id, error) {
      // Deleted rather than flagged: a retry has to be able to re-claim it, and a
      // row left behind would make the retry a silent no-op on a call that is
      // still up and waiting for a command.
      await db().from('telnyx_events').delete().eq('id', id);
      console.error(`[voice] released event ${id} for retry: ${error}`);
    },

    async upsertContact(phone) {
      const ins = await db().from('contacts').upsert({ phone }, { onConflict: 'phone', ignoreDuplicates: true });
      if (ins.error) throw new Error(`upsertContact: ${ins.error.message}`);

      const current = await db().from('contacts').select('customer_id').eq('phone', phone).maybeSingle();
      if (current.error) throw new Error(`upsertContact read: ${current.error.message}`);
      if (current.data?.customer_id) return;

      const customerId = await matchAkmeCustomer(phone);
      if (!customerId) return;
      // `is('customer_id', null)` so a link a human made by hand is never overwritten.
      await db().from('contacts').update({ customer_id: customerId }).eq('phone', phone).is('customer_id', null);
    },

    async createCall(row) {
      const ins = await db()
        .from('calls')
        .upsert({ ...row, direction: 'inbound' }, { onConflict: 'provider_call_id', ignoreDuplicates: true })
        .select('id');
      if (ins.error) throw new Error(`createCall: ${ins.error.message}`);
      if (ins.data?.length) return ins.data[0].id as string;

      const existing = await db().from('calls').select('id').eq('provider_call_id', row.provider_call_id).single();
      return (unwrap(existing, 'createCall reread') as { id: string }).id;
    },

    async createFlow(row) {
      const res = await db().from('call_flow').upsert(row, { onConflict: 'call_control_id', ignoreDuplicates: true });
      if (res.error) throw new Error(`createFlow: ${res.error.message}`);
    },

    async getFlow(callControlId) {
      const res = await db().from('call_flow').select('*').eq('call_control_id', callControlId).maybeSingle();
      if (res.error) throw new Error(`getFlow: ${res.error.message}`);
      return (res.data as CallFlow) ?? null;
    },

    async getFlowByCall(callId) {
      const res = await db().from('call_flow').select('*').eq('call_id', callId).maybeSingle();
      if (res.error) throw new Error(`getFlowByCall: ${res.error.message}`);
      return (res.data as CallFlow) ?? null;
    },

    async advanceStage(callControlId, from, to, patch) {
      const res = await db()
        .from('call_flow')
        .update({ stage: to, ...patch })
        .eq('call_control_id', callControlId)
        .in('stage', from)
        .select('*')
        .maybeSingle();
      if (res.error) throw new Error(`advanceStage: ${res.error.message}`);
      return (res.data as CallFlow) ?? null;
    },

    async advanceWave(callControlId, from, to) {
      const res = await db()
        .from('call_flow')
        .update({ wave: to })
        .eq('call_control_id', callControlId)
        .eq('stage', 'ringing')
        .eq('wave', from)
        .select('call_control_id');
      if (res.error) throw new Error(`advanceWave: ${res.error.message}`);
      return (res.data?.length ?? 0) > 0;
    },

    async markRecordingStarted(callControlId) {
      await db().from('call_flow').update({ recording_started: true }).eq('call_control_id', callControlId);
    },

    async markConversationStarted(callControlId, conversationId) {
      await db()
        .from('call_flow')
        .update({ telnyx_conversation_id: conversationId })
        .eq('call_control_id', callControlId);
    },

    /**
     * A webhook tool call carries no call identity, only the caller's number, so
     * this is how a tool finds the call it is acting on. Scoped to the assistant
     * stage: a call that already escalated is being handled by a person, and a
     * retried tool call must not reach back into it.
     */
    async activeAssistantCall(callerPhone) {
      const res = await db()
        .from('call_flow')
        .select('*, calls!inner(contact_phone)')
        .eq('stage', 'assistant')
        .eq('calls.contact_phone', callerPhone)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (res.error) throw new Error(`activeAssistantCall: ${res.error.message}`);
      return (res.data as CallFlow) ?? null;
    },

    /**
     * Last write wins on purpose. A second offer in the same call restarts the
     * clock, which is right: the caller is being asked again, so the answer we
     * are waiting for is the new one.
     */
    async recordEscalationOffer(callControlId) {
      const res = await db()
        .from('call_flow')
        .update({ escalation_offered_at: new Date().toISOString() })
        .eq('call_control_id', callControlId);
      if (res.error) throw new Error(`recordEscalationOffer: ${res.error.message}`);
    },

    async activeResponders() {
      const res = await db().from('responders').select('*').eq('active', true).order('ring_order').order('id');
      if (res.error) throw new Error(`activeResponders: ${res.error.message}`);
      return (res.data ?? []) as Responder[];
    },

    async addLeg(leg) {
      const res = await db().from('call_legs').upsert(leg, { onConflict: 'call_control_id', ignoreDuplicates: true });
      if (res.error) throw new Error(`addLeg: ${res.error.message}`);
    },

    async getLeg(callControlId) {
      const res = await db().from('call_legs').select('*').eq('call_control_id', callControlId).maybeSingle();
      if (res.error) throw new Error(`getLeg: ${res.error.message}`);
      return (res.data as CallLeg) ?? null;
    },

    async electWinner(callControlId) {
      const res = await db()
        .from('call_legs')
        .update({ status: 'answered' })
        .eq('call_control_id', callControlId)
        .eq('status', 'ringing')
        .select('call_control_id');
      // 23505 is the one-winner partial unique index firing: another leg in this
      // wave answered first. Every other error is a real failure.
      if (res.error) {
        if (res.error.code === '23505') return 'lost';
        throw new Error(`electWinner: ${res.error.message}`);
      }
      return (res.data?.length ?? 0) > 0 ? 'won' : 'lost';
    },

    async ringingLegs(callId, wave) {
      let q = db().from('call_legs').select('*').eq('call_id', callId).eq('status', 'ringing');
      if (wave !== undefined) q = q.eq('wave', wave);
      const res = await q;
      if (res.error) throw new Error(`ringingLegs: ${res.error.message}`);
      return (res.data ?? []) as CallLeg[];
    },

    async answeredLeg(callId) {
      const res = await db().from('call_legs').select('*').eq('call_id', callId).eq('status', 'answered').maybeSingle();
      if (res.error) throw new Error(`answeredLeg: ${res.error.message}`);
      return (res.data as CallLeg) ?? null;
    },

    async markLegDead(callControlId) {
      await db().from('call_legs').update({ status: 'dead' }).eq('call_control_id', callControlId);
    },

    async killRingingLegs(callId) {
      const res = await db()
        .from('call_legs')
        .update({ status: 'dead' })
        .eq('call_id', callId)
        .eq('status', 'ringing')
        .select('*');
      if (res.error) throw new Error(`killRingingLegs: ${res.error.message}`);
      return (res.data ?? []) as CallLeg[];
    },

    async markCallAnswered(callId, answeredAt) {
      await db()
        .from('calls')
        .update({ answered_at: answeredAt, was_answered: true })
        .eq('id', callId)
        .is('answered_at', null);
    },

    async finishCall({ callId, endedAt, wasAnswered, recordingStarted }) {
      const row = await db().from('calls').select('started_at, ended_at, was_answered').eq('id', callId).maybeSingle();
      if (row.error) throw new Error(`finishCall read: ${row.error.message}`);
      if (!row.data || row.data.ended_at) return; // already closed by an earlier delivery

      const started = Date.parse(row.data.started_at as string);
      const ended = Date.parse(endedAt);
      const duration = Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, Math.round((ended - started) / 1000))
        : null;

      await db()
        .from('calls')
        .update({
          ended_at: endedAt,
          duration_sec: duration,
          // Never downgrades. markCallAnswered is only ever called by a responder
          // bridging or by the agent taking the call, and both of those are the
          // flag's whole meaning, so a later stage cannot take it back.
          was_answered: wasAnswered || row.data.was_answered === true,
        })
        .eq('id', callId)
        .is('ended_at', null);

      if (!recordingStarted) {
        // The caller hung up during the disclosure, so no recording exists and none
        // is coming. Left at 'new' this row would sit in the worker's pending index
        // forever waiting for a recording_url that never arrives.
        await db()
          .from('calls')
          .update({ status: 'failed', last_error: 'call ended before recording started, nothing to transcribe' })
          .eq('id', callId)
          .eq('status', 'new');
      }
    },

    async saveRecording(callId, url) {
      const res = await db()
        .from('calls')
        .update({ recording_url: url, status: 'new' })
        .eq('id', callId)
        .in('status', ['new', 'failed']);
      if (res.error) throw new Error(`saveRecording: ${res.error.message}`);
    },

    async failCall(callId, error) {
      await db().from('calls').update({ status: 'failed', last_error: error }).eq('id', callId);
    },
  };
}

/**
 * Best-effort link from a caller to a Akme customer. READ ONLY: switchboard never
 * writes the customers table.
 *
 * Akme stores phone numbers however they were typed, so this matches against the
 * handful of shapes a US number is written in rather than assuming E.164. On more
 * than one hit it takes the lowest id: customers is multi-tenant on business_id
 * and there is no business_id on an inbound call to disambiguate with, so the
 * choice is deterministic and a human can correct it, rather than random.
 */
async function matchAkmeCustomer(phone: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, '');
  const local = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (local.length !== 10) return null;

  const [a, b, c] = [local.slice(0, 3), local.slice(3, 6), local.slice(6)];
  const candidates = [phone, digits, local, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`, `${a}.${b}.${c}`, `(${a})${b}-${c}`];

  const res = await db().from('customers').select('id').in('phone', candidates).order('id').limit(1);
  if (res.error) throw new Error(`matchAkmeCustomer: ${res.error.message}`);
  return (res.data?.[0]?.id as string) ?? null;
}

// --- Stage 2: the machine, off the request path -----------------------------

export interface VoiceDeps {
  store: VoiceStore;
  commands: TelnyxCommands;
  /** Warms the caller lookup the assistant is about to block on. Injectable for tests. */
  prewarm?: (phone: string) => void;
  /**
   * Boots the context route itself, which is a different Vercel function from
   * this one and therefore never sees the prewarm above. Injectable for tests,
   * which must not make a real request to PUBLIC_BASE_URL.
   */
  warmContextRoute?: () => void;
}

export function voiceDeps(): VoiceDeps {
  return {
    store: supabaseStore(),
    commands: telnyx,
    prewarm: prewarmCallerContext,
    warmContextRoute: warmCallerContextRoute,
  };
}

/**
 * Runs after the 200 has been committed. Claims the event, dispatches it, and
 * releases the claim if anything throws so a Telnyx retry can pick it back up.
 */
export async function processTelnyxEvent(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const { id, event_type, occurred_at, payload } = event.data;

  // THE HANDOFF IS ISSUED BEFORE THE EVENT IS EVEN CLAIMED, and this is the one
  // place in the file where that ordering is worth the asymmetry.
  //
  // MEASURED, from telnyx_events on three real calls: `call.speak.ended` took
  // 3.69s, 3.44s and 0.99s from occurred_at to processed_at, against 0.18-0.97s
  // for every other event on the same calls. The caller's silence after the
  // disclosure is not Telnyx being slow, it is this handler doing Supabase round
  // trips (~0.3-0.5s each from the Vercel region) with the agent handoff queued
  // behind them. claimEvent and the compare-and-set were both in front of it.
  //
  // Safe to hoist because `command_id` moved the idempotency to Telnyx, which
  // ignores a repeat of the same command on the same call. That is what the
  // claim was protecting here; the claim still guards everything below, and the
  // compare-and-set still guards the dial path, which has no such dedupe.
  const agent = beginAgentHandoff(event, deps);

  const mine = await deps.store.claimEvent({
    id,
    event_type,
    call_control_id: payload?.call_control_id ?? null,
    occurred_at,
  });
  if (!mine) return; // already handled, and handling it twice would double-dial

  try {
    await dispatch(event, deps, agent);
    await deps.store.markEventDone(id);
  } catch (err) {
    await deps.store.releaseEvent(id, err instanceof Error ? err.message : String(err));
  }
}

/** Settled, never rejectable: inside `after`, a stray rejection kills the whole event. */
type AgentHandoff = Promise<
  { ok: true; data: StartAssistantResult } | { ok: false; error: unknown }
>;

/**
 * Issues `ai_assistant_start` the moment the disclosure ends, or returns null
 * when this event is not the end of the disclosure.
 *
 * ONLY THE AGENT START IS HOISTED, and `record_start` deliberately is not, even
 * though it sits one round trip further back and the same `command_id` trick
 * would work on it. Being above the claim means a redelivered webhook issues the
 * command a second time, and the only thing standing between that and two
 * parallel recordings of one call is Telnyx honouring `command_id`. This API has
 * already been caught storing fields it ignores and returning 200 for them (see
 * AGENTS.md), and two recordings is the exact bug that the assistant's own
 * recording_settings produced before. So the recording keeps the guard that has
 * been proven on real calls, and pays half a second for it, off the critical
 * path: the agent does not speak until Telnyx has stood up a conversation, which
 * measured at about 1.9s, so the tape still starts first by a wide margin.
 *
 * THE CALLER CONTEXT GOES OUT WITH THE COMMAND rather than being fetched back
 * out of us afterwards. It is normally free by now: `call.answered` prewarmed it
 * while the disclosure was playing, so this is an already-resolved promise. The
 * race covers the case where it is not, e.g. a different Vercel instance picking
 * up this event, where blocking on a cold lookup would put back the silence this
 * is removing. Losing the race yields the same stranger variables the webhook
 * answers with on its own failure path, so it costs one line of recognition.
 */
export const CONTEXT_BUDGET_MS = 400;

function beginAgentHandoff(event: TelnyxWebhook, deps: VoiceDeps): AgentHandoff | null {
  const { event_type, payload: p } = event.data;
  if (event_type !== 'call.speak.ended' && event_type !== 'call.playback.ended') return null;
  if (decodeClientState<SpeakState>(p.client_state)?.speak !== 'disclosure') return null;

  // Unsetting TELNYX_ASSISTANT_ID is the rollback: with no assistant to start,
  // the call reverts to dialing humans by the path it always took.
  const assistantId = process.env.TELNYX_ASSISTANT_ID?.trim();
  if (!assistantId) return null;

  const caller = toE164(p.from ?? '');
  const variables = caller
    ? Promise.race([
        callerContext(caller, contextDeps()).catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), CONTEXT_BUDGET_MS)),
      ])
    : Promise.resolve(null);

  return variables.then((vars) =>
    deps.commands
      .startAssistant(p.call_control_id, {
        assistant: {
          id: assistantId,
          ...(vars ? { dynamic_variables: vars as unknown as Record<string, string> } : {}),
        },
        // Same id for every delivery of this call's handoff, so a Telnyx retry of
        // the disclosure webhook cannot start a second conversation.
        command_id: `agent-${p.call_control_id}`,
      })
      .then(
        (data) => ({ ok: true, data }) as const,
        (error: unknown) => ({ ok: false, error }) as const,
      ),
  );
}

async function dispatch(
  event: TelnyxWebhook,
  deps: VoiceDeps,
  agent: AgentHandoff | null = null,
): Promise<void> {
  switch (event.data.event_type) {
    case 'call.initiated':
      return onInitiated(event, deps);
    case 'call.answered':
      return onAnswered(event, deps);
    // One handler, because the disclosure now arrives by either route: a
    // rendered file ends with call.playback.ended, the synthesized fallback with
    // call.speak.ended. Both carry the same client_state, and what happens next
    // does not depend on which one played.
    case 'call.speak.ended':
    case 'call.playback.ended':
      return onDisclosureEnded(event, deps, agent);
    case 'call.hangup':
      return onHangup(event, deps);
    case 'call.recording.saved':
      return onRecordingSaved(event, deps);
    case 'call.recording.error':
      return onRecordingError(event, deps);
    default:
      return; // logged in telnyx_events, no action
  }
}

async function onInitiated(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  if (responderState(p)) return; // one of our own dialed legs, already recorded

  // Answered BEFORE any of the bookkeeping below, which is the entire point of
  // this ordering. upsertContact alone is three round trips (upsert, read back,
  // match a Akme customer), and with createCall and createFlow behind it that is
  // six sequential Supabase hops from the app server. Every one of them used to run
  // while the caller sat listening to ringing: ~2.8s of the 5.8s measured between
  // dialing and hearing anything. None of it is needed to open the line.
  //
  // The cost is that call.answered now reliably arrives while these writes are
  // still in flight, so onAnswered waits for the row rather than assuming it.
  // That trade is deliberate: the waiting moved to our side of the call.
  await deps.commands.answer(p.call_control_id);

  const from = toE164(p.from ?? '') ?? ANONYMOUS_CALLER;
  await deps.store.upsertContact(from);
  const callId = await deps.store.createCall({
    contact_phone: from,
    provider_call_id: p.call_control_id,
    started_at: event.data.occurred_at,
  });
  await deps.store.createFlow({ call_control_id: p.call_control_id, call_id: callId });
}

/**
 * Advances the flow stage, tolerating a row onInitiated has not written yet.
 *
 * A null from advanceStage means one of two very different things now: the row
 * is in another stage (a duplicate webhook, which Telnyx sends freely and which
 * must stay a no-op), or the row does not exist at all (onInitiated answered the
 * call and is still writing). Only the second is worth waiting on, so the two are
 * told apart by an explicit read rather than by retrying blindly.
 *
 * Bounded well under the write path it is waiting for. If onInitiated failed
 * outright, its event was released for a Telnyx retry and no amount of waiting
 * here would produce the row.
 */
export const FLOW_WAIT_ATTEMPTS = 4;
export const FLOW_WAIT_MS = 250;

async function advanceOnceWritten(
  store: VoiceStore,
  callControlId: string,
  from: CallFlow['stage'][],
  to: CallFlow['stage'],
): Promise<CallFlow | null> {
  for (let attempt = 0; attempt < FLOW_WAIT_ATTEMPTS; attempt++) {
    const flow = await store.advanceStage(callControlId, from, to);
    if (flow) return flow;
    if (await store.getFlow(callControlId)) return null; // exists, wrong stage: a repeat
    await new Promise((resolve) => setTimeout(resolve, FLOW_WAIT_MS));
  }
  return null;
}

async function onAnswered(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const responder = responderState(p);
  if (responder) return onResponderAnswered(event, responder, deps);

  const flow = await advanceOnceWritten(deps.store, p.call_control_id, ['initiated'], 'answered');
  if (!flow) return;

  // Started before the disclosure, not after it. In a few seconds the assistant
  // will hold the caller in silence waiting on /api/agent/context; the disclosure
  // playing right now is several seconds of that wait we can spend in advance.
  // Fire and forget on purpose: nothing below depends on it, and a lookup that
  // fails just means the webhook does its own, exactly as it did before.
  const caller = toE164(p.from ?? '');
  if (caller) (deps.prewarm ?? prewarmCallerContext)(caller);

  // And warm the route that lookup is answered from, which is a separate Vercel
  // function and so has its own cold start sitting in front of the greeting. Same
  // trade as the line above and the same free seconds to spend it in: the
  // disclosure is about to play and nobody is using that time.
  (deps.warmContextRoute ?? warmCallerContextRoute)();

  // Beat 1 of the opener: the introduction AND the two notices, in one breath.
  //
  // PLAYED FROM A FILE, NOT SYNTHESIZED, whenever one has been rendered. The
  // text is identical on every call, and making Telnyx render it fresh each time
  // cost 1.7s and 2.0s of dead air between `call.answered` and
  // `call.speak.started` on the two calls measured on 2026-08-19. See opener.ts
  // for the numbers and for why the file is named after a hash of its own text.
  //
  // The fallback is `speak` with the same words, so a line whose opener has been
  // edited but not re-rendered still says the right thing, just more slowly. It
  // is a real path, not defensive padding: the disclosure is what triggers
  // `record_start` and the agent handoff, so a disclosure that never plays is a
  // call that sits in silence until the caller gives up.
  const clientState = encodeClientState({ speak: 'disclosure' } satisfies SpeakState);
  const audioUrl = openerPlaybackEnabled() ? openerAudioUrl() : null;

  if (audioUrl) {
    try {
      await deps.commands.playbackStart(p.call_control_id, {
        audio_url: audioUrl,
        cache_audio: true,
        client_state: clientState,
      });
      return;
    } catch (err) {
      if (err instanceof TelnyxError && err.isCallGone) throw err;
      console.error(`[voice] opener playback failed, falling back to speak: ${describe(err)}`);
    }
  }

  // The env var stays as an override for a line that needs different wording
  // without a deploy. Changing it changes the fingerprint, so the rendered file
  // stops being addressed and this path takes over on its own.
  await deps.commands.speak(p.call_control_id, {
    payload: openerText(),
    client_state: clientState,
  });
}

async function onResponderAnswered(
  event: TelnyxWebhook,
  responder: ResponderState,
  deps: VoiceDeps,
): Promise<void> {
  const p = event.data.payload;

  // The dial response is written to call_legs by the caller of dial, but this
  // webhook can beat that write. client_state carries everything needed to
  // reconstruct the row, so the race is survivable rather than fatal.
  if (!(await deps.store.getLeg(p.call_control_id))) {
    await deps.store.addLeg({
      call_control_id: p.call_control_id,
      call_id: responder.call_id,
      responder_id: responder.responder_id,
      phone: p.to ?? '',
      wave: responder.wave,
    });
  }

  if ((await deps.store.electWinner(p.call_control_id)) === 'lost') {
    await tryHangup(p.call_control_id, deps);
    return;
  }

  const flow = await deps.store.getFlowByCall(responder.call_id);
  // Only a call still ringing can be bridged. Anything else (the caller gave up,
  // the last wave already timed out into voicemail) means this pickup is too late.
  const bridged = flow && (await deps.store.advanceStage(flow.call_control_id, ['ringing'], 'bridged'));
  if (!flow || !bridged) {
    await tryHangup(p.call_control_id, deps);
    return;
  }

  await deps.commands.bridge(flow.call_control_id, p.call_control_id);
  await deps.store.markCallAnswered(responder.call_id, event.data.occurred_at);

  for (const leg of await deps.store.killRingingLegs(responder.call_id)) {
    await tryHangup(leg.call_control_id, deps);
  }
}

async function onDisclosureEnded(
  event: TelnyxWebhook,
  deps: VoiceDeps,
  agent: AgentHandoff | null,
): Promise<void> {
  const p = event.data.payload;
  const state = decodeClientState<SpeakState>(p.client_state);
  // The voicemail prompt also ends here. Nothing follows it: the dual channel
  // recording started back at the disclosure is already capturing the message.
  if (state?.speak !== 'disclosure') return;

  // Unsetting TELNYX_ASSISTANT_ID is the rollback: with no assistant to start,
  // this reverts to dialing humans by the path it always took.
  const assistantId = process.env.TELNYX_ASSISTANT_ID?.trim();

  // LAZY, AND ON THE ASSISTANT PATH IT NEVER RUNS AT ALL. This was an awaited
  // read at the top of the function, so a whole Supabase round trip sat between
  // the disclosure ending and ai_assistant_start being sent, on every call, for
  // a list only the human-dialing path reads. Karim, 2026-08-18: "after the
  // disclaimer I want the agent to immediately say how can I help you, and not
  // wait like 7 seconds." This is the one round trip of that which was ours.
  //
  // Memoized rather than re-queried, because the fallback path below reads it
  // twice. Every caller awaits it in the same expression that creates it, so
  // there is no window in which a rejection has no handler attached, which
  // inside `after` would kill the whole event rather than this one read.
  //
  // Ordered by ring_order, so the first row is the first wave.
  let responderRead: Promise<Responder[]> | null = null;
  const activeResponders = () => (responderRead ??= deps.store.activeResponders());

  // The compare-and-set no longer guards the two Telnyx commands, which now
  // carry their own `command_id` and went out before this function was reached.
  // What it still guards is the DIAL path, which has no such dedupe, and the
  // bookkeeping below: a redelivered disclosure must not ring everybody twice.
  let flow: CallFlow | null;
  if (assistantId) {
    flow = await deps.store.advanceStage(p.call_control_id, ['answered'], 'assistant');
  } else {
    const first = (await activeResponders())[0];
    flow = await deps.store.advanceStage(p.call_control_id, ['answered'], 'ringing', {
      wave: first?.ring_order ?? null,
    });
  }
  if (!flow) return;

  // The agent handoff already went out, before this event was even claimed. See
  // beginAgentHandoff for the measurements that moved it. record_start stays
  // here, behind the compare-and-set, because a duplicate recording is a worse
  // failure than half a second: the note over there explains the split.
  //
  // Disclosure is done, so consent is on the recording from its first frame.
  // Dual channel puts each party on its own track, which is what lets the
  // transcript be attributed without diarization.
  //
  // Settled into a result rather than left rejectable: a rejection with no
  // handler attached during the await below is an unhandled rejection, and this
  // runs inside `after`, where that kills the whole event rather than the one
  // command.
  const recording = deps.commands
    .recordStart(p.call_control_id, {
      channels: 'dual',
      format: 'mp3',
      max_length: RECORDING_MAX_SECONDS,
    })
    .then(
      () => ({ ok: true }) as const,
      (error: unknown) => ({ ok: false, error }) as const,
    );

  const recorded = await recording;
  if (recorded.ok) {
    await deps.store.markRecordingStarted(p.call_control_id);
  } else {
    // A call that rings without a recording still connects the customer. A throw
    // here would strand them instead, so this is logged and the flow continues.
    console.error(`[voice] record_start failed for ${p.call_control_id}: ${describe(recorded.error)}`);
  }

  if (agent) {
    const started = await agent;
    if (started.ok) {
      if (started.data?.conversation_id) {
        await deps.store.markConversationStarted(p.call_control_id, started.data.conversation_id);
      }
      // The agent has the caller. That is a call somebody answered, and without
      // this every agent-handled call closed out reading as unanswered, because
      // was_answered was only ever set by a responder bridging.
      await deps.store.markCallAnswered(flow.call_id, event.data.occurred_at);
      return;
    }

    // A caller who reaches a dead agent must reach a human. Falling through to
    // the ring group is strictly better than a silent open line, and this is
    // the only path by which the old behaviour still runs on a normal call.
    console.error(`[voice] ai_assistant_start failed for ${p.call_control_id}: ${describe(started.error)}`);
    const fellBack = await deps.store.advanceStage(p.call_control_id, ['assistant'], 'ringing', {
      wave: (await activeResponders())[0]?.ring_order ?? null,
    });
    if (!fellBack) return;
    flow = fellBack;
  }

  const responders = await activeResponders();
  const first = responders[0];
  if (!first) {
    await toVoicemail(flow, deps);
    return;
  }
  await startWave(flow, first.ring_order, responders, deps);
}

/**
 * Dials every responder in a wave at once. Rows sharing a ring_order are one wave,
 * so this is where simulring happens; the cascade to the next wave is driven by
 * the dial timeout, in advanceAfterLegDeath.
 */
export async function startWave(
  flow: CallFlow,
  wave: number,
  responders: Responder[],
  deps: VoiceDeps,
): Promise<void> {
  const members = responders.filter((r) => r.ring_order === wave);

  const results = await Promise.allSettled(
    members.map(async (r) => {
      // timeout_secs is what turns "nobody picked up" into a call.hangup we can
      // act on. Without it there is no timer in a webhook handler to wait on.
      const leg = await deps.commands.dial({
        to: r.phone,
        timeout_secs: ringWaveSeconds(),
        client_state: encodeClientState({
          role: 'responder',
          call_id: flow.call_id,
          wave,
          responder_id: r.id,
        } satisfies ResponderState),
      });
      await deps.store.addLeg({
        call_control_id: leg.call_control_id,
        call_id: flow.call_id,
        responder_id: r.id,
        phone: r.phone,
        wave,
      });
    }),
  );

  for (const r of results) {
    if (r.status === 'rejected') console.error(`[voice] dial failed in wave ${wave}: ${describe(r.reason)}`);
  }

  if (results.some((r) => r.status === 'fulfilled')) return;
  // Nobody in this wave could even be rung. Fall through as though they all
  // declined rather than dropping the caller here.
  await advanceFromWave(flow, wave, responders, deps);
}

/** A responder leg died. If it was the last one ringing in its wave, move on. */
async function advanceAfterLegDeath(callId: string, wave: number, deps: VoiceDeps): Promise<void> {
  if ((await deps.store.ringingLegs(callId, wave)).length > 0) return;

  const flow = await deps.store.getFlowByCall(callId);
  if (!flow || flow.stage !== 'ringing') return;

  await advanceFromWave(flow, wave, await deps.store.activeResponders(), deps);
}

async function advanceFromWave(
  flow: CallFlow,
  wave: number,
  responders: Responder[],
  deps: VoiceDeps,
): Promise<void> {
  const next = responders.map((r) => r.ring_order).filter((o) => o > wave).sort((a, b) => a - b)[0];
  if (next === undefined) {
    await toVoicemail(flow, deps);
    return;
  }
  // Two legs in the same wave can die in the same instant and both get here. The
  // compare-and-set is what stops the next wave being dialed twice.
  if (!(await deps.store.advanceWave(flow.call_control_id, wave, next))) return;
  await startWave(flow, next, responders, deps);
}

async function toVoicemail(flow: CallFlow, deps: VoiceDeps): Promise<void> {
  const moved = await deps.store.advanceStage(flow.call_control_id, ['ringing'], 'voicemail');
  if (!moved) return;

  await deps.commands.speak(flow.call_control_id, {
    payload: voicemailPrompt(),
    client_state: encodeClientState({ speak: 'voicemail' } satisfies SpeakState),
  });
  // No second record_start: the recording from the disclosure step is still
  // running and captures the message on the caller's channel. A second one would
  // produce two overlapping recordings of the same leg. The call ends when the
  // caller hangs up, bounded by RECORDING_MAX_SECONDS on the recording itself.
}

async function onHangup(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const responder = responderState(p);
  if (!responder) return onInboundHangup(event, deps);

  const leg = await deps.store.getLeg(p.call_control_id);
  await deps.store.markLegDead(p.call_control_id);

  const flow = await deps.store.getFlowByCall(responder.call_id);
  if (leg?.status === 'answered' || flow?.stage === 'bridged') {
    // Bridging does not tear down the far side, so the caller would be left
    // holding an open line after the responder hangs up.
    if (flow) await tryHangup(flow.call_control_id, deps);
    return;
  }

  await advanceAfterLegDeath(responder.call_id, leg?.wave ?? responder.wave, deps);
}

async function onInboundHangup(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const flow = await deps.store.getFlow(p.call_control_id);
  if (!flow) return;

  // The caller gave up. Anything still ringing on their behalf has to stop, or a
  // responder answers a call with nobody on it.
  for (const leg of await deps.store.killRingingLegs(flow.call_id)) {
    await tryHangup(leg.call_control_id, deps);
  }
  const answered = await deps.store.answeredLeg(flow.call_id);
  if (answered) await tryHangup(answered.call_control_id, deps);

  await deps.store.advanceStage(
    p.call_control_id,
    ['initiated', 'answered', 'ringing', 'bridged', 'voicemail'],
    'ended',
  );
  await deps.store.finishCall({
    callId: flow.call_id,
    // occurred_at, never now(): Telnyx does not guarantee ordering and a retry can
    // land minutes late, which would inflate the duration by the retry delay.
    endedAt: event.data.occurred_at,
    wasAnswered: flow.stage === 'bridged',
    recordingStarted: flow.recording_started,
  });
}

async function onRecordingSaved(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const flow = await deps.store.getFlow(p.call_control_id);
  if (!flow) return;

  const url = p.recording_urls?.mp3 ?? p.recording_urls?.wav ?? p.public_recording_urls?.mp3 ?? null;
  if (!url) {
    await deps.store.failCall(flow.call_id, 'call.recording.saved carried no recording url');
    return;
  }

  // Stored, not downloaded. The presigned URL is good for 10 minutes, and pulling
  // a multi-megabyte file here would blow the 2 second webhook budget; the worker
  // fetches it on the next sweep. status 'new' is what puts it in that queue.
  await deps.store.saveRecording(flow.call_id, url);
}

async function onRecordingError(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const flow = await deps.store.getFlow(p.call_control_id);
  if (!flow) return;
  await deps.store.failCall(flow.call_id, `recording failed: ${p.reason ?? 'unknown reason'}`);
}

// --- Helpers ----------------------------------------------------------------

function responderState(p: TelnyxCallPayload): ResponderState | null {
  const state = decodeClientState<ResponderState>(p.client_state);
  return state?.role === 'responder' ? state : null;
}

/** Hangups are best effort: the leg is usually already gone, which is the goal. */
async function tryHangup(callControlId: string, deps: VoiceDeps): Promise<void> {
  try {
    await deps.commands.hangup(callControlId);
  } catch (err) {
    if (err instanceof TelnyxError && err.isCallGone) return;
    console.error(`[voice] hangup failed for ${callControlId}: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
