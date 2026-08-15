import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { decodeClientState, telnyx } from '../lib/telnyx/client';
import { agentVoice, assistantConfig, voiceSpeed } from '../lib/telnyx/assistant';
import type {
  DialParams,
  RecordStartParams,
  SpeakParams,
  StartAssistantParams,
  TelnyxCommands,
} from '../lib/telnyx/client';
import {
  FLOW_WAIT_ATTEMPTS,
  FLOW_WAIT_MS,
  processTelnyxEvent,
  receiveTelnyxWebhook,
  type CallFlow,
  type CallLeg,
  type TelnyxCallPayload,
  type TelnyxWebhook,
  type VoiceStore,
} from '../lib/telnyx/voice';
import type { Responder } from '../lib/types';

/**
 * There is no Telnyx account yet, so nothing here talks to Telnyx. The payload
 * shapes are the documented ones from the Call Control v2 callback reference, and
 * the flow is driven through the same VoiceStore and command interfaces the route
 * handler wires to Supabase and the REST API in production.
 */

// --- Signing (stands in for Telnyx's private key) ---------------------------

let privateKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;

  // signature.ts strips the 12-byte SPKI prefix, so the raw 32-byte key is what
  // the portal shows and what it expects here.
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' });
  process.env.TELNYX_PUBLIC_KEY = spki.subarray(spki.length - 32).toString('base64');
  process.env.RECORDING_DISCLOSURE = 'This call is being recorded.';
  process.env.RING_WAVE_SECONDS = '15';
});

function signBody(rawBody: string, timestampSeconds: number): Headers {
  const signature = sign(null, Buffer.from(`${timestampSeconds}|${rawBody}`, 'utf8'), privateKey);
  return new Headers({
    'telnyx-signature-ed25519': signature.toString('base64'),
    'telnyx-timestamp': String(timestampSeconds),
  });
}

// --- Synthetic webhooks -----------------------------------------------------

let eventSeq = 0;

function webhook(
  eventType: string,
  payload: Partial<TelnyxCallPayload>,
  opts: { id?: string; occurredAt?: string } = {},
): TelnyxWebhook {
  return {
    data: {
      id: opts.id ?? `evt-${++eventSeq}`,
      event_type: eventType,
      occurred_at: opts.occurredAt ?? '2026-07-27T18:00:00.000Z',
      record_type: 'event',
      payload: { call_control_id: 'leg-a', ...payload },
    },
  };
}

// --- Fake Telnyx command surface -------------------------------------------

interface Issued {
  cmd: string;
  id?: string;
  params?: unknown;
}

function fakeCommands(failing: Partial<Record<string, boolean>> = {}) {
  const issued: Issued[] = [];
  let dialSeq = 0;

  const commands: TelnyxCommands = {
    answer: async (id: string) => {
      issued.push({ cmd: 'answer', id });
      return { result: 'ok' };
    },
    speak: async (id: string, params: SpeakParams) => {
      issued.push({ cmd: 'speak', id, params });
      return { result: 'ok' };
    },
    recordStart: async (id: string, params: RecordStartParams) => {
      issued.push({ cmd: 'recordStart', id, params });
      if (failing.recordStart) throw new Error('record_start refused');
      return { result: 'ok' };
    },
    dial: async (params: DialParams) => {
      const id = `leg-b${++dialSeq}`;
      issued.push({ cmd: 'dial', id, params });
      return { call_control_id: id, call_leg_id: id, call_session_id: 'sess-1' };
    },
    startAssistant: async (id: string, params: StartAssistantParams) => {
      issued.push({ cmd: 'startAssistant', id, params });
      if (failing.startAssistant) throw new Error('assistant unavailable');
      return { conversation_id: 'conv-1' };
    },
    bridge: async (id: string, bridgeWith: string) => {
      issued.push({ cmd: 'bridge', id, params: bridgeWith });
      return { result: 'ok' };
    },
    hangup: async (id: string) => {
      issued.push({ cmd: 'hangup', id });
      return { result: 'ok' };
    },
  };

  return {
    commands,
    issued,
    of: (cmd: string) => issued.filter((i) => i.cmd === cmd),
  };
}

// --- In-memory VoiceStore ---------------------------------------------------

interface FakeCall {
  id: string;
  contact_phone: string;
  provider_call_id: string;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_sec: number | null;
  was_answered: boolean;
  recording_url: string | null;
  status: string;
  last_error: string | null;
}

class FakeStore implements VoiceStore {
  readonly events = new Map<string, { processed: boolean }>();
  readonly contacts = new Set<string>();
  readonly calls = new Map<string, FakeCall>();
  readonly flows = new Map<string, CallFlow>();
  readonly legs = new Map<string, CallLeg>();
  responders: Responder[] = [];
  released: string[] = [];
  private callSeq = 0;

