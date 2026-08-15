import { describe, expect, it } from 'vitest';
import { BLOCKED_FIELDS, blockedPresent, forwardBody, minimalBody, withCacheControl } from '../lib/agent/gateway.ts';

/**
 * The body below is what Telnyx's assistant actually sends, read off the
 * gateway's own "dropped non-forwarded fields" log on 2026-08-15:
 * stream_options, extra_metadata, parallel_tool_calls, temperature.
 */
const TELNYX_BODY = {
  model: 'MiniMaxAI/MiniMax-M3-MXFP8',
  messages: [{ role: 'user', content: 'How much is the tape?' }],
  tools: [{ type: 'function', function: { name: 'text_me_the_list' } }],
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true, continuous_usage_stats: true },
  extra_metadata: { telnyx_end_user_target: '+14155550184' },
  parallel_tool_calls: true,
  temperature: 0.7,
};

describe('forwardBody', () => {
  it('KEEPS temperature, because dropping it changed how the agent answers', () => {
    // Regression on a real call: without this the agent skipped "tell me more
    // about the tape" and recited the pricing routes instead.
    expect(forwardBody(TELNYX_BODY, 'x').temperature).toBe(0.7);
  });

  it('blocks the field that took the phone line down', () => {
    const out = forwardBody(TELNYX_BODY, 'x');
    expect(out.stream_options).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('continuous_usage_stats');
  });

  it('blocks max_tokens, which Telnyx refuses alongside tools', () => {
    expect(forwardBody({ ...TELNYX_BODY, max_tokens: 200 }, 'x').max_tokens).toBeUndefined();
    expect(forwardBody({ ...TELNYX_BODY, max_completion_tokens: 200 }, 'x').max_completion_tokens).toBeUndefined();
  });

  it('forwards every other field Telnyx sends, verified accepted upstream', () => {
    const out = forwardBody(TELNYX_BODY, 'x');
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.extra_metadata).toEqual(TELNYX_BODY.extra_metadata);
    expect(out.tools).toEqual(TELNYX_BODY.tools);
    expect(out.tool_choice).toBe('auto');
    expect(out.stream).toBe(true);
  });

  it('blocks exactly two things and nothing else', () => {
    expect([...BLOCKED_FIELDS].sort()).toEqual(['max_completion_tokens', 'max_tokens', 'stream_options']);
    const sent = new Set(Object.keys(TELNYX_BODY));
    const got = new Set(Object.keys(forwardBody(TELNYX_BODY, 'x')));
    const missing = [...sent].filter((k) => !got.has(k));
    expect(missing).toEqual(['stream_options']);
  });

  it('overrides the caller-supplied model, so the choice lives in one place', () => {
    expect(forwardBody(TELNYX_BODY, 'anthropic/claude-haiku-4-5').model).toBe('anthropic/claude-haiku-4-5');
  });

  it('reports which blocked fields were present, for the log', () => {
    expect(blockedPresent(TELNYX_BODY)).toEqual(['stream_options']);
    expect(blockedPresent({ messages: [] })).toEqual([]);
  });
});

describe('minimalBody, the retry after an upstream 400', () => {
  it('keeps only what the API cannot refuse', () => {
    expect(Object.keys(minimalBody(TELNYX_BODY, 'x')).sort()).toEqual([
      'messages',
      'model',
      'stream',
      'tool_choice',
      'tools',
    ]);
  });

  it('survives a field Telnyx has not invented yet', () => {
    const out = minimalBody({ ...TELNYX_BODY, some_future_field: { nested: true } }, 'x');
    expect(out.some_future_field).toBeUndefined();
    expect(out.messages).toEqual(TELNYX_BODY.messages);
  });

  it('omits absent fields rather than sending undefined', () => {
    const out = minimalBody({ messages: [] }, 'x');
    expect('tools' in out).toBe(false);
  });
});

describe('withCacheControl', () => {
  const sys = 'x'.repeat(200);
  const body = { messages: [{ role: 'system', content: sys }, { role: 'user', content: 'hi' }] };

  it('adds an Anthropic cache breakpoint on the system prompt', () => {
    // Without this, Haiku re-buys the whole 8,400 token prompt every turn:
    // measured 0 cached across three identical requests. With it, 8,059 of
    // 8,419 come back cached at a tenth of the input rate.
    const out = withCacheControl(body, 'anthropic/claude-haiku-4-5');
    const first = (out.messages as Record<string, unknown>[])[0];
    expect(first.content).toEqual([{ type: 'text', text: sys, cache_control: { type: 'ephemeral' } }]);
  });

  it('leaves the conversation after the system prompt untouched', () => {
    const out = withCacheControl(body, 'anthropic/claude-haiku-4-5');
    expect((out.messages as unknown[])[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('does nothing for a non-Anthropic model, which caches on its own', () => {
    expect(withCacheControl(body, 'MiniMaxAI/MiniMax-M3-MXFP8')).toBe(body);
  });

  it('leaves a system message alone when someone already shaped it', () => {
    const already = { messages: [{ role: 'system', content: [{ type: 'text', text: sys }] }] };
    expect(withCacheControl(already, 'anthropic/claude-haiku-4-5')).toBe(already);
  });

  it('does nothing when the first message is not a system prompt', () => {
    const noSys = { messages: [{ role: 'user', content: 'hi' }] };
    expect(withCacheControl(noSys, 'anthropic/claude-haiku-4-5')).toBe(noSys);
  });

  it('survives an empty or missing messages array', () => {
    expect(withCacheControl({}, 'anthropic/claude-haiku-4-5')).toEqual({});
    expect(withCacheControl({ messages: [] }, 'anthropic/claude-haiku-4-5')).toEqual({ messages: [] });
  });
});
