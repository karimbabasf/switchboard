/**
 * Pushes the assistant defined in lib/telnyx/assistant.ts to Telnyx.
 *
 *   pnpm assistant:sync
 *
 * Idempotent by design: running it twice makes exactly one assistant. With
 * TELNYX_ASSISTANT_ID set it updates that one; without, it looks for an
 * assistant already carrying this name before creating anything, because the
 * failure this guards against is a portal full of near-identical assistants
 * where nobody can say which one the phone number is pointed at.
 *
 * Nothing that shapes what the agent says may exist only as a click in Mission
 * Control, so this is the only supported way to change it.
 */
import { assistantConfig } from '../lib/telnyx/assistant.ts';

const BASE = 'https://api.telnyx.com/v2';

function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`\nMissing required env var: ${name}`);
    console.error('Run with: node --env-file=.env.local, which pnpm assistant:sync already does.\n');
    process.exit(1);
  }
  return v.trim();
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env('TELNYX_API_KEY')}`,
      'content-type': 'application/json',
      accept: 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`\nTelnyx ${init.method ?? 'GET'} ${path} failed: ${res.status}`);
    console.error(text.slice(0, 800));
    process.exit(1);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

interface Assistant {
  id: string;
  name: string;
}

const config = assistantConfig({
  publicBaseUrl: env('PUBLIC_BASE_URL').replace(/\/+$/, ''),
  toolSecret: env('AGENT_TOOL_SECRET'),
});

const pinned = process.env.TELNYX_ASSISTANT_ID?.trim();

let id: string;
let action: 'created' | 'updated';

if (pinned) {
  await api<unknown>(`/ai/assistants/${pinned}`, {
    method: 'PATCH',
    body: JSON.stringify(config),
  });
  id = pinned;
  action = 'updated';
} else {
  // No pinned id: find by name before creating, so a second run without the env
  // var set does not quietly produce a duplicate.
  const list = await api<{ data: Assistant[] }>('/ai/assistants');
  const existing = (list.data ?? []).find((a) => a.name === config.name);

  if (existing) {
    await api<unknown>(`/ai/assistants/${existing.id}`, {
      method: 'PATCH',
      body: JSON.stringify(config),
    });
    id = existing.id;
    action = 'updated';
  } else {
    const created = await api<{ id?: string; data?: Assistant }>('/ai/assistants', {
      method: 'POST',
      body: JSON.stringify(config),
    });
    const newId = created.id ?? created.data?.id;
    if (!newId) {
      console.error('\nTelnyx accepted the create but returned no assistant id.');
      console.error(JSON.stringify(created).slice(0, 400));
      process.exit(1);
    }
    id = newId;
    action = 'created';
  }
}

/**
 * Read back what Telnyx actually stored.
 *
 * This exists because Telnyx accepted `voice: "Telnyx.KokoroTTS.af"`, returned
 * 200, and stored null. An invalid voice id is not an error, it is a silently
 * voiceless agent that only shows up on a live call. Anything sent and not
 * stored is worth failing over.
 */
const stored = await api<{ data?: Record<string, unknown> } & Record<string, unknown>>(
  `/ai/assistants/${id}`,
);
const got = (stored.data ?? stored) as Record<string, unknown>;

const interruption = (got.interruption_settings ?? {}) as Record<string, unknown>;
const startPlan = (interruption.start_speaking_plan ?? {}) as Record<string, unknown>;
const transcription = (got.transcription ?? {}) as Record<string, unknown>;
const telephony = (got.telephony_settings ?? {}) as Record<string, unknown>;
const voiceSettings = (got.voice_settings ?? {}) as Record<string, unknown>;

const checks: { name: string; sent: unknown; stored: unknown }[] = [
  { name: 'voice_settings.voice', sent: config.voice_settings.voice, stored: voiceSettings.voice },
  {
    name: 'background_audio',
    sent: config.voice_settings.background_audio.value,
    stored: ((voiceSettings.background_audio ?? {}) as Record<string, unknown>).value,
  },
  { name: 'voice_speed', sent: config.voice_settings.voice_speed, stored: voiceSettings.voice_speed },
  { name: 'model', sent: config.model, stored: got.model },
  { name: 'transcription.model', sent: config.transcription.model, stored: transcription.model },
  ...(['eot_threshold', 'eot_timeout_ms', 'eager_eot_threshold'] as const).map((key) => ({
    // Flux's own turn-taking knobs. eager_eot_threshold is the one worth failing
    // over: at the API default it equals eot_threshold, which Telnyx documents as
    // disabling eager end-of-turn entirely, and nothing about a call sounds
    // broken when that happens. It is just slower, everywhere, forever.
    name: `transcription.settings.${key}`,
    sent: config.transcription.settings[key],
    stored: ((transcription.settings ?? {}) as Record<string, unknown>)[key],
  })),
  {
    name: 'interrupt_prediction_threshold',
    sent: config.interruption_settings.interrupt_prediction_threshold,
    stored: interruption.interrupt_prediction_threshold,
  },
  {
    name: 'start_speaking_plan.wait_seconds',
    sent: config.interruption_settings.start_speaking_plan.wait_seconds,
    stored: startPlan.wait_seconds,
  },
  {
    name: 'noise_suppression',
    sent: config.telephony_settings.noise_suppression,
    stored: telephony.noise_suppression,
  },
  { name: 'time_limit_secs', sent: config.telephony_settings.time_limit_secs, stored: telephony.time_limit_secs },
  {
    name: 'user_idle_reply_secs',
    sent: config.telephony_settings.user_idle_reply_secs,
    stored: telephony.user_idle_reply_secs,
  },
  {
    // The one that produced two recordings and two call.recording.saved webhooks
    // per call. It defaults to true, so "not stored" here means it is still on.
    name: 'recording_settings.enabled',
    sent: config.telephony_settings.recording_settings.enabled,
    stored: ((telephony.recording_settings ?? {}) as Record<string, unknown>).enabled,
  },
  {
    // Line noise interrupting the greeting is what made the agent open with
    // "I'm not sure I caught that" before the caller had spoken.
    name: 'disable_greeting_interruption',
    sent: config.interruption_settings.disable_greeting_interruption,
    stored: interruption.disable_greeting_interruption,
  },
  {
    name: 'dynamic_variables_webhook_url',
    sent: config.dynamic_variables_webhook_url,
    stored: got.dynamic_variables_webhook_url,
  },
  {
    // A floor on the silence between the disclosure and the agent's first word,
    // so a value Telnyx clamped or dropped is worth failing over.
    name: 'dynamic_variables_webhook_timeout_ms',
    sent: config.dynamic_variables_webhook_timeout_ms,
    stored: got.dynamic_variables_webhook_timeout_ms,
  },
  {
    name: 'tools',
    sent: config.tools.length,
    stored: Array.isArray(got.tools) ? got.tools.length : 0,
  },
];

const dropped = checks.filter((c) => c.sent !== c.stored);
if (dropped.length > 0) {
  console.error('\nTelnyx accepted the request but did not store these as sent:');
  for (const d of dropped) {
    console.error(`  ${d.name}: sent ${JSON.stringify(d.sent)}, stored ${JSON.stringify(d.stored)}`);
  }
  console.error('\nA value stored as null usually means it is not a legal value for that field.');
  console.error('For voice, check it against GET /v2/text-to-speech/voices.\n');
  process.exit(1);
}

console.log(`\nAssistant ${action}: ${id}`);
console.log('  every field read back matching what was sent');
console.log(`  name        ${config.name}`);
console.log(`  model       ${config.model}`);
console.log(`  voice       ${config.voice_settings.voice}`);
console.log(`  room tone   ${config.voice_settings.background_audio.value}`);
console.log(`  stt         ${config.transcription.model}`);
console.log(`  wait        ${config.interruption_settings.start_speaking_plan.wait_seconds}s`);
console.log(`  own recording ${config.telephony_settings.recording_settings.enabled ? 'on' : 'off, ours is the only one'}`);
console.log(`  tools       ${config.tools.map((t) => t.webhook.name).join(', ')}`);
console.log(`  context     ${config.dynamic_variables_webhook_url} (${config.dynamic_variables_webhook_timeout_ms}ms)`);

if (!pinned) {
  console.log(`\nPut this in .env.local so later runs update rather than search:`);
  console.log(`TELNYX_ASSISTANT_ID=${id}\n`);
} else {
  console.log('');
}