  async claimEvent(row: { id: string }) {
    if (this.events.has(row.id)) return false;
    this.events.set(row.id, { processed: false });
    return true;
  }

  async markEventDone(id: string) {
    const e = this.events.get(id);
    if (e) e.processed = true;
  }

  async releaseEvent(id: string, error: string) {
    this.events.delete(id);
    this.released.push(`${id}: ${error}`);
  }

  async upsertContact(phone: string) {
    this.contacts.add(phone);
  }

  async createCall(row: { contact_phone: string; provider_call_id: string; started_at: string }) {
    for (const c of this.calls.values()) if (c.provider_call_id === row.provider_call_id) return c.id;
    const id = `call-${++this.callSeq}`;
    this.calls.set(id, {
      id,
      ...row,
      answered_at: null,
      ended_at: null,
      duration_sec: null,
      was_answered: false,
      recording_url: null,
      status: 'new',
      last_error: null,
    });
    return id;
  }

  async createFlow(row: { call_control_id: string; call_id: string }) {
    if (this.flows.has(row.call_control_id)) return;
    this.flows.set(row.call_control_id, {
      ...row,
      stage: 'initiated',
      wave: null,
      recording_started: false,
      escalation_offered_at: null,
    });
  }

  async getFlow(callControlId: string) {
    const f = this.flows.get(callControlId);
    return f ? { ...f } : null;
  }

  async getFlowByCall(callId: string) {
    for (const f of this.flows.values()) if (f.call_id === callId) return { ...f };
    return null;
  }

  async advanceStage(
    callControlId: string,
    from: CallFlow['stage'][],
    to: CallFlow['stage'],
    patch?: Partial<Pick<CallFlow, 'wave' | 'recording_started'>>,
  ) {
    const f = this.flows.get(callControlId);
    if (!f || !from.includes(f.stage)) return null;
    Object.assign(f, { stage: to }, patch ?? {});
    return { ...f };
  }

  async advanceWave(callControlId: string, from: number, to: number) {
    const f = this.flows.get(callControlId);
    if (!f || f.stage !== 'ringing' || f.wave !== from) return false;
    f.wave = to;
    return true;
  }

  async markRecordingStarted(callControlId: string) {
    const f = this.flows.get(callControlId);
    if (f) f.recording_started = true;
  }

  conversations = new Map<string, string>();

  async markConversationStarted(callControlId: string, conversationId: string) {
    this.conversations.set(callControlId, conversationId);
  }

  async recordEscalationOffer(callControlId: string) {
    const f = this.flows.get(callControlId);
    if (f) f.escalation_offered_at = new Date().toISOString();
  }

  async activeAssistantCall(callerPhone: string) {
    for (const call of this.calls.values()) {
      if (call.contact_phone !== callerPhone) continue;
      for (const f of this.flows.values()) {
        if (f.call_id === call.id && f.stage === 'assistant') return { ...f };
      }
    }
    return null;
  }

  async activeResponders() {
    return this.responders
      .filter((r) => r.active)
      .sort((a, b) => a.ring_order - b.ring_order || a.id.localeCompare(b.id));
  }

  async addLeg(leg: Omit<CallLeg, 'status'>) {
    if (this.legs.has(leg.call_control_id)) return;
    this.legs.set(leg.call_control_id, { ...leg, status: 'ringing' });
  }

  async getLeg(callControlId: string) {
    const l = this.legs.get(callControlId);
    return l ? { ...l } : null;
  }

  /** Mirrors the call_legs_one_winner_idx partial unique index. */
  async electWinner(callControlId: string): Promise<'won' | 'lost'> {
    const leg = this.legs.get(callControlId);
    if (!leg || leg.status !== 'ringing') return 'lost';
    for (const other of this.legs.values()) {
      if (other.call_id === leg.call_id && other.status === 'answered') return 'lost';
    }
    leg.status = 'answered';
    return 'won';
  }

  async ringingLegs(callId: string, wave?: number) {
    return [...this.legs.values()].filter(
      (l) => l.call_id === callId && l.status === 'ringing' && (wave === undefined || l.wave === wave),
    );
  }

  async answeredLeg(callId: string) {
    return [...this.legs.values()].find((l) => l.call_id === callId && l.status === 'answered') ?? null;
  }

  async markLegDead(callControlId: string) {
    const l = this.legs.get(callControlId);
    if (l) l.status = 'dead';
  }

