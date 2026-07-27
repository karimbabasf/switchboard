import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Call, CallStatus } from '../lib/types';

// ---------------------------------------------------------------------------
// Environment. Nothing here is a real credential; every external call in
// these tests is mocked, so the values only need to satisfy env()'s
// non-empty check.
// ---------------------------------------------------------------------------
process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.SUPABASE_STORAGE_BUCKET = 'recordings';
process.env.ASSEMBLYAI_API_KEY = 'test-assemblyai-key';
process.env.ASSEMBLYAI_MODEL = 'universal-2';
process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';
process.env.WORKER_SECRET = 'a'.repeat(32);

// ---------------------------------------------------------------------------
// Fake Supabase client: an in-memory `calls` / `outbox` table plus a stubbed
// `storage` API, wired up behind the same chained-builder shape lib/db.ts's
// real client exposes (select/not/order/limit, update/eq/eq/eq/select/
// maybeSingle, insert). Good enough to exercise the exact call shapes
// lib/worker/*.ts makes, without a real Supabase project.
// ---------------------------------------------------------------------------
class FakeUpdateBuilder {
  private filters: Record<string, unknown> = {};
  private wantsSelect = false;

  constructor(
    private rows: Record<string, unknown>[],
    private patch: Record<string, unknown>,
  ) {}

  eq(col: string, val: unknown) {
    this.filters[col] = val;
    return this;
  }

  select(_cols?: string) {
    this.wantsSelect = true;
    return this;
  }

  maybeSingle() {
    return this.execute();
  }

  // Makes `await builder.update(...).eq(...)` work without an explicit .select().
  then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
    return this.execute().then(onFulfilled, onRejected);
  }

  private async execute() {
    // Deliberately no `await` between the match and the mutation: this is
    // what makes the fake behave like a single atomic UPDATE ... WHERE.
    const idx = this.rows.findIndex((r) => Object.entries(this.filters).every(([k, v]) => r[k] === v));
    if (idx === -1) {
      return this.wantsSelect ? { data: null, error: null } : { error: null };
    }
    this.rows[idx] = { ...this.rows[idx], ...this.patch, updated_at: new Date().toISOString() };
    return this.wantsSelect ? { data: { ...this.rows[idx] }, error: null } : { error: null };
  }
}

function createFakeDb(seedCalls: Call[] = []) {
  const state = {
    calls: seedCalls.map((c) => ({ ...c })) as Record<string, unknown>[],
    outbox: [] as Record<string, unknown>[],
  };

  const storageApi = {
    upload: vi.fn(async () => ({ data: { id: 'x', path: 'x', fullPath: 'x' }, error: null })),
    createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.example/x' }, error: null })),
  };

  const client = {
    storage: { from: (_bucket: string) => storageApi },
    from(table: string) {
      if (table === 'calls') {
        return {
          select: (_cols: string) => ({
            not: (_col: string, _op: string, _val: string) => ({
              order: (_col: string, _opts: unknown) => ({
                async limit(n: number) {
                  const pending = state.calls
                    .filter((c) => c.status !== 'posted' && c.status !== 'failed')
                    .slice()
                    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
                    .slice(0, n)
                    .map((c) => ({ ...c }));
                  return { data: pending, error: null };
                },
              }),
            }),
          }),
          update: (patch: Record<string, unknown>) => new FakeUpdateBuilder(state.calls, patch),
        };
      }
      if (table === 'outbox') {
        return {
          async insert(rows: Record<string, unknown>[]) {
            state.outbox.push(...rows);
            return { error: null };
          },
        };
      }
      throw new Error(`fake db: unhandled table "${table}"`);
    },
  };

  return { state, client, storageApi };
}

// vi.hoisted so the vi.mock factory below (which is itself hoisted above
// imports) can close over a box these tests fill in per-test.
const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db', () => ({
  db: () => dbBox.client,
  unwrap: (res: { data: unknown; error: { message: string } | null }, what: string) => {
    if (res.error) throw new Error(`${what}: ${res.error.message}`);
    return res.data;
  },
}));

