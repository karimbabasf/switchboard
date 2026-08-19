import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { askAkmeDesk } from '../lib/akme/desk';

const SECRET = 'desk-secret-for-tests';

function callBody() {
  const [, init] = vi.mocked(fetch).mock.calls[0];
  return JSON.parse(init?.body as string) as Record<string, unknown>;
}

function bearer(): string {
  const [, init] = vi.mocked(fetch).mock.calls[0];
  const headers = init?.headers as Record<string, string>;
  return headers.authorization.replace('Bearer ', '');
}

beforeEach(() => {
  vi.stubEnv('DESK_INBOUND_SECRET', SECRET);
  vi.stubEnv('AKME_BASE_URL', 'https://akme-dev.example.com');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const input = {
  phone: '+14155550111',
  body: '40 cases of clear tape please',
  displayName: 'Jane Doe',
  messageId: 'msg-1',
};

describe('askAkmeDesk: the request', () => {
  it('posts to the desk door with the message and the channel', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: false, reply: null }), { status: 200 }));
    await askAkmeDesk(input);

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://akme-dev.example.com/api/desk/inbound');
    expect(callBody()).toEqual({
      phone: '+14155550111',
      channel: 'sms',
      body: '40 cases of clear tape please',
      displayName: 'Jane Doe',
      sourceId: 'msg-1',
    });
  });

  // The signature Akme's verifyToken checks. Written out here rather than
  // imported so the two repos are pinned against each other by VALUE: if either
  // side changes how a token is built, this fails instead of a live 401 doing it.
  it('signs a desk_inbound token the other side can verify', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: false }), { status: 200 }));
    await askAkmeDesk(input);

    const [encoded, sig] = bearer().split('.');
    const expected = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
    expect(sig).toBe(expected);

    const claims = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as {
      scope: string;
      exp: number;
    };
    expect(claims.scope).toBe('desk_inbound');
    expect(claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  // A token scoped for the price editor must not open this door, which is why
  // Akme keeps a separate secret and refuses to boot when two of them match.
  it('never signs with the price editor secret', async () => {
    vi.stubEnv('AKME_SIGNING_SECRET', 'a-different-secret');
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: false }), { status: 200 }));
    await askAkmeDesk(input);

    const [encoded, sig] = bearer().split('.');
    const wrong = crypto.createHmac('sha256', 'a-different-secret').update(encoded).digest('base64url');
    expect(sig).not.toBe(wrong);
  });
});

describe('askAkmeDesk: reading the answer', () => {
  it('returns the reply when the desk handled it', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ handled: true, reply: 'Quote AK-00042.' }), { status: 200 }),
    );
    expect(await askAkmeDesk(input)).toEqual({ kind: 'answer', reply: 'Quote AK-00042.' });
  });

  it('reports silence when the desk handled it and wrote nothing', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: true, reply: null }), { status: 200 }));
    expect(await askAkmeDesk(input)).toEqual({ kind: 'silent' });
  });

  // Whitespace is not an answer. Sending it would text a customer a blank
  // message, which reads as a bug on their phone and is one here too.
  it('reports silence on a reply that is only whitespace', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: true, reply: '   ' }), { status: 200 }));
    expect(await askAkmeDesk(input)).toEqual({ kind: 'silent' });
  });

  it('declines when the desk did not take it', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ handled: false, reply: null }), { status: 200 }));
    expect(await askAkmeDesk(input)).toEqual({ kind: 'declined' });
  });

  it('declines when the secret is not configured here', async () => {
    // The pre-desk state. The old path is the whole system, and that is not an
    // outage worth a card.
    vi.unstubAllEnvs();
    vi.stubEnv('AKME_BASE_URL', 'https://akme-dev.example.com');
    expect(await askAkmeDesk(input)).toEqual({ kind: 'declined' });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('askAkmeDesk: when the state is unknown', () => {
  // 401 and 503 are configuration, not a decision. Reporting them as a decline
  // would hide a wrong or missing secret behind a working fallback for as long
  // as nobody looked at the thread.
  it.each([401, 503])('reports %i as unreachable, not as a decline', async (status) => {
    vi.mocked(fetch).mockResolvedValue(new Response('{}', { status }));
    const out = await askAkmeDesk(input);
    expect(out.kind).toBe('unreachable');
  });

  it('reports a network failure as unreachable', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await askAkmeDesk(input);
    expect(out.kind).toBe('unreachable');
    expect(out.kind === 'unreachable' && out.reason).toContain('ECONNREFUSED');
  });

  it('reports a timeout as unreachable', async () => {
    vi.mocked(fetch).mockImplementation(async () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      throw err;
    });
    const out = await askAkmeDesk(input);
    expect(out.kind).toBe('unreachable');
    expect(out.kind === 'unreachable' && out.reason).toContain('did not answer');
  });

  // A 500 IS a decision Akme made: its own route catches and answers
  // `{handled:false}` with a 200, so a 5xx means the request never reached the
  // handler. Treated as a decline because the old path is safe there, and
  // because a Vercel cold-start 502 must not stop a customer being answered.
  it('declines on a server error, which the route itself never returns', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('bad gateway', { status: 502 }));
    expect(await askAkmeDesk(input)).toEqual({ kind: 'declined' });
  });
});