  async killRingingLegs(callId: string) {
    const doomed = await this.ringingLegs(callId);
    for (const l of doomed) this.legs.get(l.call_control_id)!.status = 'dead';
    return doomed;
  }

  async markCallAnswered(callId: string, answeredAt: string) {
    const c = this.calls.get(callId);
    if (c && !c.answered_at) {
      c.answered_at = answeredAt;
      c.was_answered = true;
    }
  }

  async finishCall(args: { callId: string; endedAt: string; wasAnswered: boolean; recordingStarted: boolean }) {
    const c = this.calls.get(args.callId);
    if (!c || c.ended_at) return;
    c.ended_at = args.endedAt;
    c.duration_sec = Math.max(0, Math.round((Date.parse(args.endedAt) - Date.parse(c.started_at)) / 1000));
    // Mirrors the contract on VoiceStore.finishCall and the `was_answered ||
    // row.was_answered` in supabaseStore: a stage that is not 'bridged' does not
    // un-answer a call the agent already picked up.
    c.was_answered = args.wasAnswered || c.was_answered;
    if (!args.recordingStarted && c.status === 'new') {
      c.status = 'failed';
      c.last_error = 'call ended before recording started, nothing to transcribe';
    }
  }

  async saveRecording(callId: string, url: string) {
    const c = this.calls.get(callId);
    if (c && (c.status === 'new' || c.status === 'failed')) {
      c.recording_url = url;
      c.status = 'new';
    }
  }

  async failCall(callId: string, error: string) {
    const c = this.calls.get(callId);
    if (c) {
      c.status = 'failed';
      c.last_error = error;
    }
  }
}

function responder(id: string, phone: string, ring_order: number): Responder {
  return {
    id,
    name: id,
    phone,
    ring_order,
    active: true,
    telegram_user_id: null,
    created_at: '2026-07-27T00:00:00.000Z',
  };
}

// --- Flow driver ------------------------------------------------------------

/**
 * Replays the events Telnyx sends up to the point the responders are ringing,
 * echoing client_state back the way Telnyx does: whatever a command set on a leg
 * comes back on that leg's later webhooks.
 */
async function ringResponders(
  store: FakeStore,
  fake: ReturnType<typeof fakeCommands>,
  prewarm: (phone: string) => void = () => {},
) {
  const deps = { store, commands: fake.commands, prewarm };
  await processTelnyxEvent(
    webhook('call.initiated', { from: '+14155550123', to: '+14155559999', direction: 'incoming', state: 'parked' }),
    deps,
  );
  await processTelnyxEvent(webhook('call.answered', { from: '+14155550123' }), deps);

  const disclosure = fake.of('speak').at(-1)!.params as SpeakParams;
  await processTelnyxEvent(webhook('call.speak.ended', { client_state: disclosure.client_state }), deps);
  return deps;
}

/** The client_state Telnyx echoes on a dialed responder leg's own events. */
function legState(fake: ReturnType<typeof fakeCommands>, legId: string): string {
  return (fake.of('dial').find((d) => d.id === legId)!.params as DialParams).client_state!;
}

// --- Tests ------------------------------------------------------------------

describe('receiveTelnyxWebhook', () => {
  const body = JSON.stringify(webhook('call.initiated', {}));

  it('accepts a correctly signed body', () => {
    const now = Date.now();
    const outcome = receiveTelnyxWebhook(body, signBody(body, Math.floor(now / 1000)), now);
    expect(outcome.ok).toBe(true);
  });

  it('rejects a missing signature header', () => {
    const headers = new Headers({ 'telnyx-timestamp': String(Math.floor(Date.now() / 1000)) });
    const outcome = receiveTelnyxWebhook(body, headers);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(outcome.ok === false && outcome.reason).toContain('missing telnyx-signature-ed25519');
  });

  it('rejects a missing timestamp header', () => {
    const headers = new Headers({ 'telnyx-signature-ed25519': 'AAAA' });
    const outcome = receiveTelnyxWebhook(body, headers);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(outcome.ok === false && outcome.reason).toContain('missing telnyx-timestamp');
  });

  it('rejects a signature that does not match the body', () => {
    const now = Date.now();
    const headers = signBody(body, Math.floor(now / 1000));
    const outcome = receiveTelnyxWebhook(body.replace('call.initiated', 'call.hangup'), headers, now);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a stale timestamp even when the signature is valid for it', () => {
    const now = Date.now();
    const stale = Math.floor(now / 1000) - 400; // tolerance is 300s
    const outcome = receiveTelnyxWebhook(body, signBody(body, stale), now);
    expect(outcome).toMatchObject({ ok: false, status: 403 });
    expect(outcome.ok === false && outcome.reason).toContain('tolerance');
  });

  it('rejects a body that is not JSON', () => {
    const now = Date.now();
    const outcome = receiveTelnyxWebhook('not json', signBody('not json', Math.floor(now / 1000)), now);
    expect(outcome).toMatchObject({ ok: false, status: 400 });
  });
});

