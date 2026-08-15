import { describe, expect, it } from 'vitest';
import { FORWARD_FIELDS, droppedFields, forwardBody } from '../lib/agent/gateway.ts';

/**
 * The body below is the one Telnyx's assistant actually sends. It is not
 * invented: `stream_options.continuous_usage_stats` is the field that took the
 * phone line down on 2026-08-15, named in the 400 Telnyx inference returned.
 */
const TELNYX_BODY = {
  model: 'MiniMaxAI/MiniMax-M3-MXFP8',
  messages: [{ role: 'user', content: 'What are your hours?' }],
  tools: [{ type: 'function', function: { name: 'text_me_the_list' } }],
  tool_choice: 'auto',
  stream: true,
  stream_options: { include_usage: true, continuous_usage_stats: true },
  extra_metadata: { telnyx_end_user_target: '+14155550184' },
  parallel_tool_calls: true,
  temperature: 0.7,
};

describe('forwardBody', () => {
  it('never forwards the field that killed the line', () => {
    const out = forwardBody(TELNYX_BODY, 'x');
    expect(out.stream_options).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain('continuous_usage_stats');
  });

  it('forwards only the allowlist, whatever else arrives', () => {
    const out = forwardBody(TELNYX_BODY, 'x');
    expect(Object.keys(out).sort()).toEqual(['messages', 'model', 'stream', 'tool_choice', 'tools']);
  });

  it('drops anything new Telnyx starts sending, without being taught it', () => {
    const out = forwardBody({ ...TELNYX_BODY, some_field_invented_next_quarter: true }, 'x');
    expect(out.some_field_invented_next_quarter).toBeUndefined();
  });

  it('overrides the caller-supplied model, so the choice lives in one place', () => {
    expect(forwardBody(TELNYX_BODY, 'anthropic/claude-haiku-4-5').model).toBe('anthropic/claude-haiku-4-5');
  });

  it('keeps the conversation and the tools, which are the whole point', () => {
    const out = forwardBody(TELNYX_BODY, 'x');
    expect(out.messages).toEqual(TELNYX_BODY.messages);
    expect(out.tools).toEqual(TELNYX_BODY.tools);
    expect(out.tool_choice).toBe('auto');
    expect(out.stream).toBe(true);
  });

  it('omits absent fields rather than sending undefined', () => {
    const out = forwardBody({ messages: [] }, 'x');
    expect('tools' in out).toBe(false);
    expect('stream' in out).toBe(false);
  });

  it('reports what it dropped, so drift is visible in the logs', () => {
    expect(droppedFields(TELNYX_BODY).sort()).toEqual([
      'extra_metadata',
      'parallel_tool_calls',
      'stream_options',
      'temperature',
    ]);
  });

  it('has an allowlist that is actually a list of names, not a passthrough', () => {
    expect(FORWARD_FIELDS.length).toBeLessThan(8);
  });
});
