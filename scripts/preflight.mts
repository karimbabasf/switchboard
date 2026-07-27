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
  {
    group: 'Deepgram',
    name: 'API key is valid',
    run: async () => {
      const res = await fetch('https://api.deepgram.com/v1/projects', {
        headers: { authorization: `Token ${env('DEEPGRAM_API_KEY')}` },
      });
      if (!res.ok) return fail(`HTTP ${res.status}`);
      const j = (await res.json()) as { projects: unknown[] };
      return pass(`${j.projects.length} project(s)`);
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