describe('idempotency', () => {
  let store: FakeStore;
  let fake: ReturnType<typeof fakeCommands>;

  beforeEach(() => {
    store = new FakeStore();
    fake = fakeCommands();
  });

  it('treats a redelivered event id as a no-op', async () => {
    const deps = { store, commands: fake.commands };
    const event = webhook('call.initiated', { from: '+14155550123', direction: 'incoming' }, { id: 'evt-dupe' });

    await processTelnyxEvent(event, deps);
    await processTelnyxEvent(event, deps);
    await processTelnyxEvent(event, deps);

    expect(fake.of('answer')).toHaveLength(1);
    expect(store.calls.size).toBe(1);
  });

  it('releases the claim when handling throws, so a retry can re-run it', async () => {
    const deps = {
      store,
      commands: { ...fake.commands, answer: async () => { throw new Error('telnyx 500'); } } as TelnyxCommands,
    };
    await processTelnyxEvent(webhook('call.initiated', { from: '+14155550123' }, { id: 'evt-fail' }), deps);

    expect(store.events.has('evt-fail')).toBe(false);
    expect(store.released[0]).toContain('telnyx 500');
  });

  it('does not re-dial the whole wave when speak.ended is redelivered', async () => {
    store.responders = [responder('r1', '+14155550001', 0), responder('r2', '+14155550002', 0)];
    const deps = await ringResponders(store, fake);

    const disclosure = fake.of('speak')[0].params as SpeakParams;
    await processTelnyxEvent(
      webhook('call.speak.ended', { client_state: disclosure.client_state }, { id: 'evt-replay' }),
      deps,
    );

    expect(fake.of('dial')).toHaveLength(2);
    expect(fake.of('recordStart')).toHaveLength(1);
  });
});

describe('inbound flow ordering', () => {
  it('answers, then discloses, then records, and only then rings', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands();
    await ringResponders(store, fake);

    expect(fake.issued.map((i) => i.cmd)).toEqual(['answer', 'speak', 'recordStart', 'dial']);
    expect((fake.of('speak')[0].params as SpeakParams).payload).toBe('This call is being recorded.');
    expect(fake.of('recordStart')[0].params).toMatchObject({ channels: 'dual', format: 'mp3' });
  });

  it('links the caller to a contact row', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    await processTelnyxEvent(webhook('call.initiated', { from: '(415) 555-0123' }), { store, commands: fake.commands });
    expect([...store.contacts]).toEqual(['+14155550123']);
  });

  // The two halves of one trade. Answering first is worth ~2.8s of ringing the
  // caller used to sit through, and it is only safe because the second test
  // holds: call.answered now routinely overtakes the writes it used to follow.
  it('answers before it writes anything', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    let answeredFirst: boolean | null = null;
    const write = store.upsertContact.bind(store);
    store.upsertContact = async (phone: string) => {
      answeredFirst ??= fake.of('answer').length === 1;
      return write(phone);
    };

    await processTelnyxEvent(webhook('call.initiated', { from: '+14155550123' }), { store, commands: fake.commands });

    expect(answeredFirst).toBe(true);
  });

  it('waits for the flow row when call.answered overtakes the writes', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    // call.initiated has already answered the line and is still writing, so the
    // row lands mid-wait. Under 4 x 250ms, which is the point of the bound.
    setTimeout(() => void store.createFlow({ call_control_id: 'leg-a', call_id: 'call-1' }), 300);

    await processTelnyxEvent(webhook('call.answered', { from: '+14155550123' }), { store, commands: fake.commands });

    expect(fake.of('speak')).toHaveLength(1);
  });

  it('does not wait when the row exists in a later stage, which is a redelivery', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    await store.createFlow({ call_control_id: 'leg-a', call_id: 'call-1' });
    await store.advanceStage('leg-a', ['initiated'], 'assistant');

    const started = Date.now();
    await processTelnyxEvent(webhook('call.answered', { from: '+14155550123' }), { store, commands: fake.commands });

    expect(fake.of('speak')).toHaveLength(0);
    expect(Date.now() - started).toBeLessThan(FLOW_WAIT_ATTEMPTS * FLOW_WAIT_MS);
  });
});

