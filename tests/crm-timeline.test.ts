import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallSummary } from '../lib/types';

/**
 * lib/crm/timeline.ts: the switchboard half of the shared crm_timeline.
 *
 * Two properties matter more than the columns, and both are tested here rather
 * than at the three call sites:
 *
 * 1. IDEMPOTENT on (source_table, source_id). A retried Telnyx webhook or a
 *    re-run worker must leave one row, not two, so the fake below enforces the
 *    real partial unique index instead of pretending inserts always succeed.
 * 2. LOUD. Everything here raises, and the three call sites swallow. The
 *    never-fatal half of the contract is therefore tested where it lives, in
 *    tests/crm-timeline-writers.test.ts.
 *
 * resolveParty is deliberately NOT mocked: the rule is that both repos resolve
 * identity through the one Postgres function, so the rpc call is the thing
 * worth asserting.
 */

process.env.SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key';
process.env.TELEGRAM_CHAT_ID = '-100123456789';

const dbBox = vi.hoisted(() => ({ client: null as unknown }));
vi.mock('../lib/db', () => ({ db: () => dbBox.client }));

import {
  appendTimeline,
  noteCallSummary,
  noteInboundSms,
  noteOutboundSms,
  renderCallSummary,
} from '../lib/crm/timeline';

const PARTY = {
  id: 'party-1',
  display_name: 'Jane Doe',
  customer_id: null,
  primary_email: null,
  primary_phone: '+14155550111',
};

/**
 * An in-memory crm_timeline that enforces what the real table enforces: the
 * partial unique index over (source_table, source_id) where both are not null.
 * Same idiom as the fake in tests/worker.test.ts, and the reason is the one
 * spelled out in tests/sms.test.ts: a fake that accepts everything cannot prove
 * anything about a constraint.
 */
function createFakeDb() {
  const rows: Record<string, unknown>[] = [];
  let nextId = 1;

  const rpc = vi.fn(async () => ({ data: [PARTY], error: null }));

  const client = {
    rpc,
    from(table: string) {
      if (table !== 'crm_timeline') throw new Error(`fake db: unhandled table "${table}"`);
      return {
        insert: (row: Record<string, unknown>) => ({
          select: () => ({
            async single() {
              const clashes =
                row.source_table != null &&
                row.source_id != null &&
                rows.some((r) => r.source_table === row.source_table && r.source_id === row.source_id);
              if (clashes) {
                return {
                  data: null,
                  error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "crm_timeline_source_uidx"',
                  },
                };
              }
              // shadow before the spread, so an explicit false from the caller
              // still wins: the column defaults to true in the migration.
              const stored = {
                id: `tl-${nextId++}`,
                shadow: true,
                order_id: null,
                created_at: '2026-08-13T00:00:00.000Z',
                ...row,
              };
              rows.push(stored);
              return { data: { ...stored }, error: null };
            },
          }),
        }),
        select: () => {
          const filters: Record<string, unknown> = {};
          const builder = {
            eq(column: string, value: unknown) {
              filters[column] = value;
              return builder;
            },
            async maybeSingle() {
              const found = rows.find((r) => Object.entries(filters).every(([k, v]) => r[k] === v));
              return { data: found ? { ...found } : null, error: null };
            },
          };
          return builder;
        },
      };
    },
  };

  dbBox.client = client;
  return { rows, rpc };
}

/** A db whose crm_timeline insert always fails, for the never-fatal tests. */
function createBrokenDb(error: { code?: string; message: string }) {
  dbBox.client = {
    rpc: vi.fn(async () => ({ data: [PARTY], error: null })),
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => ({ data: null, error }) }) }),
      select: () => ({
        eq: function eq() {
          return this;
        },
        maybeSingle: async () => ({ data: null, error: null }),
      }),
    }),
  };
}

function summaryFixture(overrides: Partial<CallSummary> = {}): CallSummary {
  return {
    headline: 'Asked whether we deliver to Capital City',
    caller_wanted: 'a delivery date for 20 boxes',
    commitments: ['send the box list by text'],
    action_items: ['confirm Thursday delivery'],
    needs_followup: true,
    sentiment: 'neutral',
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  createFakeDb();
});

