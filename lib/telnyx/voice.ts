import { db, unwrap } from '../db';
import { env, optionalEnv, toE164 } from '../env';
import type { Responder } from '../types';
import {
  decodeClientState,
  encodeClientState,
  telnyx,
  TelnyxError,
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
 *   call.answered    -> speak the recording disclosure
 *   call.speak.ended -> start a DUAL channel recording, then ring the responders
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
      const row = await db().from('calls').select('started_at, ended_at').eq('id', callId).maybeSingle();
      if (row.error) throw new Error(`finishCall read: ${row.error.message}`);
      if (!row.data || row.data.ended_at) return; // already closed by an earlier delivery

      const started = Date.parse(row.data.started_at as string);
      const ended = Date.parse(endedAt);
      const duration = Number.isFinite(started) && Number.isFinite(ended)
        ? Math.max(0, Math.round((ended - started) / 1000))
        : null;

      await db()
        .from('calls')
        .update({ ended_at: endedAt, duration_sec: duration, was_answered: wasAnswered })
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
}

export function voiceDeps(): VoiceDeps {
  return { store: supabaseStore(), commands: telnyx };
}

/**
 * Runs after the 200 has been committed. Claims the event, dispatches it, and
 * releases the claim if anything throws so a Telnyx retry can pick it back up.
 */
export async function processTelnyxEvent(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const { id, event_type, occurred_at, payload } = event.data;

  const mine = await deps.store.claimEvent({
    id,
    event_type,
    call_control_id: payload?.call_control_id ?? null,
    occurred_at,
  });
  if (!mine) return; // already handled, and handling it twice would double-dial

  try {
    await dispatch(event, deps);
    await deps.store.markEventDone(id);
  } catch (err) {
    await deps.store.releaseEvent(id, err instanceof Error ? err.message : String(err));
  }
}

async function dispatch(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  switch (event.data.event_type) {
    case 'call.initiated':
      return onInitiated(event, deps);
    case 'call.answered':
      return onAnswered(event, deps);
    case 'call.speak.ended':
      return onSpeakEnded(event, deps);
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

  const from = toE164(p.from ?? '') ?? ANONYMOUS_CALLER;
  await deps.store.upsertContact(from);
  const callId = await deps.store.createCall({
    contact_phone: from,
    provider_call_id: p.call_control_id,
    started_at: event.data.occurred_at,
  });
  await deps.store.createFlow({ call_control_id: p.call_control_id, call_id: callId });
  await deps.commands.answer(p.call_control_id);
}

async function onAnswered(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const responder = responderState(p);
  if (responder) return onResponderAnswered(event, responder, deps);

  const flow = await deps.store.advanceStage(p.call_control_id, ['initiated'], 'answered');
  if (!flow) return;

  await deps.commands.speak(p.call_control_id, {
    payload: env('RECORDING_DISCLOSURE'),
    client_state: encodeClientState({ speak: 'disclosure' } satisfies SpeakState),
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

async function onSpeakEnded(event: TelnyxWebhook, deps: VoiceDeps): Promise<void> {
  const p = event.data.payload;
  const state = decodeClientState<SpeakState>(p.client_state);
  // The voicemail prompt also ends here. Nothing follows it: the dual channel
  // recording started back at the disclosure is already capturing the message.
  if (state?.speak !== 'disclosure') return;

  // Ordered by ring_order, so the first row is the first wave.
  const responders = await deps.store.activeResponders();
  const first = responders[0];

  // Unsetting TELNYX_ASSISTANT_ID is the rollback: with no assistant to start,
  // this reverts to dialing humans by the path it always took.
  const assistantId = process.env.TELNYX_ASSISTANT_ID?.trim();

  // The compare-and-set comes before any command: a redelivered speak.ended must
  // not start a second recording, a second agent, or dial everybody twice.
  let flow = assistantId
    ? await deps.store.advanceStage(p.call_control_id, ['answered'], 'assistant')
    : await deps.store.advanceStage(p.call_control_id, ['answered'], 'ringing', {
        wave: first?.ring_order ?? null,
      });
  if (!flow) return;

  // Disclosure is done, so consent is on the recording from its first frame.
  // Dual channel puts each party on its own track, which is what lets the
  // transcript be attributed without diarization. This runs before the agent
  // starts, or the agent's first sentence is missing from the transcript the
  // Telegram card is built from.
  try {
    await deps.commands.recordStart(p.call_control_id, {
      channels: 'dual',
      format: 'mp3',
      max_length: RECORDING_MAX_SECONDS,
    });
    await deps.store.markRecordingStarted(p.call_control_id);
  } catch (err) {
    // A call that rings without a recording still connects the customer. A throw
    // here would strand them instead, so this is logged and the flow continues.
    console.error(`[voice] record_start failed for ${p.call_control_id}: ${describe(err)}`);
  }

  if (assistantId) {
    try {
      const started = await deps.commands.startAssistant(p.call_control_id, {
        assistant: { id: assistantId },
      });
      if (started?.conversation_id) {
        await deps.store.markConversationStarted(p.call_control_id, started.conversation_id);
      }
      return;
    } catch (err) {
      // A caller who reaches a dead agent must reach a human. Falling through to
      // the ring group is strictly better than a silent open line, and this is
      // the only path by which the old behaviour still runs on a normal call.
      console.error(`[voice] ai_assistant_start failed for ${p.call_control_id}: ${describe(err)}`);
      const fellBack = await deps.store.advanceStage(p.call_control_id, ['assistant'], 'ringing', {
        wave: first?.ring_order ?? null,
      });
      if (!fellBack) return;
      flow = fellBack;
    }
  }

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
async function startWave(
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