describe('simulring waves', () => {
  let store: FakeStore;
  let fake: ReturnType<typeof fakeCommands>;

  beforeEach(() => {
    store = new FakeStore();
    // Two responders share ring_order 0 (one wave, dialed together), one is a
    // second wave that must not ring until the first wave gives up.
    store.responders = [
      responder('r1', '+14155550001', 0),
      responder('r2', '+14155550002', 0),
      responder('r3', '+14155550003', 1),
    ];
    fake = fakeCommands();
  });

  it('dials every responder sharing a ring_order at once and no later wave', async () => {
    await ringResponders(store, fake);

    const dials = fake.of('dial');
    expect(dials).toHaveLength(2);
    expect(dials.map((d) => (d.params as DialParams).to).sort()).toEqual(['+14155550001', '+14155550002']);
    expect(dials.every((d) => (d.params as DialParams).timeout_secs === 15)).toBe(true);
    expect(
      dials.every((d) => decodeClientState<{ wave: number }>((d.params as DialParams).client_state)!.wave === 0),
    ).toBe(true);
  });

  it('bridges the first leg to answer and hangs up the rest of the wave', async () => {
    const deps = await ringResponders(store, fake);

    await processTelnyxEvent(
      webhook('call.answered', { call_control_id: 'leg-b2', to: '+14155550002', client_state: legState(fake, 'leg-b2') }),
      deps,
    );

    expect(fake.of('bridge')[0]).toMatchObject({ id: 'leg-a', params: 'leg-b2' });
    expect(fake.of('hangup').map((h) => h.id)).toEqual(['leg-b1']);
    expect(store.flows.get('leg-a')!.stage).toBe('bridged');
    expect([...store.calls.values()][0]).toMatchObject({ was_answered: true, answered_at: '2026-07-27T18:00:00.000Z' });
  });

  it('hangs up a second leg that answers after the bridge is already made', async () => {
    const deps = await ringResponders(store, fake);

    await processTelnyxEvent(
      webhook('call.answered', { call_control_id: 'leg-b1', to: '+14155550001', client_state: legState(fake, 'leg-b1') }),
      deps,
    );
    await processTelnyxEvent(
      webhook('call.answered', { call_control_id: 'leg-b2', to: '+14155550002', client_state: legState(fake, 'leg-b2') }),
      deps,
    );

    // leg-b2 is hung up twice on purpose: once when the winning bridge kills the
    // rest of the wave, and again when its own late pickup loses the election. The
    // second one is what covers a hangup that raced the answer.
    expect(fake.of('bridge')).toHaveLength(1);
    expect(fake.of('bridge')[0]).toMatchObject({ params: 'leg-b1' });
    expect(fake.of('hangup').every((h) => h.id === 'leg-b2')).toBe(true);
    expect(store.legs.get('leg-b1')!.status).toBe('answered');
    expect(store.legs.get('leg-b2')!.status).toBe('dead');
  });

  it('starts the next wave only once the whole first wave has given up', async () => {
    const deps = await ringResponders(store, fake);

    await processTelnyxEvent(
      webhook('call.hangup', {
        call_control_id: 'leg-b1',
        hangup_cause: 'timeout',
        client_state: legState(fake, 'leg-b1'),
      }),
      deps,
    );
    expect(fake.of('dial')).toHaveLength(2); // leg-b2 is still ringing

    await processTelnyxEvent(
      webhook('call.hangup', {
        call_control_id: 'leg-b2',
        hangup_cause: 'timeout',
        client_state: legState(fake, 'leg-b2'),
      }),
      deps,
    );

    const dials = fake.of('dial');
    expect(dials).toHaveLength(3);
    expect((dials[2].params as DialParams).to).toBe('+14155550003');
    expect(store.flows.get('leg-a')!.wave).toBe(1);
  });
});

