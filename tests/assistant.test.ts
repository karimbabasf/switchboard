import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, assistantConfig } from '../lib/telnyx/assistant';

const BASE = 'https://switchboard.example.com';

function cfg() {
  return assistantConfig({ publicBaseUrl: BASE, toolSecret: 'test-secret' });
}

describe('assistant.ts: the settings that make it feel real', () => {
  it('uses Deepgram Flux, which owns end-of-turn for a turn-taking agent', () => {
    expect(cfg().transcription.model).toMatch(/flux/i);
  });

  it('lets the caller interrupt, which is the whole difference from a phone tree', () => {
    expect(cfg().interruption_settings.enable).toBe(true);
  });

  it('waits a customer-service 0.3s before speaking, not the 0.4s default', () => {
    expect(cfg().interruption_settings.start_speaking_plan.wait_seconds).toBe(0.3);
  });

  it('never carries interrupt_prediction_threshold, which does not exist', () => {
    // The plan for this repo specified this field as the centrepiece setting.
    // It appears nowhere in Telnyx's assistants or calling docs. This test is
    // here so a future pass writing from memory fails instead of shipping a
    // key the API ignores.
    expect(JSON.stringify(cfg())).not.toMatch(/interrupt_prediction/i);
  });

  it('does not set an endpointing plan, which Flux would silently ignore', () => {
    // transcription_endpointing_plan is documented for non turn-taking models.
    // Setting it next to Flux is how you get config that reads as tuned and is
    // doing nothing at all.
    expect(cfg().interruption_settings.start_speaking_plan).not.toHaveProperty(
      'transcription_endpointing_plan',
    );
  });

  it('boosts keyterms as a comma-separated string, not an array', () => {
    const { keyterm } = cfg().transcription.settings;
    expect(typeof keyterm).toBe('string');
    expect(keyterm).toContain('Cushion Wrap');
    expect(keyterm).toContain('Akme');
  });

  it('turns noise suppression on, because STT accuracy is downstream of it', () => {
    expect(cfg().telephony_settings.noise_suppression).toBe('krisp');
  });

  it('registers escalate_to_human as a webhook tool, not a Telnyx transfer', () => {
    const tools = cfg().tools;
    expect(tools.map((t) => t.webhook.name)).toContain('escalate_to_human');
    expect(tools.every((t) => t.type === 'webhook')).toBe(true);
    // A Telnyx `handoff` or `transfer` tool would bypass the ring group, the
    // wave ordering, and the voicemail fallback we already have under test.
    expect(JSON.stringify(tools)).not.toMatch(/"type":\s*"(handoff|transfer)"/);
  });

  it('points every tool at our own app and carries the shared secret', () => {
    for (const tool of cfg().tools) {
      expect(tool.webhook.url.startsWith(`${BASE}/api/agent/tools/`)).toBe(true);
      expect(tool.webhook.method).toBe('POST');
      const secret = tool.webhook.headers.find((h) => h.name.toLowerCase() === 'x-agent-secret');
      expect(secret?.value).toBe('test-secret');
    }
  });

  it('registers exactly the four tools the prompt tells the agent it has', () => {
    expect(cfg().tools.map((t) => t.webhook.name)).toEqual([...TOOL_NAMES]);
  });

  it('makes every tool take caller_phone, since Telnyx sends no call identity', () => {
    // A tool call arrives as the bare arguments object. Nothing in it says which
    // call it came from, so the caller number has to be an argument or the
    // server is guessing.
    for (const tool of cfg().tools) {
      expect(tool.webhook.body_parameters.properties).toHaveProperty('caller_phone');
      expect(tool.webhook.body_parameters.required).toContain('caller_phone');
    }
  });

  it('asks for caller context with a timeout that survives a cold start', () => {
    expect(cfg().dynamic_variables_webhook_url).toBe(`${BASE}/api/agent/context`);
    expect(cfg().dynamic_variables_webhook_timeout_ms).toBeGreaterThanOrEqual(5000);
  });

  it('carries the greeting and the prompt from the brief, not a second copy', () => {
    expect(cfg().greeting).toContain('Akme');
    expect(cfg().instructions).toContain('escalate_to_human');
  });
});
