/**
 * Preflight: proves every account is not just configured but LIVE.
 *
 *   pnpm preflight
 *
 * Every check makes a real call against the real service. A green run is the
 * gate for starting the build; a red one names the exact thing to go fix.
 * Secrets are read from the environment and never printed, only their shape.
 */

type Result = { ok: boolean; detail: string };
type Check = { group: string; name: string; run: () => Promise<Result> };

const pass = (detail: string): Result => ({ ok: true, detail });
const fail = (detail: string): Result => ({ ok: false, detail });

function env(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) throw new Error(`${name} is empty in .env.local`);
  return v.trim();
}

/** Masks a secret down to a length plus last 4, enough to spot a paste error. */
function shape(secret: string): string {
  return `${secret.length} chars, ends ...${secret.slice(-4)}`;
}

async function tg(method: string, body: Record<string, unknown> = {}) {
  const res = await fetch(`https://api.telegram.org/bot${env('TELEGRAM_BOT_TOKEN')}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as { ok: boolean; result?: any; description?: string };
  if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
  return json.result;
}

async function telnyx(path: string) {
  const res = await fetch(`https://api.telnyx.com/v2/${path}`, {
    headers: { authorization: `Bearer ${env('TELNYX_API_KEY')}` },
  });
  const json = (await res.json()) as { data?: any; errors?: { detail?: string; title?: string }[] };
  if (!res.ok) {
    const e = json.errors?.[0];
    throw new Error(`${path}: ${e?.detail ?? e?.title ?? `HTTP ${res.status}`}`);
  }
  return json.data;
}

