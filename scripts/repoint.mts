/**
 * Repoints the whole system at a new public origin.
 *
 * The phone line can run from a local machine behind a cloudflared quick tunnel, and
 * a quick tunnel's hostname is random per start and dies on its own. When it
 * changes, FOUR separate places still point at the old one and the line is down
 * until every one of them is corrected: the disclosure plays, or the call is
 * never answered at all, and nothing says why. That used to be a manual runbook
 * checklist, which is a checklist run at the exact moment somebody is annoyed the
 * phone is broken. This is that checklist as one command.
 *
 *   pnpm repoint https://something-new.trycloudflare.com
 *
 * The pg_cron worker job is deliberately NOT in the list any more. It used to
 * carry the URL inline, so repointing meant rewriting a SQL command that also
 * contains the worker secret. It now reads `switchboard_settings.public_base_url`
 * instead, so this script updates one row and the job follows.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { promises as dns } from 'node:dns';
import https from 'node:https';

/**
 * Probes the origin over IPv4 resolved directly from DNS, deliberately bypassing
 * the system resolver.
 *
 * On some machines, `getaddrinfo` returns AAAA-only records for *.trycloudflare.com
 * while the machine has no IPv6 default route, so curl, `fetch`, and anything
 * else using the system resolver fail instantly with "could not resolve host" on
 * a tunnel that is completely healthy. `dig` sees the A records fine, and so does
 * Telnyx, which is what actually matters. Without this the probe below would
 * block every repoint on a purely local DNS quirk.
 */
function probeStatus(origin: string, path: string): Promise<number> {
  const url = new URL(path, origin);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        servername: url.hostname, // TLS SNI still has to be the name, not the IP
        headers: { 'content-type': 'application/json' },
        timeout: 20_000,
        // Node calls lookup with `{all: true}` under autoSelectFamily (on by
        // default since 20) and then expects an ARRAY of {address, family}.
        // Returning a bare string there fails as "Invalid IP address: undefined",
        // so both shapes have to be handled.
        lookup: ((host: string, opts: { all?: boolean }, cb: (...args: unknown[]) => void) =>
          void dns.resolve4(host).then(
            (addrs) => {
              if (addrs.length === 0) return cb(new Error(`no A record for ${host}`), '', 0);
              return opts.all
                ? cb(null, addrs.map((address) => ({ address, family: 4 })))
                : cb(null, addrs[0], 4);
            },
            (err: Error) => cb(err, '', 0),
          )) as unknown as undefined,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => req.destroy(new Error('timed out after 20s')));
    req.on('error', reject);
    req.end('{}');
  });
}

const ENV_FILE = new URL('../.env.local', import.meta.url);

function need(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`${name} is not set in .env.local`);
  return v;
}

/** Telnyx and Supabase both reject a trailing slash by building `//api/...` paths. */
function normalise(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`"${raw}" is not a URL`);
  }
  if (url.protocol !== 'https:') throw new Error('the origin must be https, Telnyx will not post to http');
  if (url.pathname !== '/') throw new Error('pass the bare origin, no path');
  return url.origin;
}

async function telnyxPatch(path: string, body: object): Promise<void> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${need('TELNYX_API_KEY')}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`telnyx PATCH ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function telnyxGet(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.telnyx.com/v2${path}`, {
    headers: { authorization: `Bearer ${need('TELNYX_API_KEY')}` },
  });
  if (!res.ok) throw new Error(`telnyx GET ${path}: ${res.status}`);
  return ((await res.json()) as { data: Record<string, unknown> }).data;
}

async function main(): Promise<void> {
  const target = normalise(process.argv[2] ?? '');
  console.log(`Repointing everything at ${target}\n`);

  // Probed first, because pointing four services at a dead origin is strictly
  // worse than leaving them on the old one: at least the old one fails loudly in
  // one place. 403 is the expected answer, it means the route ran and rejected an
  // unsigned request, which is exactly what a stranger should get.
  const status = await probeStatus(target, '/api/voice').catch((err: Error) => {
    throw new Error(`${target} is not reachable: ${err.message}`);
  });
  if (status !== 403) {
    throw new Error(`${target}/api/voice answered ${status}, expected 403. Is \`next dev\` up on :3000?`);
  }
  console.log('  ok  origin is live and rejecting unsigned requests (403)');

  const env = await readFile(ENV_FILE, 'utf8');
  if (!/^PUBLIC_BASE_URL=.*$/m.test(env)) throw new Error('.env.local has no PUBLIC_BASE_URL line to replace');
  await writeFile(ENV_FILE, env.replace(/^PUBLIC_BASE_URL=.*$/m, `PUBLIC_BASE_URL=${target}`));
  console.log('  ok  .env.local PUBLIC_BASE_URL');

  await telnyxPatch(`/call_control_applications/${need('TELNYX_CONNECTION_ID')}`, {
    webhook_event_url: `${target}/api/voice`,
  });
  console.log('  ok  Telnyx Call Control app -> /api/voice');

  await telnyxPatch(`/messaging_profiles/${need('TELNYX_MESSAGING_PROFILE_ID')}`, {
    webhook_url: `${target}/api/sms`,
  });
  console.log('  ok  Telnyx messaging profile -> /api/sms');

  // Upsert, not update: on a fresh database the row does not exist yet and a
  // silent zero-row update would leave the worker calling `null || '/api/worker'`.
  const supa = await fetch(`${need('SUPABASE_URL')}/rest/v1/switchboard_settings`, {
    method: 'POST',
    headers: {
      apikey: need('SUPABASE_SERVICE_ROLE_KEY'),
      authorization: `Bearer ${need('SUPABASE_SERVICE_ROLE_KEY')}`,
      'content-type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify({ key: 'public_base_url', value: target }),
  });
  if (!supa.ok) throw new Error(`supabase settings upsert: ${supa.status} ${(await supa.text()).slice(0, 300)}`);
  console.log('  ok  switchboard_settings.public_base_url (the pg_cron worker follows this)');

  // Read back rather than trust the 200s. Telnyx in particular will accept a
  // field it does not recognise and store nothing, which is the whole reason
  // assistant-sync exists, and the same caution is cheap here.
  const [cc, mp] = await Promise.all([
    telnyxGet(`/call_control_applications/${need('TELNYX_CONNECTION_ID')}`),
    telnyxGet(`/messaging_profiles/${need('TELNYX_MESSAGING_PROFILE_ID')}`),
  ]);
  const bad = [
    cc.webhook_event_url === `${target}/api/voice` ? null : `call control app is ${String(cc.webhook_event_url)}`,
    mp.webhook_url === `${target}/api/sms` ? null : `messaging profile is ${String(mp.webhook_url)}`,
  ].filter(Boolean);
  if (bad.length) throw new Error(`read-back disagrees: ${bad.join('; ')}`);
  console.log('  ok  read back from Telnyx, both stored\n');

  console.log('One thing left, because the assistant carries its own copies of these URLs:\n');
  console.log('    pnpm assistant:sync\n');
}

main().catch((err: Error) => {
  console.error(`\nrepoint failed: ${err.message}`);
  process.exit(1);
});
