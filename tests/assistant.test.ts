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

  it('turns interruption prediction on, which is off by default', () => {
    // Undocumented, but real: absent from Telnyx's published docs and stored by
    // the API, defaulting to 0.0 (off). Confirmed by reading an assistant back
    // on 2026-07-28. At 0.4 a backchannel "mm-hm" no longer cuts the agent off.
    expect(cfg().interruption_settings.interrupt_prediction_threshold).toBe(0.4);
  });

  it('nests the voice under voice_settings, where the API actually reads it', () => {
    // A top-level `voice` is accepted with a 200 and ignored. This assistant ran
    // voiceless once because of exactly that.
    expect(cfg()).not.toHaveProperty('voice');
    expect(cfg().voice_settings.voice).toBeTruthy();
  });

  it('keeps room tone under the call, so a tool call is not dead air', () => {
    expect(cfg().voice_settings.background_audio.value).not.toBe('silence');
  });

  it('names a voice in the provider.model.id shape the API requires', () => {
    // An unknown voice id is accepted with a 200 and stored as null, so the
    // shape is the only thing testable offline; assistant-sync reads the value
    // back and fails if Telnyx dropped it.
    expect(cfg().voice_settings.voice).toMatch(/^[A-Za-z]+\.[A-Za-z0-9]+\.[A-Za-z0-9-]+$/);
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
