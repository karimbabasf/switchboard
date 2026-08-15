import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One rule under test: A CALL NEVER PUTS A CARD IN 🔴 NEEDS YOU.
 *
 * Karim, 2026-08-15: "the call only pings me if it has to pass through to a rep.
 * other than that it shouldn't. pings only come to me through email or text."
 * The queue had been filling with quotes nobody asked for, because the agent
 * files a request every time it texts somebody the catalogue, and a caller who
 * was told to reply to that text is not a caller who has asked to be priced yet.
 *
 * The row is still written for every source. The row is the record; the card is
 * the interruption; only one of those is being taken away.
 */

const inserts: { table: string; row: Record<string, unknown> }[] = [];

function insertResult(table: string) {
  return {
    insert: (row: Record<string, unknown>) => {
      inserts.push({ table, row });
      const built = {
        select: () => built,
        single: async () => ({ data: { id: 'qr-1', ...row }, error: null }),
        then: (resolve: (v: { error: null }) => unknown) => resolve({ error: null }),
      };
      return built;
    },
  };
}

vi.mock('../lib/db', () => ({ db: () => ({ from: (table: string) => insertResult(table) }) }));

vi.mock('../lib/telegram/topics', () => ({
  formatPhoneForDisplay: (p: string) => p,
  resolveIndexTopic: vi.fn(async () => 7),
  resolveTopic: vi.fn(async () => 42),
  QUOTE_REQUESTS_TOPIC: 'needs_you',
}));

vi.mock('../lib/telegram/cards', () => ({
  quoteRequestCard: vi.fn(async () => ({ text: 'a card' })),
}));

import { recordQuoteRequest } from '../lib/quote-requests';
import { quoteRequestCard } from '../lib/telegram/cards';

const outboxRows = () => inserts.filter((i) => i.table === 'outbox');
const quoteRows = () => inserts.filter((i) => i.table === 'quote_requests');

beforeEach(() => {
  inserts.length = 0;
  vi.clearAllMocks();
});

describe('recordQuoteRequest', () => {
  it('records a call request without queueing a card', async () => {
    await recordQuoteRequest({ phone: '+14155550142', source: 'call', wants: 'tape and shrink wrap' });

    expect(quoteRows()).toHaveLength(1);
    expect(outboxRows()).toHaveLength(0);
  });

  it('does not even render a card for a call, which would be a wasted round trip', async () => {
    await recordQuoteRequest({ phone: '+14155550142', source: 'call', wants: 'tape' });
    expect(quoteRequestCard).not.toHaveBeenCalled();
  });

  it('still queues a card for a text, which is a customer asking in writing', async () => {
    await recordQuoteRequest({ phone: '+14155550142', source: 'sms', wants: 'a pallet of film' });

    expect(quoteRows()).toHaveLength(1);
    expect(outboxRows()).toHaveLength(1);
    expect(outboxRows()[0]?.row.thread_id).toBe(7);
  });

  it('refuses an empty wants, because there is nothing to price', async () => {
    await expect(recordQuoteRequest({ phone: '+14155550142', source: 'call', wants: '   ' })).rejects.toThrow(/nothing to price/i);
  });
});
