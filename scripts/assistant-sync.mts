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

console.log(`\nAssistant ${action}: ${id}`);
console.log(`  name        ${config.name}`);
console.log(`  model       ${config.model}`);
console.log(`  voice       ${config.voice}`);
console.log(`  stt         ${config.transcription.model}`);
console.log(`  wait        ${config.interruption_settings.start_speaking_plan.wait_seconds}s`);
console.log(`  tools       ${config.tools.map((t) => t.webhook.name).join(', ')}`);
console.log(`  context     ${config.dynamic_variables_webhook_url}`);

if (!pinned) {
  console.log(`\nPut this in .env.local so later runs update rather than search:`);
  console.log(`TELNYX_ASSISTANT_ID=${id}\n`);
} else {
  console.log('');
}
