import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, assistantConfig } from '../lib/telnyx/assistant';
import { GREETING, systemPrompt } from '../lib/agent/brief';

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

  it('runs with no room tone, because office ambience sounded like the agent mumbling', () => {
    // This assertion used to be the exact opposite, and the reason it flipped is
    // worth keeping: "office" was chosen so a pause during a tool call would not
    // read as a dropped line, but on a real call Karim heard it as the agent
    // being full of "uhmms". Office ambience is chatter. The trade also moved,
    // since the common path (products, then route to a quote) makes no slow tool
    // calls, so there is barely a pause left to cover.
    expect(cfg().voice_settings.background_audio.value).toBe('silence');
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

  it('registers exactly the tools the prompt tells the agent it has', () => {
    expect(cfg().tools.map((t) => t.webhook.name)).toEqual([...TOOL_NAMES]);
    expect(TOOL_NAMES).toContain('text_me_the_list');
    for (const name of TOOL_NAMES) expect(cfg().instructions).toContain(name);
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

  it('asks for caller context with a timeout the caller could sit through', () => {
    // This is a FLOOR on silence: the assistant says nothing until the webhook
    // answers or this expires. It was 8000, and it was most of the ten seconds
    // of dead air callers heard. The lookup is prewarmed at call.answered now,
    // so being greeted as a stranger after 2.5s is the worst case, not the norm.
    expect(cfg().dynamic_variables_webhook_url).toBe(`${BASE}/api/agent/context`);
    expect(cfg().dynamic_variables_webhook_timeout_ms).toBeLessThanOrEqual(3000);
  });

  it('protects the greeting from being interrupted by line noise', () => {
    // The first line of a real 58 second call was "I'm not sure I caught that",
    // before the caller had spoken: the greeting was interruptible and the agent
    // answered the noise that interrupted it.
    expect(cfg().interruption_settings.disable_greeting_interruption).toBe(true);
    // Everything after the greeting is still interruptible, which is the whole
    // difference between this and a phone tree.
    expect(cfg().interruption_settings.enable).toBe(true);
  });

  it('does not let the assistant record alongside our own record_start', () => {
    // recording_settings.enabled DEFAULTS TO TRUE, which is why every call
    // produced two recordings and fired call.recording.saved twice. There is no
    // per-call override; it only exists on the stored assistant.
    expect(cfg().telephony_settings.recording_settings.enabled).toBe(false);
    expect(cfg().telephony_settings.noise_suppression).toBe('krisp');
  });

  it('carries the greeting and the prompt from the brief, not a second copy', () => {
    expect(cfg().greeting).toBe(GREETING);
    expect(cfg().instructions).toBe(systemPrompt());
    expect(cfg().instructions).toContain('escalate_to_human');
  });
});