function useFakeDb(seedCalls: Call[] = []) {
  const fake = createFakeDb(seedCalls);
  dbBox.client = fake.client;
  return fake;
}

function makeCall(overrides: Partial<Call> = {}): Call {
  return {
    id: 'call-1',
    contact_phone: '+14155550100',
    direction: 'inbound',
    provider_call_id: 'v3:abc',
    started_at: '2026-07-27T10:00:00.000Z',
    answered_at: '2026-07-27T10:00:05.000Z',
    ended_at: '2026-07-27T10:02:00.000Z',
    duration_sec: 115,
    was_answered: true,
    recording_url: 'https://telnyx.example/recording.mp3',
    storage_path: null,
    transcript: null,
    summary: null,
    status: 'new',
    attempts: 0,
    last_error: null,
    telegram_message_id: null,
    created_at: '2026-07-27T10:02:01.000Z',
    updated_at: '2026-07-27T10:02:01.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// recording.ts
// ---------------------------------------------------------------------------
describe('recording.ts: presigned URL expiry', () => {
  it('is not expired just under the 10-minute window', async () => {
    const { isExpired } = await import('../lib/worker/recording');
    const created = new Date('2026-07-27T10:00:00.000Z');
    const now = new Date(created.getTime() + 9 * 60 * 1000 + 59_000);
    expect(isExpired({ created_at: created.toISOString() }, now)).toBe(false);
  });

  it('is expired just past the 10-minute window', async () => {
    const { isExpired } = await import('../lib/worker/recording');
    const created = new Date('2026-07-27T10:00:00.000Z');
    const now = new Date(created.getTime() + 10 * 60 * 1000 + 1_000);
    expect(isExpired({ created_at: created.toISOString() }, now)).toBe(true);
  });

  it('fetchRecording throws RecordingExpiredError without attempting a fetch once aged out', async () => {
    const { fetchRecording, RecordingExpiredError } = await import('../lib/worker/recording');
    useFakeDb();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const call = makeCall({ created_at: '2026-07-27T10:00:00.000Z' });
    const now = new Date('2026-07-27T10:15:00.000Z');

    await expect(fetchRecording(call, now)).rejects.toBeInstanceOf(RecordingExpiredError);
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('downloads and uploads to storage when the URL is still fresh', async () => {
    const { fetchRecording } = await import('../lib/worker/recording');
    const fake = useFakeDb();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/mpeg' }),
        arrayBuffer: async () => new ArrayBuffer(8),
      })),
    );

    const call = makeCall({ created_at: '2026-07-27T10:00:00.000Z', id: 'call-fresh' });
    const now = new Date('2026-07-27T10:01:00.000Z');

    const path = await fetchRecording(call, now);
    expect(path).toBe('call-fresh.mp3');
    expect(fake.storageApi.upload).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// transcribe.ts
// ---------------------------------------------------------------------------
const assemblyBox = vi.hoisted(() => ({ transcribe: null as unknown }));
vi.mock('assemblyai', () => ({
  // A class, not vi.fn().mockImplementation(arrow): transcribe.ts calls
  // `new AssemblyAI(...)`, and an arrow function cannot be invoked with `new`.
  AssemblyAI: class {
    transcripts = {
      transcribe: (...args: unknown[]) => (assemblyBox.transcribe as (...a: unknown[]) => unknown)(...args),
    };
  },
}));

describe('transcribe.ts', () => {
  it('enables multichannel and leaves speaker diarization off', async () => {
    const { transcribeCall } = await import('../lib/worker/transcribe');
    useFakeDb();
    const transcribeMock = vi.fn(async () => ({ status: 'completed', utterances: [] }));
    assemblyBox.transcribe = transcribeMock;

    await transcribeCall(makeCall({ storage_path: 'call-1.mp3' }));

    expect(transcribeMock).toHaveBeenCalledWith(
      expect.objectContaining({ multichannel: true, speaker_labels: false }),
    );
  });

  it('labels each line by channel, not by a diarized speaker', async () => {
    const { transcribeCall } = await import('../lib/worker/transcribe');
    useFakeDb();
    assemblyBox.transcribe = vi.fn(async () => ({
      status: 'completed',
      utterances: [
        { channel: '1', text: 'Hi, is this the moving supply place?' },
        { channel: '2', text: 'Yes, how can I help?' },
      ],
    }));

    const transcript = await transcribeCall(makeCall({ storage_path: 'call-1.mp3' }));
    expect(transcript).toBe(
      'Speaker 1: Hi, is this the moving supply place?\nSpeaker 2: Yes, how can I help?',
    );
  });

  it('throws when AssemblyAI reports an error status', async () => {
    const { transcribeCall } = await import('../lib/worker/transcribe');
    useFakeDb();
    assemblyBox.transcribe = vi.fn(async () => ({ status: 'error', error: 'audio too short' }));

    await expect(transcribeCall(makeCall({ storage_path: 'call-1.mp3' }))).rejects.toThrow(/audio too short/);
  });
});

// ---------------------------------------------------------------------------
// summarize.ts: validateCallSummary
// ---------------------------------------------------------------------------
describe('summarize.ts: validateCallSummary', () => {
  it('accepts a well-formed summary', async () => {
    const { validateCallSummary } = await import('../lib/worker/summarize');
    const good = {
      headline: 'Caller asked about box pricing',
      caller_wanted: 'A quote for 20 medium boxes',
      commitments: ['Send a quote by email'],
      action_items: ['Follow up tomorrow'],
      needs_followup: true,
      sentiment: 'positive',
    };
    expect(validateCallSummary(good)).toEqual(good);
  });

  it.each([
    ['missing headline', { caller_wanted: 'x', commitments: [], action_items: [], needs_followup: false, sentiment: 'neutral' }],
    [
      'commitments not an array of strings',
      {
        headline: 'x',
        caller_wanted: 'x',
        commitments: [1, 2],
        action_items: [],
        needs_followup: false,
        sentiment: 'neutral',
      },
    ],
    [
      'needs_followup not boolean',
      {
        headline: 'x',
        caller_wanted: 'x',
        commitments: [],
        action_items: [],
        needs_followup: 'yes',
        sentiment: 'neutral',
      },
    ],
    [
      'invalid sentiment enum value',
      { headline: 'x', caller_wanted: 'x', commitments: [], action_items: [], needs_followup: false, sentiment: 'furious' },
    ],
    ['not an object', 'just a string'],
  ])('rejects %s', async (_label, malformed) => {
    const { validateCallSummary, MalformedSummaryError } = await import('../lib/worker/summarize');
    expect(() => validateCallSummary(malformed)).toThrow(MalformedSummaryError);
  });
});

const anthropicBox = vi.hoisted(() => ({ create: null as unknown }));
vi.mock('@anthropic-ai/sdk', () => ({
  // A class, not vi.fn().mockImplementation(arrow): summarize.ts calls
  // `new Anthropic(...)`, and an arrow function cannot be invoked with `new`.
  default: class {
    messages = {
      create: (...args: unknown[]) => (anthropicBox.create as (...a: unknown[]) => unknown)(...args),
    };
  },
}));

describe('summarize.ts: summarizeCall', () => {
  it('forces the tool call and validates the returned shape', async () => {
    const { summarizeCall } = await import('../lib/worker/summarize');
    const summary = {
      headline: 'Caller asked about box pricing',
      caller_wanted: 'A quote',
      commitments: [],
      action_items: [],
      needs_followup: false,
      sentiment: 'neutral',
    };
    anthropicBox.create = vi.fn(async () => ({
      content: [{ type: 'tool_use', name: 'record_call_summary', input: summary }],
    }));

    const result = await summarizeCall(makeCall({ transcript: 'Speaker 1: hi\nSpeaker 2: hello' }));
    expect(result).toEqual(summary);
    expect(anthropicBox.create).toHaveBeenCalledWith(
      expect.objectContaining({ tool_choice: { type: 'tool', name: 'record_call_summary' } }),
    );
  });

  it('throws MalformedSummaryError when no tool_use block is returned', async () => {
    const { summarizeCall, MalformedSummaryError } = await import('../lib/worker/summarize');
    anthropicBox.create = vi.fn(async () => ({ content: [{ type: 'text', text: 'sorry, I cannot do that' }] }));

    await expect(summarizeCall(makeCall({ transcript: 'hi' }))).rejects.toBeInstanceOf(MalformedSummaryError);
  });
});

// ---------------------------------------------------------------------------
// run.ts: the state machine
//
// These three modules stay mocked for the whole file (vi.mock is file-scoped),
// but the recording.ts / transcribe.ts / summarize.ts describe blocks above
// exercise the real implementations. So each proxy falls back to the actual
// export whenever the run.ts tests haven't pointed the box at a test double
// (the box starts, and is reset to, null).
// ---------------------------------------------------------------------------
const stepsBox = vi.hoisted(() => ({
  fetchRecording: null as unknown,
  transcribeCall: null as unknown,
  summarizeCall: null as unknown,
}));

vi.mock('../lib/worker/recording', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worker/recording')>();
  return {
    ...actual,
    fetchRecording: (...args: unknown[]) =>
      stepsBox.fetchRecording
        ? (stepsBox.fetchRecording as (...a: unknown[]) => unknown)(...args)
        : actual.fetchRecording(...(args as Parameters<typeof actual.fetchRecording>)),
  };
});
vi.mock('../lib/worker/transcribe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worker/transcribe')>();
  return {
    ...actual,
    transcribeCall: (...args: unknown[]) =>
      stepsBox.transcribeCall
        ? (stepsBox.transcribeCall as (...a: unknown[]) => unknown)(...args)
        : actual.transcribeCall(...(args as Parameters<typeof actual.transcribeCall>)),
  };
});
vi.mock('../lib/worker/summarize', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/worker/summarize')>();
  return {
    ...actual,
    summarizeCall: (...args: unknown[]) =>
      stepsBox.summarizeCall
        ? (stepsBox.summarizeCall as (...a: unknown[]) => unknown)(...args)
        : actual.summarizeCall(...(args as Parameters<typeof actual.summarizeCall>)),
  };
});