describe('appendTimeline writes a row the real table will actually accept', () => {
  // Same reasoning as the claimEvent shape test in tests/sms.test.ts: a mocked
  // database does not enforce NOT NULL, so the only way a unit test catches a
  // missing required column is to assert the shape against the columns the
  // migration demands. Duplicated on purpose, so a schema change fails here
  // and names the column.
  const REQUIRED_COLUMNS = ['party_id', 'channel', 'direction', 'body', 'occurred_at'] as const;

  it('sends every NOT NULL column of crm_timeline', async () => {
    const { rows } = createFakeDb();

    await appendTimeline({
      partyId: PARTY.id,
      channel: 'sms',
      direction: 'in',
      body: 'do you deliver',
      occurredAt: new Date('2026-08-13T17:00:00.000Z'),
      sourceTable: 'messages',
      sourceId: 'msg-1',
    });

    for (const column of REQUIRED_COLUMNS) {
      expect(rows[0][column], `crm_timeline.${column} is NOT NULL and was not sent`).not.toBeUndefined();
      expect(rows[0][column], `crm_timeline.${column} is NOT NULL and was sent as null`).not.toBeNull();
    }
    expect(rows[0].occurred_at).toBe('2026-08-13T17:00:00.000Z');
  });

  it('leaves shadow out when the caller says nothing, so the column default holds', async () => {
    const { rows } = createFakeDb();

    await appendTimeline({
      partyId: PARTY.id,
      channel: 'call',
      direction: 'in',
      body: 'a call',
      occurredAt: new Date('2026-08-13T17:00:00.000Z'),
    });

    expect(rows[0].shadow).toBe(true);
  });
});

describe('appendTimeline is idempotent on (source_table, source_id)', () => {
  it('writes one row when the same source is appended twice, and returns it', async () => {
    const { rows } = createFakeDb();
    const entry = {
      partyId: PARTY.id,
      channel: 'sms' as const,
      direction: 'in' as const,
      body: 'do you deliver',
      occurredAt: new Date('2026-08-13T17:00:00.000Z'),
      sourceTable: 'messages',
      sourceId: 'msg-1',
    };

    const first = await appendTimeline(entry);
    const second = await appendTimeline(entry);

    expect(rows).toHaveLength(1);
    expect(second.id).toBe(first.id);
  });

  it('keeps two different sources apart', async () => {
    const { rows } = createFakeDb();
    const base = {
      partyId: PARTY.id,
      channel: 'sms' as const,
      direction: 'in' as const,
      body: 'do you deliver',
      occurredAt: new Date('2026-08-13T17:00:00.000Z'),
      sourceTable: 'messages',
    };

    await appendTimeline({ ...base, sourceId: 'msg-1' });
    await appendTimeline({ ...base, sourceId: 'msg-2' });

    expect(rows).toHaveLength(2);
  });

  it('raises a duplicate that carries no source pointer, because nothing can be returned', async () => {
    createBrokenDb({ code: '23505', message: 'duplicate key value' });

    await expect(
      appendTimeline({
        partyId: PARTY.id,
        channel: 'sms',
        direction: 'out',
        body: 'a draft with no source',
        occurredAt: new Date('2026-08-13T17:00:00.000Z'),
      }),
    ).rejects.toThrow(/appendTimeline failed/);
  });

  it('raises anything that is not a unique violation', async () => {
    createBrokenDb({ code: '23503', message: 'party_id is not a party' });

    await expect(
      appendTimeline({
        partyId: 'nobody',
        channel: 'sms',
        direction: 'in',
        body: 'hi',
        occurredAt: new Date('2026-08-13T17:00:00.000Z'),
        sourceTable: 'messages',
        sourceId: 'msg-9',
      }),
    ).rejects.toThrow(/party_id is not a party/);
  });
});