describe('no answer falls through to voicemail', () => {
  let store: FakeStore;
  let fake: ReturnType<typeof fakeCommands>;

  beforeEach(() => {
    store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0), responder('r2', '+14155550002', 1)];
    fake = fakeCommands();
  });

  async function everyWaveTimesOut() {
    const deps = await ringResponders(store, fake);
    await processTelnyxEvent(
      webhook('call.hangup', { call_control_id: 'leg-b1', hangup_cause: 'timeout', client_state: legState(fake, 'leg-b1') }),
      deps,
    );
    await processTelnyxEvent(
      webhook('call.hangup', { call_control_id: 'leg-b2', hangup_cause: 'no_answer', client_state: legState(fake, 'leg-b2') }),
      deps,
    );
    return deps;
  }

  it('speaks the voicemail prompt after the last wave and starts no second recording', async () => {
    await everyWaveTimesOut();

    const speaks = fake.of('speak');
    expect(speaks).toHaveLength(2);
    expect(decodeClientState<{ speak: string }>((speaks[1].params as SpeakParams).client_state)!.speak).toBe('voicemail');
    expect(fake.of('recordStart')).toHaveLength(1);
    expect(store.flows.get('leg-a')!.stage).toBe('voicemail');
  });

  it('goes straight to voicemail when there is no active responder at all', async () => {
    store.responders = [];
    await ringResponders(store, fake);

    expect(fake.of('dial')).toHaveLength(0);
    expect(fake.of('speak')).toHaveLength(2);
    expect(store.flows.get('leg-a')!.stage).toBe('voicemail');
  });

  it('closes the calls row from occurred_at and marks it unanswered', async () => {
    const deps = await everyWaveTimesOut();

    await processTelnyxEvent(
      webhook('call.hangup', { call_control_id: 'leg-a', hangup_cause: 'normal_clearing' }, { occurredAt: '2026-07-27T18:00:47.000Z' }),
      deps,
    );

    expect([...store.calls.values()][0]).toMatchObject({
      ended_at: '2026-07-27T18:00:47.000Z',
      duration_sec: 47,
      was_answered: false,
      status: 'new', // a recording exists, so the worker still has work to do
    });
  });

  it('stores the recording url and leaves the download to the worker', async () => {
    const deps = await everyWaveTimesOut();

    await processTelnyxEvent(
      webhook('call.recording.saved', {
        call_control_id: 'leg-a',
        channels: 'dual',
        recording_urls: { mp3: 'https://telnyx.example/rec.mp3', wav: null },
      }),
      deps,
    );

    expect([...store.calls.values()][0]).toMatchObject({
      recording_url: 'https://telnyx.example/rec.mp3',
      status: 'new',
    });
  });
});

describe('a caller who hangs up before the recording starts', () => {
  it('is marked failed instead of sitting in the worker queue forever', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    const deps = { store, commands: fake.commands };

    await processTelnyxEvent(webhook('call.initiated', { from: '+14155550123' }), deps);
    await processTelnyxEvent(webhook('call.answered', {}), deps);
    await processTelnyxEvent(
      webhook('call.hangup', { hangup_cause: 'normal_clearing' }, { occurredAt: '2026-07-27T18:00:04.000Z' }),
      deps,
    );

    expect([...store.calls.values()][0]).toMatchObject({
      status: 'failed',
      duration_sec: 4,
      was_answered: false,
    });
  });

  it('still rings the responders when record_start fails', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands({ recordStart: true });
    await ringResponders(store, fake);

    expect(fake.of('dial')).toHaveLength(1);
    expect(store.flows.get('leg-a')!.recording_started).toBe(false);
  });
});

describe('handing the caller to the AI agent', () => {
  const ASSISTANT_ID = 'assistant-0000-1111-2222-333344445555';

  beforeEach(() => {
    process.env.TELNYX_ASSISTANT_ID = ASSISTANT_ID;
  });

  afterEach(() => {
    delete process.env.TELNYX_ASSISTANT_ID;
  });

  it('starts the assistant after the disclosure, and dials nobody', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands();
    await ringResponders(store, fake);

    expect(fake.of('startAssistant')).toHaveLength(1);
    expect(fake.of('startAssistant')[0].params).toEqual({ assistant: { id: ASSISTANT_ID } });
    expect(fake.of('dial')).toHaveLength(0);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'assistant' });
  });

  it('still starts the dual-channel recording, before the assistant takes over', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands();
    await ringResponders(store, fake);

    expect(fake.of('recordStart')[0].params).toMatchObject({ channels: 'dual', format: 'mp3' });
    // The agent's first sentence has to be on tape, or the transcript the
    // Telegram card is built from starts halfway through the conversation.
    const order = fake.issued.map((i) => i.cmd);
    expect(order.indexOf('recordStart')).toBeLessThan(order.indexOf('startAssistant'));
  });

  it('remembers the conversation id, so a call row leads back to Mission Control', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    await ringResponders(store, fake);

    expect(store.conversations.get('leg-a')).toBe('conv-1');
  });

  it('falls back to the ring group if the assistant will not start', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands({ startAssistant: true });
    await ringResponders(store, fake);

    // A caller who reaches a dead agent must reach a human, not a silent line.
    expect(fake.of('dial')).toHaveLength(1);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'ringing', wave: 0 });
  });

  it('falls back to voicemail if the assistant dies and nobody is on the rota', async () => {
    const store = new FakeStore();
    store.responders = [];
    const fake = fakeCommands({ startAssistant: true });
    await ringResponders(store, fake);

    expect(fake.of('dial')).toHaveLength(0);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'voicemail' });
  });

  it('does not start two agents when speak.ended is redelivered', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    const deps = await ringResponders(store, fake);

    const disclosure = fake.of('speak')[0].params as SpeakParams;
    await processTelnyxEvent(
      webhook('call.speak.ended', { client_state: disclosure.client_state }, { id: 'evt-replay' }),
      deps,
    );

    expect(fake.of('startAssistant')).toHaveLength(1);
  });

  it('reverts to the ring group when the assistant id is unset, which is the rollback', async () => {
    delete process.env.TELNYX_ASSISTANT_ID;
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands();
    await ringResponders(store, fake);

    expect(fake.of('startAssistant')).toHaveLength(0);
    expect(fake.of('dial')).toHaveLength(1);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'ringing' });
  });

  it('counts an agent-handled call as answered, which it never used to', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    const deps = await ringResponders(store, fake);

    // The agent has the caller and the caller rings off from the agent, so the
    // flow never reaches 'bridged'. Every one of these read as unanswered, and
    // any report built on was_answered was wrong about every AI call.
    await processTelnyxEvent(
      webhook('call.hangup', { hangup_cause: 'normal_clearing' }, { occurredAt: '2026-07-27T18:00:58.000Z' }),
      deps,
    );

    expect([...store.calls.values()][0]).toMatchObject({
      was_answered: true,
      answered_at: '2026-07-27T18:00:00.000Z',
      duration_sec: 58,
    });
  });

  it('keeps was_answered true when the agent escalates and nobody picks up', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands();
    const deps = await ringResponders(store, fake);

    // Agent answered, then handed off to a ring group that timed out into
    // voicemail. The caller still spoke to somebody.
    await store.advanceStage('leg-a', ['assistant'], 'voicemail');
    await processTelnyxEvent(webhook('call.hangup', { hangup_cause: 'normal_clearing' }), deps);

    expect([...store.calls.values()][0].was_answered).toBe(true);
  });
});