const FIXED_NOW = () => new Date('2026-07-27T10:02:30.000Z');
// callCard is async in the real lib/telegram/cards.ts (it resolves a Telegram
// topic and writes callback_actions rows), so the injected fake matches that.
const testCallCard = vi.fn(async () => [{ thread_id: 42, kind: 'text' as const, payload: { text: 'card' } }]);

describe('run.ts: state machine advances one step per call', () => {
  beforeEach(() => {
    stepsBox.fetchRecording = vi.fn(async () => 'call-1.mp3');
    stepsBox.transcribeCall = vi.fn(async () => 'Speaker 1: hi\nSpeaker 2: hello');
    stepsBox.summarizeCall = vi.fn(async () => ({
      headline: 'h',
      caller_wanted: 'w',
      commitments: [],
      action_items: [],
      needs_followup: false,
      sentiment: 'neutral' as const,
    }));
    testCallCard.mockClear();
  });

  it('walks new -> fetching -> transcribing -> summarizing -> posted, one step at a time', async () => {
    const fake = useFakeDb([makeCall({ status: 'new', attempts: 0 })]);
    const opts = { now: FIXED_NOW, callCard: testCallCard };
    const { runWorker } = await import('../lib/worker/run');

    let result = await runWorker(10, opts);
    expect(result).toMatchObject({ claimed: 1, advanced: 1, posted: 0, errored: 0, failed: 0 });
    expect(fake.state.calls[0].status).toBe('fetching');
    expect(fake.state.calls[0].storage_path).toBe('call-1.mp3');
    expect(fake.state.calls[0].attempts).toBe(0); // reset on advance

    result = await runWorker(10, opts);
    expect(result).toMatchObject({ claimed: 1, advanced: 1 });
    expect(fake.state.calls[0].status).toBe('transcribing');
    expect(fake.state.calls[0].transcript).toContain('Speaker 1');

    result = await runWorker(10, opts);
    expect(result).toMatchObject({ claimed: 1, advanced: 1 });
    expect(fake.state.calls[0].status).toBe('summarizing');
    expect(fake.state.calls[0].summary).toMatchObject({ headline: 'h' });

    result = await runWorker(10, opts);
    expect(result).toMatchObject({ claimed: 1, posted: 1 });
    expect(fake.state.calls[0].status).toBe('posted');
    expect(testCallCard).toHaveBeenCalledTimes(1);
    expect(fake.state.outbox).toEqual([{ thread_id: 42, kind: 'text', payload: { text: 'card' } }]);
  });

  it('leaves posted and failed rows alone on later ticks', async () => {
    const fake = useFakeDb([makeCall({ status: 'posted' }), makeCall({ id: 'call-2', status: 'failed' })]);
    const { runWorker } = await import('../lib/worker/run');

    const result = await runWorker(10, { now: FIXED_NOW, callCard: testCallCard });
    expect(result.claimed).toBe(0);
    expect(fake.state.calls.map((c) => c.status)).toEqual(['posted', 'failed']);
  });
});