describe('the three writers put the right event on the timeline', () => {
  it('records an inbound text against the messages row that owns it', async () => {
    const { rows, rpc } = createFakeDb();

    await noteInboundSms({
      phone: '+14155550111',
      body: 'do you deliver to Capital City',
      messageId: 'msg-1',
      occurredAt: '2026-08-13T17:00:00.000Z',
      displayName: 'Jane Doe',
    });

    // One identity path for both repos, and it lives in Postgres.
    expect(rpc).toHaveBeenCalledWith('crm_resolve_party', {
      p_kind: 'phone',
      p_value: '+14155550111',
      p_display_name: 'Jane Doe',
    });
    expect(rows[0]).toMatchObject({
      party_id: PARTY.id,
      channel: 'sms',
      direction: 'in',
      body: 'do you deliver to Capital City',
      occurred_at: '2026-08-13T17:00:00.000Z',
      source_table: 'messages',
      source_id: 'msg-1',
    });
  });

  it('records an MMS with no text, because the attachment is the message', async () => {
    const { rows } = createFakeDb();

    await noteInboundSms({
      phone: '+14155550111',
      body: null,
      messageId: 'msg-2',
      occurredAt: '2026-08-13T17:00:00.000Z',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('(no text, attachment only)');
  });

  it('records an outbound text as sent, never as a draft', async () => {
    const { rows } = createFakeDb();

    await noteOutboundSms({
      phone: '+14155550111',
      body: 'Hi, we are open 8 to 4 Monday to Friday.',
      messageId: 'msg-3',
      occurredAt: '2026-08-13T17:05:00.000Z',
    });

    expect(rows[0]).toMatchObject({
      channel: 'sms',
      direction: 'out',
      source_table: 'messages',
      source_id: 'msg-3',
      shadow: false, // it really went out, so it is not a draft at any layer
    });
  });

  it('records a call as its summary, stamped when the call happened', async () => {
    const { rows } = createFakeDb();

    await noteCallSummary({
      phone: '+14155550111',
      callId: 'call-1',
      summary: summaryFixture(),
      occurredAt: '2026-08-13T16:30:00.000Z',
    });

    expect(rows[0]).toMatchObject({
      channel: 'call',
      direction: 'in',
      occurred_at: '2026-08-13T16:30:00.000Z',
      source_table: 'calls',
      source_id: 'call-1',
    });
    expect(rows[0].body).toContain('Asked whether we deliver to Capital City');
  });

  it('falls back to now rather than losing the event to an unparseable timestamp', async () => {
    const { rows } = createFakeDb();

    await noteOutboundSms({
      phone: '+14155550111',
      body: 'hi there',
      messageId: 'msg-4',
      occurredAt: 'now', // what a fixture, or a null column, can hand this
    });

    expect(rows).toHaveLength(1);
    expect(Number.isNaN(new Date(rows[0].occurred_at as string).getTime())).toBe(false);
  });
});

describe('a writer raises rather than quietly writing nothing', () => {
  // The call sites are what turn these into best effort, and they are tested
  // in tests/crm-timeline-writers.test.ts. Swallowing HERE as well would hide
  // a broken timeline from every one of them at once.
  it('raises when the insert fails', async () => {
    createBrokenDb({ code: '42P01', message: 'relation "crm_timeline" does not exist' });

    await expect(
      noteInboundSms({ phone: '+14155550111', body: 'hi', messageId: 'msg-5', occurredAt: '2026-08-13T17:00:00.000Z' }),
    ).rejects.toThrow(/crm_timeline/);
    await expect(
      noteOutboundSms({ phone: '+14155550111', body: 'hi', messageId: 'msg-6', occurredAt: null }),
    ).rejects.toThrow(/crm_timeline/);
    await expect(
      noteCallSummary({ phone: '+14155550111', callId: 'call-2', summary: summaryFixture(), occurredAt: null }),
    ).rejects.toThrow(/crm_timeline/);
  });

  it('raises when the party resolver is down', async () => {
    dbBox.client = { rpc: async () => ({ data: null, error: { message: 'crm_resolve_party is gone' } }) };

    await expect(
      noteInboundSms({ phone: '+14155550111', body: 'hi', messageId: 'msg-7', occurredAt: '2026-08-13T17:00:00.000Z' }),
    ).rejects.toThrow(/crm_resolve_party/);
  });
});

describe('renderCallSummary: prose for a model, not a card for a human', () => {
  it('carries every part of the summary and no markup', () => {
    const text = renderCallSummary(summaryFixture());

    expect(text).toContain('Asked whether we deliver to Capital City');
    expect(text).toContain('Wanted: a delivery date for 20 boxes');
    expect(text).toContain('send the box list by text');
    expect(text).toContain('confirm Thursday delivery');
    expect(text).toContain('Needs followup.');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('•');
  });

  it('drops the sections a quiet call leaves empty', () => {
    const text = renderCallSummary(
      summaryFixture({ caller_wanted: '', commitments: [], action_items: [], needs_followup: false }),
    );

    expect(text).toBe('Asked whether we deliver to Capital City');
  });
});