describe('the silence between the disclosure and the agent', () => {
  const ASSISTANT_ID = 'assistant-0000-1111-2222-333344445555';

  beforeEach(() => {
    process.env.TELNYX_ASSISTANT_ID = ASSISTANT_ID;
  });

  afterEach(() => {
    delete process.env.TELNYX_ASSISTANT_ID;
  });

  it('warms the caller lookup before the disclosure plays, not after it', async () => {
    const store = new FakeStore();
    const fake = fakeCommands();
    const warmed: { phone: string; speaksSoFar: number }[] = [];

    await ringResponders(store, fake, (phone) =>
      warmed.push({ phone, speaksSoFar: fake.of('speak').length }),
    );

    // The disclosure is several seconds the caller is already spending. The
    // lookup the assistant blocks on has to be running through them, or the
    // dynamic-variables webhook pays for a database round trip in dead air.
    expect(warmed).toEqual([{ phone: '+14155550123', speaksSoFar: 0 }]);
  });

  it(
    'issues record_start and ai_assistant_start together instead of one after the other',
    { timeout: 3000 },
    async () => {
      const store = new FakeStore();
      const fake = fakeCommands();

      // record_start does not resolve until ai_assistant_start has been ISSUED.
      // Serial code cannot get past this: it is still awaiting the recording when
      // the thing it is waiting on is the command it has not sent yet. Concurrent
      // code sends both, then collects both.
      let assistantIssued!: () => void;
      const assistantWasIssued = new Promise<void>((resolve) => {
        assistantIssued = resolve;
      });

      const commands: TelnyxCommands = {
        ...fake.commands,
        recordStart: async (id, params) => {
          const out = fake.commands.recordStart(id, params);
          await assistantWasIssued;
          return out;
        },
        startAssistant: async (id, params) => {
          const out = fake.commands.startAssistant(id, params);
          assistantIssued();
          return out;
        },
      };

      const deps = { store, commands, prewarm: () => {} };
      await processTelnyxEvent(webhook('call.initiated', { from: '+14155550123' }), deps);
      await processTelnyxEvent(webhook('call.answered', { from: '+14155550123' }), deps);
      const disclosure = fake.of('speak').at(-1)!.params as SpeakParams;
      await processTelnyxEvent(webhook('call.speak.ended', { client_state: disclosure.client_state }), deps);

      expect(fake.of('recordStart')).toHaveLength(1);
      expect(fake.of('startAssistant')).toHaveLength(1);
      expect(store.flows.get('leg-a')).toMatchObject({ stage: 'assistant', recording_started: true });
      // Still issued in this order, so the agent's first sentence is on tape.
      const order = fake.issued.map((i) => i.cmd);
      expect(order.indexOf('recordStart')).toBeLessThan(order.indexOf('startAssistant'));
    },
  );

  it('still hands the caller to the agent when record_start fails', async () => {
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands({ recordStart: true });
    await ringResponders(store, fake);

    expect(fake.of('startAssistant')).toHaveLength(1);
    expect(fake.of('dial')).toHaveLength(0);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'assistant', recording_started: false });
  });

  it('still falls back to the ring group when the assistant will not start', async () => {
    // The concurrent issue must not have weakened this: the fallback is the only
    // thing between a dead agent and an open line with nobody on it.
    const store = new FakeStore();
    store.responders = [responder('r1', '+14155550001', 0)];
    const fake = fakeCommands({ startAssistant: true });
    await ringResponders(store, fake);

    expect(fake.of('dial')).toHaveLength(1);
    expect(store.flows.get('leg-a')).toMatchObject({ stage: 'ringing', wave: 0 });
    expect([...store.calls.values()][0].was_answered).toBe(false);
  });
});

