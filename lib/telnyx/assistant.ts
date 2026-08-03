/**
 * The assistant, defined here rather than clicked into Mission Control.
 *
 * Every field name below was read off Telnyx's live docs on 2026-07-28, not
 * recalled. See AGENTS.md for the list and for the one field a plan asserted
 * that does not exist. The shape returned here IS the request body, so there is
 * no mapping layer between what the tests pin and what the API receives.
 *
 * Two settings do most of the work of not sounding like a phone tree:
 *
 *  - `transcription.model` is Deepgram Flux, a turn-taking model that does
 *    recognition and end-of-turn in one pass. There is no separate VAD to
 *    misfire, which is why no endpointing plan is set alongside it: that plan is
 *    documented for non turn-taking models and would be inert here.
 *  - `interruption_settings.start_speaking_plan.wait_seconds` is the pause
 *    before the agent takes its turn. The default is 0.4. A receptionist comes
 *    back faster than that, so this is 0.3, and Task 14's eval is what says
 *    whether 0.3 cuts real callers off.
 */
// Explicit .ts extensions: scripts/assistant-sync.mts imports this module and
// runs under node directly, whose ESM resolver will not guess an extension.
// Both of these are leaf modules, so the convention stops here.
import { optionalEnv } from '../env.ts';
import { GREETING, keyterms, systemPrompt } from '../agent/brief.ts';