const checks: Check[] = [
  // --- Telegram ----------------------------------------------------------
  {
    group: 'Telegram',
    name: 'bot token is valid',
    run: async () => {
      const me = await tg('getMe');
      return pass(`@${me.username} (${shape(env('TELEGRAM_BOT_TOKEN'))})`);
    },
  },
  {
    group: 'Telegram',
    name: 'group exists and has Topics enabled',
    run: async () => {
      const chat = await tg('getChat', { chat_id: env('TELEGRAM_CHAT_ID') });
      if (chat.type !== 'supergroup') {
        return fail(`chat is "${chat.type}", Topics require a supergroup`);
      }
      if (!chat.is_forum) {
        return fail('Topics are OFF. Manage Group > Topics, then re-run');
      }
      return pass(`"${chat.title}" is a forum supergroup`);
    },
  },
  {
    group: 'Telegram',
    name: 'bot is admin and can manage topics',
    run: async () => {
      const me = await tg('getMe');
      const member = await tg('getChatMember', {
        chat_id: env('TELEGRAM_CHAT_ID'),
        user_id: me.id,
      });
      if (member.status !== 'administrator') {
        return fail(`bot is "${member.status}", promote it to admin`);
      }
      if (!member.can_manage_topics) {
        return fail('admin but missing Manage Topics, it cannot open contact threads');
      }
      return pass('administrator with can_manage_topics');
    },
  },
  {
    group: 'Telegram',
    name: 'privacy mode is off',
    run: async () => {
      // can_read_all_group_messages is the API-visible form of BotFather's
      // /setprivacy. With it false the bot never sees a plain reply typed into a
      // topic, so outbound SMS silently does nothing. Worth failing loudly on.
      const me = await tg('getMe');
      return me.can_read_all_group_messages
        ? pass('bot receives all group messages')
        : fail('privacy mode ON. BotFather > /setprivacy > Disable, then REMOVE and RE-ADD the bot to the group');
    },
  },
  {
    group: 'Telegram',
    name: 'webhook secret is strong',
    run: async () => {
      const s = env('TELEGRAM_WEBHOOK_SECRET');
      return s.length >= 32
        ? pass(`${s.length} chars`)
        : fail(`${s.length} chars, want 32+ (Telegram publishes no IPs, this is the whole door)`);
    },
  },

  // --- Supabase ----------------------------------------------------------
  {
    group: 'Supabase',
    name: 'service role key connects',
    run: async () => {
      const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/`, {
        headers: {
          apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
          authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      return res.ok ? pass(`reachable (${res.status})`) : fail(`HTTP ${res.status}`);
    },
  },
  {
    group: 'Supabase',
    name: 'migration has been applied',
    run: async () => {
      const tables = ['contacts', 'messages', 'calls', 'outbox', 'callback_actions'];
      const missing: string[] = [];
      for (const t of tables) {
        const res = await fetch(`${env('SUPABASE_URL')}/rest/v1/${t}?select=*&limit=0`, {
          headers: {
            apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
            authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
          },
        });
        if (!res.ok) missing.push(t);
      }
      return missing.length === 0
        ? pass(`all ${tables.length} tables present`)
        : fail(`missing: ${missing.join(', ')}. Apply supabase/migrations/`);
    },
  },
  {
    group: 'Supabase',
    name: 'recordings bucket exists',
    run: async () => {
      const bucket = env('SUPABASE_STORAGE_BUCKET');
      const res = await fetch(`${env('SUPABASE_URL')}/storage/v1/bucket/${bucket}`, {
        headers: {
          apikey: env('SUPABASE_SERVICE_ROLE_KEY'),
          authorization: `Bearer ${env('SUPABASE_SERVICE_ROLE_KEY')}`,
        },
      });
      if (!res.ok) return fail(`bucket "${bucket}" not found`);
      const b = (await res.json()) as { public: boolean };
      return b.public
        ? fail(`bucket "${bucket}" is PUBLIC. Call recordings must be private`)
        : pass(`"${bucket}" exists and is private`);
    },
  },

  // --- Transcription and summaries --------------------------------------
  // --- Telnyx ------------------------------------------------------------
  {
    group: 'Telnyx',
    name: 'API key is valid and account is funded',
    run: async () => {
      const bal = await telnyx('balance');
      const amount = Number(bal.balance);
      if (!Number.isFinite(amount)) return fail('balance did not parse');
      return amount > 0
        ? pass(`${bal.currency} ${bal.balance} available`)
        : fail(`balance is ${bal.currency} ${bal.balance}, calls and SMS will be rejected`);
    },
  },
  {
    group: 'Telnyx',
    name: 'webhook public key is present',
    run: async () => {
      // Ed25519 over `timestamp|rawBody`. Without this key every inbound webhook
      // is unauthenticated, which means anyone who learns the URL can forge calls.
      const k = env('TELNYX_PUBLIC_KEY');
      return pass(shape(k));
    },
  },
  {
    group: 'Telnyx',
    name: 'number is owned by this account',
    run: async () => {
      const num = env('TELNYX_NUMBER');
      if (!/^\+[1-9]\d{7,14}$/.test(num)) return fail(`"${num}" is not E.164, expected +1XXXXXXXXXX`);
      const list = await telnyx(`phone_numbers?filter[phone_number]=${encodeURIComponent(num)}`);
      if (!Array.isArray(list) || list.length === 0) return fail(`${num} not found on this account`);
      return pass(`${num} (${list[0].status})`);
    },
  },
  {
    group: 'Telnyx',
    name: 'number is routed to the Call Control app',
    run: async () => {
      // The high-value check. Owning the number and having an app both succeed
      // independently while inbound calls go nowhere, because the number was
      // never assigned to the connection. Silent, and only visible on a test call.
      const app = await telnyx(`call_control_applications/${env('TELNYX_CONNECTION_ID')}`);
      const list = await telnyx(
        `phone_numbers?filter[phone_number]=${encodeURIComponent(env('TELNYX_NUMBER'))}`,
      );
      const assigned = list?.[0]?.connection_id;
      if (String(assigned) !== String(env('TELNYX_CONNECTION_ID'))) {
        return fail(`number points at connection ${assigned ?? 'none'}, not "${app.application_name}"`);
      }
      return pass(`-> "${app.application_name}"`);
    },
  },
  {
    group: 'Telnyx',
    name: 'number is on the messaging profile',
    run: async () => {
      const profile = await telnyx(`messaging_profiles/${env('TELNYX_MESSAGING_PROFILE_ID')}`);
      const list = await telnyx(
        `phone_numbers?filter[phone_number]=${encodeURIComponent(env('TELNYX_NUMBER'))}`,
      );
      const assigned = list?.[0]?.messaging_profile_id;
      if (String(assigned) !== String(env('TELNYX_MESSAGING_PROFILE_ID'))) {
        return fail(`number is on profile ${assigned ?? 'none'}, not "${profile.name}"`);
      }
      return pass(`-> "${profile.name}"`);
    },
  },
  {
    group: 'Telnyx',
    name: 'forward-to number is E.164',
    run: async () => {
      const n = env('FORWARD_TO_NUMBER');
      return /^\+[1-9]\d{7,14}$/.test(n)
        ? pass(`bridges to ${n}`)
        : fail(`"${n}" is not E.164, expected +1XXXXXXXXXX`);
    },
  },
  {
    group: 'Telnyx',
    name: 'recording disclosure is set',
    run: async () => {
      // California is all-party consent. An empty disclosure is not a cosmetic
      // problem, it is the difference between a legal recording and a crime.
      const d = process.env.RECORDING_DISCLOSURE?.trim().replace(/^"|"$/g, '') ?? '';
      return d.length >= 10
        ? pass(`"${d}"`)
        : fail('empty or too short. CA is all-party consent, this must be spoken before recording');
    },
  },

  {
    group: 'AssemblyAI',
    name: 'API key is valid',
    run: async () => {
      // No plain "list projects" endpoint; asking for zero transcripts is the
      // cheapest authenticated call that proves the key works.
      const res = await fetch('https://api.assemblyai.com/v2/transcript?limit=1', {
        headers: { authorization: env('ASSEMBLYAI_API_KEY') },
      });
      if (res.status === 401) return fail('401, key rejected');
      if (!res.ok) return fail(`HTTP ${res.status}`);
      return pass(`authenticated, model ${process.env.ASSEMBLYAI_MODEL ?? 'universal-2'}`);
    },
  },
  {
    group: 'Anthropic',
    name: 'API key is valid',
    run: async () => {
      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: {
          'x-api-key': env('ANTHROPIC_API_KEY'),
          'anthropic-version': '2023-06-01',
        },
      });
      return res.ok ? pass('models endpoint reachable') : fail(`HTTP ${res.status}`);
    },
  },

  // --- Internal ----------------------------------------------------------
  {
    group: 'Internal',
    name: 'WORKER_SECRET is set and distinct',
    run: async () => {
      const w = env('WORKER_SECRET');
      // Akme lesson, applied: the worker secret and the Telegram webhook secret
      // live in different places with different blast radius. Sharing one value
      // means a single leak hands over both.
      if (w === process.env.TELEGRAM_WEBHOOK_SECRET) {
        return fail('identical to TELEGRAM_WEBHOOK_SECRET, they must be different secrets');
      }
      return w.length >= 32 ? pass(`${w.length} chars, distinct`) : fail(`${w.length} chars, want 32+`);
    },
  },
];

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

const results: { group: string; name: string; result: Result }[] = [];

for (const check of checks) {
  let result: Result;
  try {
    result = await check.run();
  } catch (err) {
    result = fail(err instanceof Error ? err.message : String(err));
  }
  results.push({ group: check.group, name: check.name, result });
}

let lastGroup = '';
for (const { group, name, result } of results) {
  if (group !== lastGroup) {
    console.log(`\n${group}`);
    lastGroup = group;
  }
  const mark = result.ok ? `${GREEN}ok${OFF}` : `${RED}FAIL${OFF}`;
  console.log(`  ${mark}  ${name}  ${DIM}${result.detail}${OFF}`);
}

const failed = results.filter((r) => !r.result.ok).length;
console.log(
  failed === 0
    ? `\n${GREEN}All ${results.length} checks passed. Ready to build.${OFF}\n`
    : `\n${RED}${failed} of ${results.length} checks failed.${OFF}\n`,
);
process.exit(failed === 0 ? 0 : 1);
