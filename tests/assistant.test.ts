import { describe, expect, it } from 'vitest';
import { TOOL_NAMES, assistantConfig } from '../lib/telnyx/assistant';
import { BUSINESS, GREETING, keyterms, systemPrompt } from '../lib/agent/brief';

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

  it('waits 0.1s before speaking, the delay Flux is documented to want', () => {
    // Was 0.3, chosen only as below-the-0.4-default and before the model was
    // Flux. Telnyx: "Flux works best with low start speaking delays, such as 0.1
    // seconds for wait time and endpointing plan thresholds."
    expect(cfg().interruption_settings.start_speaking_plan.wait_seconds).toBe(0.1);
  });

  it('keeps eager end-of-turn strictly below the final one, or it does nothing', () => {
    // The whole reason Flux is here. Telnyx: "Setting both thresholds to the
    // same value effectively disables eager end-of-turn behavior because the
    // system waits for final end-of-turn confirmation before starting LLM
    // processing." Both sat at 0.8 for a week because nothing sent either.
    const { eot_threshold, eager_eot_threshold, eot_timeout_ms } = cfg().transcription.settings;
    expect(eager_eot_threshold).toBeLessThan(eot_threshold);
    expect(eot_threshold).toBeGreaterThanOrEqual(0.5); // documented range is 0.5-0.9
    expect(eot_threshold).toBeLessThanOrEqual(0.9);
    expect(eager_eot_threshold).toBeGreaterThanOrEqual(0.3); // documented range is 0.3-0.9
    expect(eot_timeout_ms).toBeGreaterThanOrEqual(500); // documented range is 500-10000
    expect(eot_timeout_ms).toBeLessThanOrEqual(10_000);
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
    expect(keyterm).toContain('Akme');
    // READ OFF THE DATA, NOT TYPED. This asserted the literal 'Cushion Wrap' and
    // survived the 2026-08-18 rename to 'Bubble Cushion Wrap' by accident, on a
    // substring match, which is a test that stops testing without failing. Every
    // form of every product now has to be in the boost, in the same order.
    expect(keyterm.split(',')).toEqual(keyterms());
    for (const product of BUSINESS.products) {
      expect(keyterm).toContain(product.name);
      expect(keyterm).toContain(product.spokenName);
    }
  });

  it('caps how long the caller waits on the caller-context webhook', () => {
    // This is the floor on silence between the disclosure ending and the agent
    // speaking, because the assistant says nothing until the webhook answers or
    // this expires. 8000, then 2500, now 1200: the prewarm that justified 2500
    // caches in the /api/voice process and the webhook lands on /api/agent/context,
    // which is a different Vercel function, so in production the prewarm misses
    // and the ceiling is what the caller actually hears. Karim, 2026-08-18: "not
    // wait like 7 seconds."
    expect(cfg().dynamic_variables_webhook_timeout_ms).toBeLessThanOrEqual(1200);
    // And not so low that a warm lookup cannot finish, which would greet every
    // regular customer as a stranger to save nothing.
    expect(cfg().dynamic_variables_webhook_timeout_ms).toBeGreaterThanOrEqual(500);
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

  it('stores NO greeting, because the rendered opener already asks the question', () => {
    // The regression this pins, off a real call on 2026-08-19 20:07: the agent
    // is started with `greeting: ''` so it can boot behind the disclosure in
    // silence, Telnyx read the empty string as an omitted field, fell back to
    // the STORED greeting, and the assistant said "How can I help you today?"
    // 1.6 seconds into a legal notice that ends with the same sentence. Two
    // voices at once, then the question twice.
    //
    // An empty stored greeting is the only version of this that cannot break:
    // there is nothing to fall back to. GREETING is still the tail of the
    // rendered opener and is still quoted to the model, which the brief tests
    // pin; it just is not a field on the assistant.
    expect(cfg().greeting).toBe('');
    expect(cfg().greeting).not.toContain(GREETING);
    expect(cfg().instructions).toBe(systemPrompt());
    expect(cfg().instructions).toContain('escalate_to_human');
  });

  it('runs Haiku, and says so in code rather than in one machine\'s .env.local', () => {
    // The bug this pins, found 2026-08-11 by reading the LIVE assistant back:
    // the model answering the phone was moonshotai/Kimi-K2.6, set in .env.local
    // and nowhere else. Every comment in this repo said Haiku, `pnpm rehearse`
    // scored Haiku, and the thing customers actually spoke to was neither.
    //
    // Kimi is tuned to sound conversational and achieves it by performing
    // hesitation: "uhm", trailing off, long run-on turns. That is most of what
    // Karim heard as unprofessional. On a supply company's line, following the
    // instructions beats sounding natural.
    delete process.env.TELNYX_LLM_MODEL;
    expect(cfg().model).toBe('anthropic/claude-haiku-4-5');
  });

  it('runs the voice at its natural pace, because a big stretch is audible', () => {
    // 0.85 until 2026-08-14, when the voice changed to Telnyx.Natural.abbie and
    // the number had to move with it. voice_speed is a MULTIPLIER on a pace each
    // voice picks for itself, so it does not transfer between voices. Measured
    // on the real opener at 8kHz: Amanda at 0.85 runs 7.40s, abbie at 0.85 runs
    // 6.44s, and Karim's complaint was an opener arriving in 5.85s. Keeping 0.85
    // through the voice change would have handed back most of the fix while
    // every config file still said it was applied. 0.70 puts abbie at 7.22s.
    // Back to 1 on 2026-08-14. abbie needed 0.70 to hit the approved pace and
    // Karim's verdict on the result was "so down-pitched, as if the voice were slowed down". Pitch measured flat (246Hz at 1.0, 258Hz at 0.70), so what he heard
    // was a 30 percent time stretch. The voice was then re-picked for having the
    // right pace already, so a number far from 1 here is now a smell that the
    // wrong voice was chosen, not a pace that needs tuning.
    delete process.env.TELNYX_VOICE_SPEED;
    expect(cfg().voice_settings.voice_speed).toBe(1);
  });

  it('answers in an English-first voice, not the Arabic model', () => {
    // Telnyx.Bayan is the Arabic model: 13 Arabic dialects, a few English
    // speakers on the side, 16kHz native. It answered this phone from day one
    // because half the 2026-07-28 bake-off candidates were Bayan. Karim, off a
    // test call on 2026-08-14: "no understanding of commas or punctuation".
    //
    // THE EXACT ID IS NO LONGER PINNED, and the reason is the failure this test
    // had on 2026-08-18: it asserted `Telnyx.NaturalHD.luna`, Telnyx deleted the
    // entire NaturalHD tier, and the assertion still passed because the default
    // it was checking was the dead string. A sync then failed with 400 "Voice
    // not found", and the live assistant was found still storing that dead id.
    // So the test was green about a voice nobody could hear.
    //
    // A unit test cannot tell whether an id resolves; only the API can, and
    // `pnpm assistant:sync` reads the assistant back and fails when Telnyx drops
    // a field, which is the check that actually catches this. What is worth
    // pinning here is the PROPERTY the note above is about: English-first, and
    // not the Arabic model.
    delete process.env.TELNYX_TTS;
    const voice = cfg().voice_settings.voice;
    expect(voice).not.toMatch(/Bayan/);
    expect(voice).toMatch(/^Telnyx\./);
    // Not a placeholder, not empty, and not a tier that has since been removed
    // without anybody updating this file: a real three-part id.
    expect(voice.split('.').length).toBeGreaterThanOrEqual(3);
  });
});