/** The five tools, in the order the prompt introduces them. */
export const TOOL_NAMES = [
  'lookup_invoice',
  'check_order',
  'text_me_the_list',
  'take_message',
  'escalate_to_human',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

/**
 * The one voice on this phone line.
 *
 * It lives here rather than in client.ts because this is the file that documents
 * the `<Provider>.<Model>.<VoiceId>` rule, and both consumers import it: the
 * assistant's `voice_settings.voice`, and the Call Control `speak` command that
 * reads the recording disclosure before the assistant ever starts.
 *
 * They used to be two separate variables with two separate defaults, and the
 * disclosure default was `female`, Telnyx's legacy BASIC engine. A caller heard
 * a robot read a legal notice and then a different, human-sounding person say
 * hello. One function, one default, so they cannot drift apart again.
 */
export function agentVoice(): string {
  return optionalEnv('TELNYX_TTS', 'Telnyx.Bayan.Amanda');
}

/**
 * How fast Robin talks. 1 is the voice's natural pace, below 1 is slower.
 *
 * Down from 1 on Karim's read of a real call (2026-08-03): understandable, but
 * enough faster than a person that a caller has to work to keep up, and a phone
 * line is the one place you cannot ask someone to rewind.
 *
 * `voice_speed` is undocumented, like `interrupt_prediction_threshold`, so a 200
 * from Telnyx proves nothing here and `pnpm assistant:sync` reading it back is
 * what says it stored. Env-overridable because pace is a taste knob and finding
 * the right one should not need a code change; the clamp is there so a typo in
 * .env.local cannot put NaN in the request and fail the sync with a message
 * about some other field.
 */
export function voiceSpeed(): number {
  const parsed = Number(optionalEnv('TELNYX_VOICE_SPEED', '0.9'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0.9;
}

export interface WebhookTool {
  type: 'webhook';
  webhook: {
    name: ToolName;
    description: string;
    url: string;
    method: 'POST';
    headers: { name: string; value: string }[];
    body_parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

export interface AssistantConfig {
  name: string;
  model: string;
  instructions: string;
  greeting: string;
  transcription: {
    model: string;
    settings: {
      keyterm: string;
      /** 0.5-0.9. Confidence needed to call a turn finished. */
      eot_threshold: number;
      /** 500-10000. Silence that forces a turn to end. */
      eot_timeout_ms: number;
      /** 0.3-0.9, and must be <= eot_threshold. See the comment at the value. */
      eager_eot_threshold: number;
    };
  };
  interruption_settings: {
    enable: boolean;
    disable_greeting_interruption: boolean;
    interrupt_prediction_threshold: number;
    start_speaking_plan: { wait_seconds: number };
  };
  telephony_settings: {
    noise_suppression: 'krisp' | 'deepfilternet' | 'disabled';
    /**
     * Undocumented, like interrupt_prediction_threshold, and both are read back
     * by assistant-sync so a field Telnyx drops fails the sync instead of going
     * quiet. Written at their current values rather than changed: neither has
     * any evidence against it, and the point of naming them here is that they
     * stop being whatever Telnyx defaults to next.
     */
    time_limit_secs: number;
    user_idle_reply_secs: number;
    /**
     * The assistant records the call itself unless told not to, and `enabled`
     * DEFAULTS TO TRUE. We already run our own dual-channel `record_start` from
     * the disclosure step, so leaving this alone produced two recordings of
     * every call and two `call.recording.saved` webhooks. There is no per-call
     * override for it; it is only settable on the stored assistant.
     */
    recording_settings: { enabled: boolean };
  };
  /**
   * Voice is nested here, not top level. A top-level `voice` is accepted with a
   * 200 and silently ignored, which is how this shipped voiceless once.
   */
  voice_settings: {
    voice: string;
    /** Also undocumented. 1 is the voice's natural pace; see voiceSpeed(). */
    voice_speed: number;
    background_audio: { type: 'predefined_media'; value: string; volume: number };
  };
  tools: WebhookTool[];
  dynamic_variables_webhook_url: string;
  dynamic_variables_webhook_timeout_ms: number;
}

export interface AssistantConfigDeps {
  /** Public origin Telnyx can reach: the tunnel in dev, the deployment in prod. */
  publicBaseUrl: string;
  /** Shared secret every tool call and context call must present back to us. */
  toolSecret: string;
}

interface ToolSpec {
  name: ToolName;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

/**
 * A webhook tool call arrives carrying only the arguments the model filled in.
 * Telnyx sends no call_control_id, no conversation id, and no caller identity
 * with it, so the only way a tool can act on the right call is for the caller's
 * number to be one of those arguments.
 *
 * The prompt tells the agent to pass `{{telnyx_end_user_target}}` verbatim, and
 * the server resolves it against the call it bound at conversation start. Every
 * tool takes it, including the ones that could technically work without it,
 * because a tool that sometimes needs it and sometimes does not is a tool the
 * model gets wrong half the time.
 */
const CALLER_PHONE = {
  caller_phone: {
    type: 'string',
    description:
      'The number the caller is calling from, in E.164. Always pass the value of telnyx_end_user_target exactly as given to you.',
  },
} as const;

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'lookup_invoice',
    description:
      'Look up one invoice by its number and return whether it is paid. Use only when the caller says an invoice number.',
    properties: {
      ...CALLER_PHONE,
      invoice_number: { type: 'string', description: 'The invoice number the caller said, digits only.' },
    },
    required: ['caller_phone', 'invoice_number'],
  },
  {
    name: 'check_order',
    description: "Look up the caller's most recent order and what is on it.",
    properties: { ...CALLER_PHONE },
    required: ['caller_phone'],
  },
  {
    name: 'text_me_the_list',
    description:
      // Deliberately NOT "asks what we stock" any more. The agent now answers that
      // out loud from the brief, in one sentence of product names, and texting the
      // list instead of answering a question it can answer is worse service.
      'Text the caller our product list and how to get a quote, and put their request in front of the team. Use when the caller wants pricing, wants to order, or asks for something in writing.',
    properties: {
      ...CALLER_PHONE,
      wants: {
        type: 'string',
        description:
          'What the caller said they need, in their own words. Use "the full product list" if they did not name anything.',
      },
      caller_name: { type: 'string', description: 'The caller name, if they gave one.' },
    },
    required: ['caller_phone', 'wants'],
  },
  {
    name: 'take_message',
    description:
      'Save a message for the team with a callback number. Use at the end of any call needing follow-up.',
    properties: {
      ...CALLER_PHONE,
      message: { type: 'string', description: 'What the caller wants, in one or two sentences.' },
      callback_number: {
        type: 'string',
        description: 'The number to call back, confirmed out loud with the caller first.',
      },
      caller_name: { type: 'string', description: 'The caller name, if they gave one.' },
    },
    required: ['caller_phone', 'message', 'callback_number'],
  },
  {
    name: 'escalate_to_human',
    description:
      'Ring the team and connect the caller to a person. Use the moment the caller asks for a human, immediately after they accept your offer of one, or when they are upset or disputing a charge.',
    properties: {
      ...CALLER_PHONE,
      reason: { type: 'string', description: 'Why the caller needs a person, in a few words.' },
    },
    required: ['caller_phone', 'reason'],
  },
];

export function assistantConfig(deps: AssistantConfigDeps): AssistantConfig {
  const tools: WebhookTool[] = TOOL_SPECS.map((spec) => ({
    type: 'webhook',
    webhook: {
      name: spec.name,
      description: spec.description,
      url: `${deps.publicBaseUrl}/api/agent/tools/${spec.name}`,
      method: 'POST',
      headers: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Agent-Secret', value: deps.toolSecret },
      ],
      body_parameters: {
        type: 'object',
        properties: spec.properties,
        required: spec.required,
      },
    },
  }));

  return {
    name: 'Akme line',
    // Latency is the product on a phone line, so this defaults to a native
    // Telnyx-hosted model with no external hop. NEAR AI Cloud stays the default
    // everywhere latency is free (summaries, SMS drafting) and Task 11 measures
    // it here as a custom LLM before this default changes.
    model: optionalEnv('TELNYX_LLM_MODEL', 'anthropic/claude-haiku-4-5'),
    instructions: systemPrompt(),
    greeting: GREETING,
    transcription: {
      model: optionalEnv('TELNYX_STT', 'deepgram/flux'),
      settings: {
        // Comma-separated string, not an array. Same terms the post-call
        // transcript boosts, from the same function, so the two cannot drift.
        keyterm: keyterms().join(','),

        // Left at the Portal default. Lowering it makes the agent commit to a
        // turn ending sooner, which is how you start talking over people, and
        // nothing on a real call has argued for it.
        eot_threshold: 0.8,

        // Down from the 5000 default. This is the silence that forces a turn to
        // end when Flux never gets confident, i.e. exactly the caller who trails
        // off mid-sentence. Five seconds of that reads as a dropped line.
        eot_timeout_ms: 3000,

        // The one that was actually broken. This was sitting at 0.8, equal to
        // eot_threshold, because nothing here ever set it and that is what the
        // API stores by default. Telnyx documents what that means: "Setting both
        // thresholds to the same value effectively disables eager end-of-turn
        // behavior because the system waits for final end-of-turn confirmation
        // before starting LLM processing." So the whole point of running Flux,
        // starting the model early on a speculative end of turn, was off. 0.4 is
        // the Portal default and the value in Telnyx's own example. Speculation
        // that turns out wrong is discarded, so this cannot cut a caller off:
        // the real commit still needs 0.8.
        eager_eot_threshold: 0.4,
      },
    },
    interruption_settings: {
      enable: true,
      // This was false, on the theory that a caller talking over a one-line
      // greeting is telling us what they want. On real calls it was line noise
      // doing the talking: the agent's first sentence on a 58 second call was
      // "I'm not sure I caught that", before the caller had said a word. The
      // greeting is under two seconds. Nobody is kept waiting by protecting it,
      // and `enable: true` above still lets them cut in from then on.
      disable_greeting_interruption: true,
      // Undocumented but real: it is absent from the published docs and the API
      // stores it, defaulting to 0.0, which means off. At 0.4 a caller saying
      // "mm-hm" while the agent talks no longer cuts it off, while a genuine
      // interruption still lands. Read back by assistant-sync, so if Telnyx ever
      // drops the field the sync says so instead of going quiet.
      interrupt_prediction_threshold: 0.4,
      // Down from 0.3, on the Flux guidance: "Flux works best with low start
      // speaking delays, such as 0.1 seconds for wait time". 0.3 was picked as
      // simply-below-the-0.4-default, before the model was Flux.
      start_speaking_plan: { wait_seconds: 0.1 },
    },
    telephony_settings: {
      noise_suppression: 'krisp',
      // Both unchanged, both now ours rather than Telnyx's. 30 minutes is a
      // runaway guard, not a target, and a real call is with a human long before
      // it. 10 seconds of silence before the agent speaks up is the difference
      // between patient and pushy while somebody looks up an address.
      time_limit_secs: 1800,
      user_idle_reply_secs: 10,
      // Off, because our own record_start already covers the whole call. See the
      // field comment above: this defaults to TRUE and was the second recording.
      recording_settings: { enabled: false },
    },
    voice_settings: {
      // Set by the bake-off in Task 6, and shared with the Call Control `speak`
      // that reads the disclosure, so the caller hears one person start to
      // finish. Format is <Provider>.<Model>.<VoiceId>, and the id must exist in
      // GET /v2/text-to-speech/voices.
      voice: agentVoice(),
      voice_speed: voiceSpeed(),
      // "office" room tone was here so a pause during a tool call did not read as
      // a dropped line. On a real call it read as murmuring instead: Karim heard
      // the agent as full of "uhmms", and office ambience is chatter. The trade
      // has also moved, because the common path (products, then route to a quote)
      // makes no slow tool calls, so there is barely a pause left to cover. Set
      // TELNYX_BACKGROUND_AUDIO back to "office" to restore it; tenths only, 0.35
      // is a 400 rather than a rounding.
      background_audio: {
        type: 'predefined_media',
        value: optionalEnv('TELNYX_BACKGROUND_AUDIO', 'silence'),
        volume: 0.3,
      },
    },
    tools,
    dynamic_variables_webhook_url: `${deps.publicBaseUrl}/api/agent/context`,
    // The assistant will not say a word until this webhook answers or this
    // timeout expires, so it is a floor on how long the caller sits in silence
    // after the disclosure. It was 8000, which is what ~10 seconds of dead air
    // was mostly made of. The lookup itself is ~200ms and is now prewarmed at
    // call.answered (see prewarmCallerContext), so this should never be reached;
    // if it is, being greeted as a stranger after 2.5s beats waiting out 8.
    dynamic_variables_webhook_timeout_ms: 2500,
  };
}