describe('one voice, start to finish', () => {
  it('speaks the disclosure in the same voice the assistant answers in', async () => {
    // Bug A: `speak` had its own TELNYX_VOICE defaulting to "female", Telnyx's
    // basic engine, while the assistant ran neural Telnyx.Bayan.Amanda. The
    // caller heard a robot read the legal notice and then a person say hello.
    process.env.TELNYX_API_KEY = 'test-api-key';
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { result: 'ok' } }), { status: 200 });
    }) as typeof fetch;

    try {
      await telnyx.speak('leg-a', { payload: 'This call is recorded.' });
    } finally {
      globalThis.fetch = realFetch;
    }

    const assistant = assistantConfig({ publicBaseUrl: 'https://x.example', toolSecret: 's' });
    expect(sent[0].url).toContain('/calls/leg-a/actions/speak');
    expect(sent[0].body.voice).toBe(assistant.voice_settings.voice);
    expect(sent[0].body.voice).toBe(agentVoice());
    // Not a basic voice word. Those are the ones that sound like a phone tree.
    expect(sent[0].body.voice).not.toMatch(/^(male|female|man|woman)$/i);
  });

  it('speaks the disclosure at the same PACE the assistant answers at', async () => {
    // Bug B, and the reason bug A's fix did not finish the job: same voice, two
    // speeds. `speak` sent no voice_settings, so the opener ran at the voice's
    // natural 1.0 and everything after it at voiceSpeed(). Karim, 2026-08-14:
    // "the introduction felt extremely fast". Beat 1 carries the whole
    // introduction now, so the mismatch lands on the first thing anyone hears.
    //
    // Nesting is the assertion that matters. A top-level voice_speed is accepted
    // and ignored by the TTS API, so this checks the shape, not just the number.
    process.env.TELNYX_API_KEY = 'test-api-key';
    const sent: { body: Record<string, unknown> }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push({ body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { result: 'ok' } }), { status: 200 });
    }) as typeof fetch;

    try {
      await telnyx.speak('leg-a', { payload: 'This call is recorded.' });
    } finally {
      globalThis.fetch = realFetch;
    }

    const assistant = assistantConfig({ publicBaseUrl: 'https://x.example', toolSecret: 's' });
    expect(sent[0].body.voice_settings).toEqual({ voice_speed: voiceSpeed() });
    expect((sent[0].body.voice_settings as { voice_speed: number }).voice_speed).toBe(
      assistant.voice_settings.voice_speed,
    );
    expect(sent[0].body.voice_speed).toBeUndefined();
  });

  it('drops voice_settings when it falls back to the basic voice', async () => {
    // The fallback has one job: keep the call alive when the premium voice id is
    // rejected. A basic voice is a different engine, so handing it a
    // premium-shaped setting is a second way to fail the retry that exists to
    // not fail. `call.speak.ended` triggers record_start and the handoff, so a
    // speak that never lands is a silent stuck call, not a bad-sounding one.
    process.env.TELNYX_API_KEY = 'test-api-key';
    const sent: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return sent.length === 1
        ? new Response(JSON.stringify({ errors: [{ detail: 'bad voice' }] }), { status: 422 })
        : new Response(JSON.stringify({ data: { result: 'ok' } }), { status: 200 });
    }) as typeof fetch;

    try {
      await telnyx.speak('leg-a', { payload: 'This call is recorded.' });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(sent).toHaveLength(2);
    expect(sent[0].voice_settings).toEqual({ voice_speed: voiceSpeed() });
    expect(sent[1].voice_settings).toBeUndefined();
    expect(sent[1].payload).toBe('This call is recorded.');
  });
});