describe('run.ts: an expired recording URL fails cleanly instead of looping', () => {
  it('marks the row failed immediately, without waiting for the retry budget', async () => {
    const { RecordingExpiredError } = await import('../lib/worker/recording');
    stepsBox.fetchRecording = vi.fn(async () => {
      throw new RecordingExpiredError(11 * 60 * 1000);
    });

    // attempts: 0, well under MAX_ATTEMPTS -- expiry must still fail it outright.
    const fake = useFakeDb([makeCall({ status: 'new', attempts: 0 })]);
    const { runWorker } = await import('../lib/worker/run');

    const result = await runWorker(10, { now: FIXED_NOW });
    expect(result).toMatchObject({ claimed: 1, failed: 1, errored: 0 });
    expect(fake.state.calls[0].status).toBe('failed');
    expect(fake.state.calls[0].last_error).toMatch(/presigned/i);

    // A later tick must not touch it again: it is excluded by selectCandidates.
    const again = await runWorker(10, { now: FIXED_NOW });
    expect(again.claimed).toBe(0);
    expect(stepsBox.fetchRecording).toHaveBeenCalledTimes(1);
  });
});

describe('run.ts: a malformed summary is retried, not stored', () => {
  it('keeps retrying under the attempt budget, then gives up past it', async () => {
    const { MalformedSummaryError } = await import('../lib/worker/summarize');
    const { runWorker, MAX_ATTEMPTS } = await import('../lib/worker/run');

    stepsBox.summarizeCall = vi.fn(async () => {
      throw new MalformedSummaryError('missing sentiment');
    });

    const fake = useFakeDb([makeCall({ status: 'transcribing', attempts: 0, transcript: 'hi' })]);

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      const result = await runWorker(10, { now: FIXED_NOW });
      expect(result).toMatchObject({ claimed: 1, errored: 1, failed: 0 });
      expect(fake.state.calls[0].status).toBe('transcribing'); // never stored, never advanced
      expect(fake.state.calls[0].summary).toBeNull();
      expect(fake.state.calls[0].attempts).toBe(i);
    }

    // One more failure exhausts the budget.
    const final = await runWorker(10, { now: FIXED_NOW });
    expect(final).toMatchObject({ claimed: 1, failed: 1 });
    expect(fake.state.calls[0].status).toBe('failed');
    expect(fake.state.calls[0].last_error).toMatch(/missing sentiment/);
  });
});

describe('run.ts: concurrent invocations never double-claim a row', () => {
  it('lets exactly one of two overlapping ticks process the same row', async () => {
    stepsBox.fetchRecording = vi.fn(async () => {
      await Promise.resolve();
      return 'call-1.mp3';
    });

    const fake = useFakeDb([makeCall({ status: 'new', attempts: 0 })]);
    const { runWorker } = await import('../lib/worker/run');

    const [a, b] = await Promise.all([runWorker(10, { now: FIXED_NOW }), runWorker(10, { now: FIXED_NOW })]);

    expect(a.claimed + b.claimed).toBe(1);
    expect(a.advanced + b.advanced).toBe(1);
    expect(stepsBox.fetchRecording).toHaveBeenCalledTimes(1);
    expect(fake.state.calls[0].status).toBe('fetching');
    expect(fake.state.calls[0].attempts).toBe(0);
  });
});
