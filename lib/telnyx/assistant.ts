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

/** The four tools, in the order the prompt introduces them. */
export const TOOL_NAMES = [
  'lookup_invoice',
  'check_order',
  'take_message',
  'escalate_to_human',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

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
  transcription: { model: string; settings: { keyterm: string } };
  interruption_settings: {
    enable: boolean;
    disable_greeting_interruption: boolean;
    start_speaking_plan: { wait_seconds: number };
  };
  telephony_settings: { noise_suppression: 'krisp' | 'deepfilternet' | 'disabled' };
  voice: string;
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

const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'lookup_invoice',
    description:
      'Look up one invoice by its number and return whether it is paid. Use only when the caller says an invoice number.',
    properties: {
      invoice_number: { type: 'string', description: 'The invoice number the caller said, digits only.' },
    },
    required: ['invoice_number'],
  },
  {
    name: 'check_order',
    description: "Look up the caller's most recent order and what is on it.",
    properties: {
      phone: {
        type: 'string',
        description: 'The caller phone number in E.164. Defaults to the number they are calling from.',
      },
    },
    required: [],
  },
  {
    name: 'take_message',
    description:
      'Save a message for the team with a callback number. Use at the end of any call needing follow-up.',
    properties: {
      message: { type: 'string', description: 'What the caller wants, in one or two sentences.' },
      callback_number: {
        type: 'string',
        description: 'The number to call back, confirmed out loud with the caller first.',
      },
      caller_name: { type: 'string', description: 'The caller name, if they gave one.' },
    },
    required: ['message', 'callback_number'],
  },
  {
    name: 'escalate_to_human',
    description:
      'Ring the team and connect the caller to a person. Use the moment the caller asks for a human, sounds upset, or asks something outside your instructions.',
    properties: {
      reason: { type: 'string', description: 'Why the caller needs a person, in a few words.' },
    },
    required: ['reason'],
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
      // Comma-separated string, not an array. Same terms the post-call
      // transcript boosts, from the same function, so the two cannot drift.
      settings: { keyterm: keyterms().join(',') },
    },
    interruption_settings: {
      enable: true,
      // The recording and AI disclosure is spoken by our own Call Control
      // `speak` before the assistant ever starts, so it is already protected.
      // This greeting is one short line, and a caller who talks over it is
      // telling us what they want. Letting them is the human behaviour.
      disable_greeting_interruption: false,
      start_speaking_plan: { wait_seconds: 0.3 },
    },
    telephony_settings: { noise_suppression: 'krisp' },
    // Set by the bake-off in Task 6. Kept in env so changing the voice is not a
    // code change. Format is <Provider>.<Model>.<VoiceId>.
    voice: optionalEnv('TELNYX_TTS', 'Telnyx.KokoroTTS.af'),
    tools,
    dynamic_variables_webhook_url: `${deps.publicBaseUrl}/api/agent/context`,
    // Default is 1500ms, which is tight for a cold serverless function. If this
    // times out the agent greets a known customer as a stranger.
    dynamic_variables_webhook_timeout_ms: 8000,
  };
}
